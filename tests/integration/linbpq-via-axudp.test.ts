/**
 * Tier 2 (frame-perfect, modem-less) connected-mode interop against the live
 * LinBPQ docker container over **AXUDP** (BPQAXIP-over-UDP).
 *
 * The AXUDP analog of {@link ./linbpq-via-netsim.test.ts} and the parity of the
 * C# `LinbpqViaAxudpConnectedMode` (Direction A + the FCS guard,
 * `tests/Packet.Interop.Tests/Linbpq/LinbpqViaAxudpConnectedMode.cs` in
 * m0lte/packet.net). It asserts the **same** protocol behaviour — `Ax25Stack`
 * reaches Connected after UA, exchanges I-frames (BPQ's banner + a `P\r`
 * ports-command round-trip), then DISC/UA cleanly disconnects — but the frames
 * cross as UDP datagrams through a BPQAXIP tunnel rather than net-sim's
 * software-AFSK channel. AX.25-frames-over-UDP has no audio encode/decode to
 * glitch under CPU contention, so it is **deterministic and load-insensitive**
 * (see docs/plan.md §7.0 for the three-tier model).
 *
 * **Topology.** LinBPQ's BPQAXIP driver binds UDP 8093 (published on the host
 * as `127.0.0.1:8093`). We bind a fixed local UDP port and point the
 * {@link AxudpTransport} at `127.0.0.1:8093`. BPQ's `bpq32.cfg` AXIP port
 * carries `AUTOADDQUIET`, which auto-learns our reply route (call→ip:port) from
 * our inbound SABM — so this dial-OUT direction needs no static MAP. We use a
 * DISTINCT callsign + DISTINCT fixed port from every other AXUDP test
 * (C# and TS) so the shared BPQ daemon tracks an independent link and its
 * AUTOADD cache stays valid across re-runs.
 *
 * **The transport binds all interfaces (not loopback).** BPQ, inside the
 * docker bridge, addresses us at the bridge gateway `172.30.0.1` — its reply
 * datagrams arrive on the host's bridge interface, not `127.0.0.1`. A
 * loopback-only bind would never see them; the default all-interfaces bind
 * does. (Learned the hard way while bringing this test up; the C# `AxudpSocket`
 * binds `IPAddress.Any` for the same reason.)
 *
 * **FCS is MANDATORY on BPQAXIP/UDP** and {@link AxudpTransport} carries it
 * unconditionally (CRC-16/X.25, low byte first, appended on send + stripped /
 * validated on receive — there is no FCS-less mode). Source-verified in
 * `bpqaxip.c`: its UDP receive path drops any datagram whose CRC residue isn't
 * 0xf0b8 ("Invalid CRC"). A successful SABM/UA handshake here is itself the FCS
 * proof — an FCS-less SABM would be silently dropped (no UA, the connect would
 * time out), and BPQ's UA / RR acks would fail to parse if we didn't strip the
 * trailing FCS (the AX.25 parser rejects trailing bytes on a U/S frame). The C#
 * `FcsLess_Sabm_IsDropped_FcsBearing_Sabm_GetsUa` locks the negative case on
 * the wire; here the positive case (FCS-bearing → Connected + acks) carries it.
 *
 * Bring the stack up first:
 *
 *   docker compose -f docker/compose.interop.yml up -d --wait
 *
 * Then run:
 *
 *   npm run test:integration
 *
 * The describe block is gated on `127.0.0.1:8093` (BPQ's AXUDP port) being
 * reachable over UDP — if the stack isn't up, the whole file self-skips, so
 * this is safe to leave wired into CI / local dev.
 */
import { createSocket } from "node:dgram";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AxudpTransport } from "../../src/axudp-transport.js";
import { Callsign } from "../../src/callsign.js";
import { Ax25Stack } from "../../src/session.js";

const HOST = "127.0.0.1";
const BPQ_AXUDP_PORT = 8093; // BPQAXIP/UDP listener (published)

// Direction A (we dial out): AUTOADDQUIET gives BPQ our reply route, so no
// static MAP is needed. A distinct callsign + distinct fixed port keeps this
// link independent of the C# AXUDP tests + the TS NODES-ingest test, and the
// fixed port keeps BPQ's AUTOADD cache valid across re-runs.
const OUR_CALL = "PNTSCX-1";
const BPQ_CALL = "PN0TST";
const PDN_LOCAL_PORT = 8197;

/**
 * Probe BPQ's AXUDP port. UDP has no connect handshake, so we send one
 * datagram and treat "no ICMP-unreachable error within a short window" as
 * reachable. A bound socket on a Linux host surfaces a refused UDP port as a
 * later `ECONNREFUSED` error event; if none arrives, assume the stack is up.
 * (Belt + braces: the connected-mode tests themselves also fail fast if BPQ
 * isn't actually there.)
 */
async function axudpReachable(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createSocket("udp4");
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // best-effort
      }
      resolve(ok);
    };
    socket.on("error", () => finish(false));
    try {
      socket.bind(0, () => {
        // A 1-byte probe; if BPQ's port is closed the host returns ICMP
        // port-unreachable → an `error` event shortly after. Reachable
        // otherwise.
        socket.send(new Uint8Array([0x00]), BPQ_AXUDP_PORT, HOST, (err) => {
          if (err) finish(false);
        });
        setTimeout(() => finish(true), 250);
      });
    } catch {
      finish(false);
    }
  });
}

const stackReachable = await axudpReachable();

describe.skipIf(!stackReachable)(
  "ax25.ts via AxudpTransport against LinBPQ over BPQAXIP/UDP",
  () => {
    let stack: Ax25Stack | null = null;
    let transport: AxudpTransport | null = null;

    beforeEach(() => {
      // Bind all interfaces (NOT loopback) — BPQ replies via the bridge
      // gateway 172.30.0.1; a 127.0.0.1-only bind would miss them.
      transport = new AxudpTransport(HOST, BPQ_AXUDP_PORT, {
        localPort: PDN_LOCAL_PORT,
      });
      stack = new Ax25Stack(transport);
    });

    afterEach(async () => {
      try {
        await stack?.stop();
      } catch {
        // best-effort — already-disconnected, etc.
      }
      stack = null;
      transport = null;
    });

    it(
      "Connect_Then_Disconnect_Against_Linbpq_Over_Axudp",
      async () => {
        await stack!.start();

        const from = Callsign.parse(OUR_CALL);
        const to = Callsign.parse(BPQ_CALL);

        // connect() only resolves on the SABM/UA handshake completing — so
        // reaching here proves the SABM crossed the AXUDP+FCS tunnel and BPQ's
        // UA (FCS-bearing) was parsed (its FCS stripped + validated).
        const session = await stack!.connect({ from, to });
        expect(session.from.toString()).toBe(OUR_CALL);
        expect(session.to.toString()).toBe(BPQ_CALL);

        await session.disconnect();
      },
      // A reliable UDP tunnel — no channel loss / half-duplex — so this is far
      // tighter than the net-sim version's 30 s. 15 s is generous-but-bounded.
      15_000,
    );

    // The AXUDP analog of the net-sim IFrame_RoundTrip: BPQ's CTEXT banner
    // arrives as I-frame(s) after UA, then `P\r` (the Ports command) round-trips
    // a response. Exercises the full I-frame send/receive + BPQ's RR S-frame
    // acks over the tunnel (an unstripped FCS tail would make those acks
    // unparseable — the whole reason AXUDP strips the FCS on receive).
    it(
      "IFrame_RoundTrip_Against_Linbpq_Node_Prompt_Over_Axudp",
      async () => {
        await stack!.start();

        const from = Callsign.parse(OUR_CALL);
        const to = Callsign.parse(BPQ_CALL);

        const session = await stack!.connect({ from, to });

        const dataAwaiter = new ChunkAwaiter();
        session.onData((chunk) => dataAwaiter.push(chunk));

        // BPQ sends its CTEXT banner as I-frame(s) right after UA.
        const banner = await dataAwaiter.waitForNext(12_000);
        expect(banner.length).toBeGreaterThan(0);

        // Drain follow-up banner frames so they don't surface as a false match
        // for the command response.
        await new Promise((r) => setTimeout(r, 750));
        dataAwaiter.drain();

        // `P\r` = Ports command: short, deterministically non-empty, no side
        // effects on BPQ state.
        await session.write(new TextEncoder().encode("P\r"));
        const response = await dataAwaiter.waitForNext(12_000);
        expect(response.length).toBeGreaterThan(0);
        // BPQ's ports list names its AXIP port — a real request/response
        // round-trip over the AXUDP tunnel.
        expect(new TextDecoder().decode(response)).toMatch(/Ports|AXIP/i);

        await session.disconnect();
      },
      20_000,
    );
  },
);

/**
 * Bounded queue + one-shot "wait for next" promise — the data listener pushes
 * chunks; the test pulls one at a time with a budget. (Same shape as the
 * net-sim test's `ChunkAwaiter`.)
 */
class ChunkAwaiter {
  private readonly queue: Uint8Array[] = [];
  private resolver: ((chunk: Uint8Array) => void) | null = null;

  push(chunk: Uint8Array): void {
    if (this.resolver) {
      const r = this.resolver;
      this.resolver = null;
      r(chunk);
      return;
    }
    this.queue.push(chunk);
  }

  drain(): void {
    this.queue.length = 0;
  }

  async waitForNext(budgetMs: number): Promise<Uint8Array> {
    const queued = this.queue.shift();
    if (queued) return queued;
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.resolver = null;
        reject(new Error(`no chunk received within ${budgetMs}ms`));
      }, budgetMs);
      this.resolver = (chunk) => {
        clearTimeout(timer);
        resolve(chunk);
      };
    });
  }
}
