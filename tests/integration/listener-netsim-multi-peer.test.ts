/**
 * Multi-peer interop driven through {@link Ax25Listener}, exercising the
 * per-peer session cache + multi-session routing across the live net-sim
 * AFSK1200 channel. TS port of
 * `tests/Packet.Interop.Tests/Netsim/NetsimListenerMultiPeerScenarios.cs`.
 *
 * Topology: net-sim node `a` on KISS-TCP 8100 runs an `Ax25Listener` under
 * test; node `b` on 8101 hosts two peer listeners that initiate against
 * the listener-under-test from distinct callsigns. The AFSK1200 sim
 * carries SABM in both directions; SessionAccepted fires twice on the
 * listener-under-test (once per peer), and the cached sessions are
 * distinct.
 *
 * **Tier 3 — modem/channel-dependent, kept on net-sim (docs/plan.md §7.0).**
 * Unlike the connected-mode / NODES-ingest protocol tests, this one does NOT
 * shift left onto AXUDP. The *demux assertion itself* (distinct cached sessions
 * keyed by source callsign, frames routed to the right session) is already
 * covered deterministically in-process at Tier 1 (`Ax25ListenerMultiPeerTests`,
 * mirrored TS-side in the unit suite). What this interop test uniquely adds is
 * the **multiple-stations-on-one-shared-half-duplex-channel** reality: two peer
 * stations transmit toward one listener over net-sim's single FM-capture
 * AFSK1200 bus (`collision_mode: silence` — concurrent TX silences both), and
 * the listener must demux them off that contended channel — including the
 * second test, where an inbound accept and an outbound dial contend for the one
 * half-duplex channel at once. AXUDP's transport is strictly point-to-point
 * (one fixed UDP remote, no third-party / broadcast delivery; see
 * `src/axudp-transport.ts`), so it *cannot* reproduce a multi-station shared
 * channel — an AXUDP variant would add zero coverage over the Tier-1 demux
 * tests while needing either the (already-skipped, #153) BPQ-originates-inbound
 * path or BPQ L2-bridging between AXIP MAPs (which would change the subject from
 * L2 demux to NET/ROM routing). So this legitimately STAYS Tier 3.
 *
 * Being Tier 3, it rides net-sim's load-sensitive software modem and is subject
 * to the §7.1 "environmentally flaky, non-blocking, re-run a lone red in
 * isolation" caveat (a CPU glitch / shared-channel contention from a sibling
 * net-sim test → a slow demod → a slow handshake). The `waitUntil` budgets
 * below are sized to match the C# sibling's proven Tier-3 budgets (30 s) so the
 * contended-channel case has margin; `waitUntil` returns as soon as the
 * predicate holds, so a generous budget costs nothing on a quiet host (where
 * each leg settles in a few seconds).
 *
 * Bring the stack up first:
 *
 *   docker compose -f docker/compose.interop.yml up -d --wait
 *
 * Then run:
 *
 *   npm run test:integration
 *
 * The describe block self-skips if `127.0.0.1:8100` isn't reachable.
 */
import { Socket, createConnection } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import {
  Ax25Listener,
  type Ax25ListenerSession,
} from "../../src/listener.js";
import { TcpKissTransport } from "../../src/tcp-transport.js";

const HOST = "127.0.0.1";
const LISTENER_PORT = 8100;
const PEER_PORT = 8101;

// Tier-3 budgets, matched to the C# sibling `NetsimListenerMultiPeerScenarios`
// (30 s connect / 30 s disconnect). The earlier 10 s / 20 s budgets were too
// tight for the contended shared-AFSK channel (a sibling net-sim test +
// CPU load can push a single handshake past 20 s — the #312 line-217 flake).
// `waitUntil` returns as soon as the predicate holds, so the headroom is free
// on a quiet host. The per-test `it` budget below is raised to be a superset of
// the summed sub-budgets.
const STATE_SETTLE_BUDGET_MS = 30_000; // listener-side reaches Connected
const DISCONNECT_BUDGET_MS = 30_000; // session returns to Disconnected

async function netsimReachable(): Promise<boolean> {
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
      socket = createConnection({ host: HOST, port: LISTENER_PORT });
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      setTimeout(() => finish(false), 200);
    } catch {
      finish(false);
    }
  });
}

const stackReachable = await netsimReachable();

describe.skipIf(!stackReachable)(
  "Ax25Listener via TcpKissTransport across net-sim AFSK1200",
  () => {
    const open: Array<() => Promise<void>> = [];

    beforeEach(() => {
      open.length = 0;
    });

    afterEach(async () => {
      for (const close of open.reverse()) {
        try {
          await close();
        } catch {
          // best-effort
        }
      }
    });

    it(
      "two-peer multi-session: both peers connect, distinct sessions cached",
      async () => {
        // Distinct callsigns per peer; same socket on node b (it shares
        // an afsk1200 channel — net-sim broadcasts to every linked node).
        const listenerCall = Callsign.parse("TSLSTN");
        const peer1Call = Callsign.parse("TSPEER-1");
        const peer2Call = Callsign.parse("TSPEER-2");

        const kissListener = new TcpKissTransport(HOST, LISTENER_PORT, { kissPort: 0 });
        const kissPeer1 = new TcpKissTransport(HOST, PEER_PORT, { kissPort: 0 });
        const kissPeer2 = new TcpKissTransport(HOST, PEER_PORT, { kissPort: 0 });

        const listener = new Ax25Listener(kissListener, { myCall: listenerCall });
        const peer1Listener = new Ax25Listener(kissPeer1, { myCall: peer1Call });
        const peer2Listener = new Ax25Listener(kissPeer2, { myCall: peer2Call });

        open.push(() => listener.dispose());
        open.push(() => peer1Listener.dispose());
        open.push(() => peer2Listener.dispose());

        const acceptedFromPeer1Promise = new Promise<Ax25ListenerSession>((resolve) => {
          listener.onSessionAccepted((s) => {
            if (s.context.remote.equals(peer1Call)) resolve(s);
          });
        });
        const acceptedFromPeer2Promise = new Promise<Ax25ListenerSession>((resolve) => {
          listener.onSessionAccepted((s) => {
            if (s.context.remote.equals(peer2Call)) resolve(s);
          });
        });

        await listener.start();
        await peer1Listener.start();
        await peer2Listener.start();

        // Settle so all three pumps are subscribed before SABM flies.
        await new Promise((r) => setTimeout(r, 300));

        // ─── Peer 1 connects ────────────────────────────────────────
        const sessionFromPeer1 = await peer1Listener.connect(listenerCall);
        expect(sessionFromPeer1.state).toBe("Connected");
        const listenerSidePeer1 = await acceptedFromPeer1Promise;
        await waitUntil(() => listenerSidePeer1.state === "Connected", STATE_SETTLE_BUDGET_MS);

        // ─── Peer 2 connects ────────────────────────────────────────
        const sessionFromPeer2 = await peer2Listener.connect(listenerCall);
        expect(sessionFromPeer2.state).toBe("Connected");
        const listenerSidePeer2 = await acceptedFromPeer2Promise;
        await waitUntil(() => listenerSidePeer2.state === "Connected", STATE_SETTLE_BUDGET_MS);

        expect(listenerSidePeer1).not.toBe(listenerSidePeer2);

        // ─── Clean disconnect on both ───────────────────────────────
        sessionFromPeer1.postEvent({ name: "DL_DISCONNECT_request" });
        sessionFromPeer2.postEvent({ name: "DL_DISCONNECT_request" });
        await waitUntil(() => sessionFromPeer1.state === "Disconnected", DISCONNECT_BUDGET_MS);
        await waitUntil(() => sessionFromPeer2.state === "Disconnected", DISCONNECT_BUDGET_MS);
      },
      // Superset of the summed 30 s waitUntil sub-budgets above (cf. the C#
      // sibling's ~105 s overall). Only the pathological contended case
      // approaches it; a quiet run finishes in well under 15 s.
      120_000,
    );

    it(
      "listener accepts inbound + initiates outbound concurrently",
      async () => {
        // The listener-under-test serves as both an inbound accept and an
        // outbound dialler simultaneously. A second peer-listener on node
        // b dials in; concurrently the listener-under-test connects to a
        // third callsign on node b.
        const listenerCall = Callsign.parse("TSDUAL");
        const inboundPeerCall = Callsign.parse("TSINBD-1");
        const outboundPeerCall = Callsign.parse("TSOUTB-2");

        const kissListener = new TcpKissTransport(HOST, LISTENER_PORT, { kissPort: 0 });
        const kissInbound = new TcpKissTransport(HOST, PEER_PORT, { kissPort: 0 });
        const kissOutbound = new TcpKissTransport(HOST, PEER_PORT, { kissPort: 0 });

        const listener = new Ax25Listener(kissListener, { myCall: listenerCall });
        const inboundPeerListener = new Ax25Listener(kissInbound, { myCall: inboundPeerCall });
        // The outbound peer is also a listener under its own callsign so
        // it accepts the connect we initiate.
        const outboundPeerListener = new Ax25Listener(kissOutbound, { myCall: outboundPeerCall });

        open.push(() => listener.dispose());
        open.push(() => inboundPeerListener.dispose());
        open.push(() => outboundPeerListener.dispose());

        const acceptedFromInbound = new Promise<Ax25ListenerSession>((resolve) => {
          listener.onSessionAccepted((s) => {
            if (s.context.remote.equals(inboundPeerCall)) resolve(s);
          });
        });

        await listener.start();
        await inboundPeerListener.start();
        await outboundPeerListener.start();

        await new Promise((r) => setTimeout(r, 300));

        // Kick off the outbound connect — fires SABM toward outboundPeer.
        const outboundConnect = listener.connect(outboundPeerCall);

        // Inbound peer SABMs us. The listener must dispatch both
        // concurrently — the cached entry for outbound is mid-handshake.
        const inboundConnect = inboundPeerListener.connect(listenerCall);

        const outboundSession = await outboundConnect;
        const inboundSession = await inboundConnect;
        const listenerSideInbound = await acceptedFromInbound;

        expect(outboundSession.state).toBe("Connected");
        expect(inboundSession.state).toBe("Connected");
        await waitUntil(() => listenerSideInbound.state === "Connected", STATE_SETTLE_BUDGET_MS);

        // Cached sessions on the listener-under-test must be distinct.
        expect(outboundSession).not.toBe(listenerSideInbound);

        // Clean teardown.
        outboundSession.postEvent({ name: "DL_DISCONNECT_request" });
        inboundSession.postEvent({ name: "DL_DISCONNECT_request" });
        await waitUntil(() => outboundSession.state === "Disconnected", DISCONNECT_BUDGET_MS);
        await waitUntil(() => inboundSession.state === "Disconnected", DISCONNECT_BUDGET_MS);
      },
      // Superset of the summed 30 s waitUntil sub-budgets above (cf. the C#
      // sibling's ~105 s overall). Only the pathological contended case
      // approaches it; a quiet run finishes in well under 15 s.
      120_000,
    );
  },
);

async function waitUntil(condition: () => boolean, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition not met within ${budgetMs}ms`);
}
