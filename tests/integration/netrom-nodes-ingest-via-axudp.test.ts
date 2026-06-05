/**
 * Tier 2 (frame-perfect, modem-less) read-only NET/ROM NODES-ingest interop
 * against the live LinBPQ docker container over **AXUDP** (BPQAXIP-over-UDP).
 *
 * The AXUDP analog of {@link ./netrom-nodes-ingest-via-netsim.test.ts} and the
 * parity of the C# `NetRomNodesIngestViaAxudp`
 * (`tests/Packet.Interop.Tests/Linbpq/NetRomNodesIngestViaAxudp.cs` in
 * m0lte/packet.net). It asserts the **same** protocol behaviour — the TS
 * `@packet-net/ax25` netrom module ingests real LinBPQ's on-the-wire NODES
 * broadcast and learns it as a directly-heard neighbour with an assumed direct
 * route — but over a BPQAXIP/UDP tunnel rather than net-sim's software-AFSK
 * channel, so it is deterministic and load-insensitive (lands in ~1 s vs the
 * net-sim version's 90 s channel-loss budget). See docs/plan.md §7.0.
 *
 * The production pipeline under test: a real {@link Ax25Listener} attached to
 * an {@link AxudpTransport} (BPQAXIP/UDP, bound to a fixed host port pointed at
 * BPQ's `127.0.0.1:8093`) → its frame-trace tap → {@link NetRomService} →
 * routing snapshot. The netrom module **transmits nothing** — it is a pure
 * consumer of the trace tap.
 *
 * **Getting BPQ to deliver NODES over a point-to-point AXIP port (the enabling
 * finding, source-verified in `bpqaxip.c` + proven on the wire).** Three things
 * must hold (all verified bringing this test up; the headline `bpqaxip.c`
 * finding is documented in the C# test + docs/plan.md §7.1):
 *
 *   1. **A `B`-flagged static MAP** for our callsign on BPQ's AXIP port
 *      (`docker/linbpq/bpq32.cfg`: `MAP PNTSAX-1 172.30.0.1 UDP 8196 B` +
 *      `BROADCAST NODES`). A NODES UI frame is addressed to the pseudo-call
 *      `NODES`, which matches no per-station MAP, so a stock point-to-point
 *      AXIP port silently drops its own NODES; the `B` (broadcast-recipient)
 *      flag is what makes BPQ deliver NODES to us. (The AXUDP counterpart of
 *      the net-sim port's `QUALITY=192`.)
 *   2. **We must warm BPQ first.** Even with the `B`-flagged MAP, BPQ delivers
 *      NODES only once it treats us as a live NET/ROM neighbour — i.e. once it
 *      has *heard our own NODES broadcast* on the port (it then sets up the
 *      reciprocal NODES delivery; verified: a purely passive listener that
 *      never transmits hears nothing). The C# test runs a full broadcasting
 *      `NetRomService` for this; the TS netrom module is read-only, so this
 *      test sends a minimal warming NODES broadcast through the **same shared
 *      `AxudpTransport`** the listener uses (the transport is the seam — its
 *      `send()` is exactly what a transmitting netrom layer would call).
 *   3. **Bind all interfaces (NOT loopback).** BPQ, inside the docker bridge,
 *      addresses us at the bridge gateway `172.30.0.1`; its reply datagrams
 *      arrive on the host's bridge interface, not `127.0.0.1`. A loopback-only
 *      bind would never see them. (The C# `AxudpSocket` binds `IPAddress.Any`
 *      for the same reason.)
 *
 * **LinBPQ — provoked.** BPQ advertises NODES out a port only when that port
 * has a non-zero QUALITY (the fixture's AXIP port has `QUALITY=200`). We force
 * an *immediate* broadcast with the sysop `SENDNODES` command, after
 * authenticating with BPQ's real positional-challenge `PASSWORD` handshake —
 * the same `BpqSysop` driver the net-sim test ports. We authenticate as the
 * deliberately *non-sysop* telnet user `netop` so the genuine challenge runs.
 *
 * Hearing BPQ's NODES makes the service record it as a directly-heard
 * neighbour (with BPQ's advertised alias) carrying the assumed default-port
 * path quality, plus an assumed direct route to it (canonical processing
 * heuristics 3 + 4) — genuine cross-implementation evidence that the TS netrom
 * module parses a real NET/ROM node's on-the-wire broadcast over AXUDP and
 * builds routing state from it.
 *
 * A DISTINCT callsign (`PNTSAX-1`) + DISTINCT fixed port (8196) from every C#
 * AXUDP test and the TS connected-mode test keeps the shared BPQ daemon from
 * confusing our link/route with another suite's (both run in interop.yml's
 * phase B against the same fixture).
 *
 * Bring the stack up first:
 *
 *   docker compose -f docker/compose.interop.yml up -d --wait
 *
 * Then run:
 *
 *   npm run test:integration
 *
 * The describe block self-skips when BPQ's telnet port (8010) is unreachable.
 */
import { Socket, createConnection } from "node:net";
import { describe, expect, it } from "vitest";
import { writeAddress } from "../../src/address.js";
import { Callsign } from "../../src/callsign.js";
import { encodeFrame, PID_NET_ROM, ui } from "../../src/frame.js";
import { Ax25Listener } from "../../src/listener.js";
import { AxudpTransport } from "../../src/axudp-transport.js";
import {
  NETROM_ALIAS_LENGTH,
  NETROM_SHIFTED_LENGTH,
  NetRomService,
} from "../../src/netrom/index.js";

const HOST = "127.0.0.1";
const BPQ_AXUDP_PORT = 8093; // BPQAXIP/UDP listener (published)
const BPQ_TELNET_PORT = 8010; // LinBPQ node prompt

const OUR_CALL = "PNTSAX-1"; // matches `MAP PNTSAX-1 … 8196 B` in bpq32.cfg
const OUR_ALIAS = "PNTSA";
const PDN_LOCAL_PORT = 8196; // the static-MAP target port
const BPQ_CALL = "PN0TST";
const BPQ_ALIAS = "PNTST";

// The configured sysop password text (docker/linbpq/bpq32.cfg PASSWORD=).
// BPQ uppercases it, so the challenge solves against this exact string.
const BPQ_PASSWORD_TEXT = "WONTLISTEN";

// A reliable UDP tunnel — no channel loss / half-duplex — so the budget is far
// tighter than the net-sim version's 90 s. Generous-but-bounded so a genuinely
// deaf BPQ fails rather than hangs.
const HEAR_BPQ_BUDGET_MS = 45_000;
const RESEND_EVERY_MS = 8_000;
const WARM_EVERY_MS = 2_000;

/** Probe BPQ's telnet port — if it answers, the docker stack is up. */
async function bpqTelnetReachable(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let socket: Socket | null = null;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        // best-effort
      }
      resolve(ok);
    };
    try {
      socket = createConnection({ host: HOST, port: BPQ_TELNET_PORT });
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      setTimeout(() => finish(false), 250);
    } catch {
      finish(false);
    }
  });
}

const stackReachable = await bpqTelnetReachable();

describe.skipIf(!stackReachable)(
  "netrom: read-only NODES ingest against LinBPQ over AXUDP (Tier 2, frame-perfect)",
  () => {
    it(
      "hears real LinBPQ's NODES broadcast over the BPQAXIP/UDP tunnel and learns it as a neighbour",
      async () => {
        // Bind all interfaces (NOT loopback) — BPQ replies via the bridge
        // gateway 172.30.0.1.
        const transport = new AxudpTransport(HOST, BPQ_AXUDP_PORT, {
          localPort: PDN_LOCAL_PORT,
        });

        // The production pipeline: a real listener on the AXUDP tunnel + the
        // read-only NET/ROM service tap. The listener answers BPQ's interlink
        // SABM (part of how BPQ decides we're a live neighbour worth NODESing);
        // the netrom service never transmits.
        const listener = new Ax25Listener(transport, { myCall: OUR_CALL });
        const netRom = new NetRomService({ enabled: true });
        netRom.attachPort("axudp", OUR_CALL, listener);

        // Warming NODES broadcast through the SHARED transport (the netrom
        // module is read-only, so the test plays the part a transmitting
        // netrom layer would: it sends our own NODES so BPQ treats us as a
        // live neighbour and reciprocates). One self-advertising entry is
        // enough to register us in BPQ's routing table.
        const ourNodes = encodeFrame(
          ui({
            destination: Callsign.parse("NODES"),
            source: Callsign.parse(OUR_CALL),
            pid: PID_NET_ROM,
            info: buildNodesBroadcast(OUR_ALIAS, OUR_CALL, OUR_ALIAS, OUR_CALL, 200),
          }),
        );

        let warming = true;
        const warmLoop = (async () => {
          while (warming) {
            try {
              await transport.send(ourNodes);
            } catch {
              // best-effort — a transient send error must not sink the test
            }
            await delay(WARM_EVERY_MS);
          }
        })();

        try {
          await listener.start();

          const heardBpq = await provokeAndHearBpq(netRom);

          dumpSnapshot(netRom, "after BPQ provoke (AXUDP)");

          expect(
            heardBpq,
            "the TS netrom module must hear LinBPQ's NODES broadcast (PN0TST) over the AXUDP tunnel after the PASSWORD->SENDNODES sysop handshake forces one — BPQ delivers NODES to our `B`-flagged AXIP MAP once we've warmed it with our own NODES",
          ).toBe(true);

          const bpq = netRom
            .snapshot()
            .neighbours.find((n) => callMatches(n.neighbour, BPQ_CALL));
          expect(
            bpq,
            "the TS netrom module should learn LinBPQ (PN0TST) as a directly-heard neighbour from its NODES",
          ).toBeDefined();
          expect(
            bpq!.alias,
            "the neighbour entry carries LinBPQ's advertised alias",
          ).toBe(BPQ_ALIAS);
          expect(bpq!.portId).toBe("axudp");
          expect(
            netRom
              .snapshot()
              .destinations.some((d) => callMatches(d.destination, BPQ_CALL)),
            "an assumed direct route to LinBPQ is built (canonical heuristic 4) — same as the net-sim tier, minus the audio",
          ).toBe(true);
        } finally {
          warming = false;
          await warmLoop.catch(() => {
            // best-effort
          });
          netRom.dispose();
          await listener.stop().catch(() => {
            // best-effort — already-stopped, etc.
          });
        }
      },
      HEAR_BPQ_BUDGET_MS + 30_000,
    );
  },
);

/**
 * Build a minimal NET/ROM NODES-broadcast information field: the 0xFF
 * signature, the sender's 6-char alias, then one 21-octet destination entry.
 *
 * The TS netrom module is parse-only by design (it never originates NODES), so
 * this lives in the test — it is the inverse of `parseNodesBroadcast`, used
 * solely to *warm* BPQ (make it treat us as a live neighbour so it reciprocates
 * its own NODES, which is what we actually assert on). Layout per the canonical
 * NET/ROM appendix (see `src/netrom/nodes-broadcast.ts`):
 *
 *   [1]  0xFF signature
 *   [6]  sender alias (space-padded ASCII, no SSID)
 *   then one entry: [7] dest callsign | [6] dest alias | [7] best neighbour | [1] quality
 */
function buildNodesBroadcast(
  senderAlias: string,
  destCall: string,
  destAlias: string,
  bestNeighbour: string,
  quality: number,
): Uint8Array {
  const alias = (s: string): Uint8Array => {
    const b = new Uint8Array(NETROM_ALIAS_LENGTH).fill(0x20);
    for (let i = 0; i < Math.min(NETROM_ALIAS_LENGTH, s.length); i++) {
      b[i] = s.charCodeAt(i);
    }
    return b;
  };
  const shifted = (call: string): Uint8Array => {
    const b = new Uint8Array(NETROM_SHIFTED_LENGTH);
    writeAddress(b, 0, {
      callsign: Callsign.parse(call),
      commandOrHasBeenRepeated: false,
      last: true,
    });
    return b;
  };
  const entryLen = NETROM_SHIFTED_LENGTH + NETROM_ALIAS_LENGTH + NETROM_SHIFTED_LENGTH + 1;
  const info = new Uint8Array(1 + NETROM_ALIAS_LENGTH + entryLen);
  let o = 0;
  info[o++] = 0xff; // signature
  info.set(alias(senderAlias), o);
  o += NETROM_ALIAS_LENGTH;
  info.set(shifted(destCall), o);
  o += NETROM_SHIFTED_LENGTH;
  info.set(alias(destAlias), o);
  o += NETROM_ALIAS_LENGTH;
  info.set(shifted(bestNeighbour), o);
  o += NETROM_SHIFTED_LENGTH;
  info[o] = quality & 0xff;
  return info;
}

/** Case-insensitive base+SSID match against a `"BASE-SSID"` (or bare `"BASE"`) string. */
function callMatches(actual: Callsign, expected: string): boolean {
  return actual.toString().toUpperCase() === Callsign.parse(expected).toString().toUpperCase();
}

function dumpSnapshot(netRom: NetRomService, when: string): void {
  const snap = netRom.snapshot();
  // eslint-disable-next-line no-console
  console.log(
    `[${when}] ${snap.neighbours.length} neighbour(s), ${snap.destinations.length} destination(s):`,
  );
  for (const n of snap.neighbours) {
    // eslint-disable-next-line no-console
    console.log(
      `  neighbour ${n.alias}:${n.neighbour.toString()} port=${n.portId} qual=${n.pathQuality}`,
    );
  }
}

/**
 * Force an immediate NODES broadcast from LinBPQ via the real
 * positional-challenge `PASSWORD` → `SENDNODES` sysop handshake, then wait
 * (bounded) for the service to ingest the resulting `PN0TST` NODES. Re-triggers
 * `SENDNODES` on a short cadence inside the budget for resilience. Mirrors the
 * net-sim test's `provokeAndHearBpq` / the C# `ProvokeAndHearBpqAsync`.
 */
async function provokeAndHearBpq(netRom: NetRomService): Promise<boolean> {
  const deadline = Date.now() + HEAR_BPQ_BUDGET_MS;
  let nextResend = 0; // trigger immediately on entry

  const heard = (): boolean =>
    netRom.snapshot().neighbours.some((n) => callMatches(n.neighbour, BPQ_CALL));

  while (Date.now() < deadline) {
    if (heard()) return true;

    if (Date.now() >= nextResend) {
      try {
        await bpqSendNodes(HOST, BPQ_TELNET_PORT, "netop", "netop", BPQ_PASSWORD_TEXT);
      } catch (err) {
        // A transient telnet hiccup must not sink the test — log and retry.
        // eslint-disable-next-line no-console
        console.log(
          `SENDNODES trigger failed (will retry): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      nextResend = Date.now() + RESEND_EVERY_MS;
    }

    await delay(250);
  }

  return heard();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Minimal IAC-aware telnet driver for LinBPQ's node prompt ──────────────
// Direct port of the net-sim test's driver (itself the C# `BpqSysop`): log in
// as a non-sysop user → `PASSWORD` (bare) → five 1-based positions → answer
// `PASSWORD <chars-at-those-positions>` → `Ok` → `SENDNODES` → `Ok` + an
// immediate NODES broadcast on every non-zero-QUALITY port.

const IAC = 255,
  DONT = 254,
  DO = 253,
  WONT = 252,
  WILL = 251;

async function bpqSendNodes(
  host: string,
  port: number,
  user: string,
  pass: string,
  passwordText: string,
): Promise<void> {
  const conn = await openTelnet(host, port);
  try {
    await conn.readUntil("user", 8_000);
    await conn.sendLine(user);
    await conn.readUntil("password", 8_000);
    await conn.sendLine(pass);
    await conn.readUntil("Telnet Server", 8_000);

    await conn.sendLine("PASSWORD");
    const challenge = await conn.readLineAfterPrompt(6_000);
    const positions = parsePositions(challenge);
    const answer = solveChallenge(positions, passwordText);
    // eslint-disable-next-line no-console
    console.log(`BPQ PASSWORD challenge ${positions.join(" ")} -> answer ${answer}`);

    await conn.sendLine("PASSWORD " + answer);
    const authResp = await conn.readLineAfterPrompt(6_000);
    if (!authResp.includes("Ok")) {
      throw new Error(`BPQ rejected the PASSWORD challenge answer: ${authResp.trim()}`);
    }

    await conn.sendLine("SENDNODES");
    const sendResp = await conn.readLineAfterPrompt(6_000);
    if (!sendResp.includes("Ok") || sendResp.includes("SYSOP")) {
      throw new Error(`BPQ did not accept SENDNODES: ${sendResp.trim()}`);
    }

    await delay(300);
  } finally {
    conn.close();
  }
}

function parsePositions(challenge: string): number[] {
  const nums = (challenge.match(/\d+/g) ?? []).map((s) => Number.parseInt(s, 10));
  if (nums.length < 5) {
    throw new Error(`Could not parse 5 challenge positions from: ${challenge.trim()}`);
  }
  return nums.slice(-5);
}

function solveChallenge(positions: number[], passwordText: string): string {
  let answer = "";
  for (const p of positions) {
    const idx = Math.min(Math.max(p - 1, 0), passwordText.length - 1);
    answer += passwordText[idx];
  }
  return answer;
}

interface TelnetConn {
  sendLine(line: string): Promise<void>;
  readUntil(needle: string, budgetMs: number): Promise<string>;
  readLineAfterPrompt(budgetMs: number): Promise<string>;
  close(): void;
}

async function openTelnet(host: string, port: number): Promise<TelnetConn> {
  const socket: Socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection({ host, port });
    const onErr = (e: Error) => {
      s.off("connect", onOk);
      reject(e);
    };
    const onOk = () => {
      s.off("error", onErr);
      resolve(s);
    };
    s.once("connect", onOk);
    s.once("error", onErr);
  });

  let decoded = "";
  socket.on("data", (chunk: Buffer) => {
    decoded += appendStripIac(socket, chunk);
  });
  socket.on("error", () => {
    // swallowed — reads time out and surface as their own errors
  });

  const readMatching = async (
    stop: (buf: string) => boolean,
    budgetMs: number,
  ): Promise<string> => {
    const deadline = Date.now() + budgetMs;
    const startLen = decoded.length;
    while (Date.now() < deadline) {
      const slice = decoded.slice(startLen);
      if (stop(slice)) return slice;
      await delay(50);
    }
    return decoded.slice(startLen);
  };

  return {
    async sendLine(line: string): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        socket.write(Buffer.from(line + "\r", "ascii"), (err) =>
          err ? reject(err) : resolve(),
        );
      });
    },
    readUntil(needle: string, budgetMs: number): Promise<string> {
      return readMatching((buf) => needle.length > 0 && buf.includes(needle), budgetMs);
    },
    readLineAfterPrompt(budgetMs: number): Promise<string> {
      return readMatching((buf) => buf.includes("\n"), budgetMs);
    },
    close(): void {
      try {
        socket.destroy();
      } catch {
        // best-effort
      }
    },
  };
}

function appendStripIac(socket: Socket, buf: Buffer): string {
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== IAC) {
      out += String.fromCharCode(buf[i]!);
      continue;
    }
    if (i + 2 >= buf.length) break;
    const verb = buf[i + 1]!;
    const opt = buf[i + 2]!;
    i += 2;
    const reply = verb === DO ? WONT : verb === WILL ? DONT : 0;
    if (reply !== 0) {
      try {
        socket.write(Buffer.from([IAC, reply, opt]));
      } catch {
        // best-effort
      }
    }
  }
  return out;
}
