/**
 * Multi-peer / cache-lifecycle coverage for {@link Ax25Listener}.
 * TS port of `tests/Packet.Ax25.Tests/Session/Ax25ListenerMultiPeerTests.cs`.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import { disc, iFrame, sabm } from "../src/frame.js";
import { Ax25Listener, type Ax25ListenerSession } from "../src/listener.js";
import type { DataLinkSignal } from "../src/sdl/action-dispatcher.js";
import { LoopbackTransport, waitFor, withTimeout } from "./listener-test-support.js";

const LocalCall = Callsign.parse("M0LTE");

describe("Ax25Listener — multi-peer & cache lifecycle", () => {
  // ─── Category 2: multi-peer as a node ───────────────────────────────

  it("accepts second peer while first session active", async () => {
    const peerA = Callsign.parse("G7AAA");
    const peerB = Callsign.parse("G7BBB");

    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    const sessions = new Map<string, Ax25ListenerSession>();
    const bothAccepted = new Promise<void>((resolve) => {
      listener.onSessionAccepted((s) => {
        sessions.set(s.context.remote.toString(), s);
        if (sessions.size >= 2) resolve();
      });
    });

    await listener.start();
    transport.injectInbound(sabm({ destination: LocalCall, source: peerA }));
    await waitFor(() => sessions.has(peerA.toString()), 2000);
    await waitFor(() => sessions.get(peerA.toString())!.state === "Connected", 2000);

    transport.injectInbound(sabm({ destination: LocalCall, source: peerB }));
    await withTimeout(bothAccepted, 2000, "bothAccepted");

    const sA = sessions.get(peerA.toString())!;
    const sB = sessions.get(peerB.toString())!;
    expect(sA).not.toBe(sB);
    expect(sA.state).toBe("Connected");
    expect(sB.state).toBe("Connected");

    await listener.dispose();
  });

  it("routes frames to the correct session with multiple peers", async () => {
    const peerA = Callsign.parse("G7AAA");
    const peerB = Callsign.parse("G7BBB");

    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    const sessions = new Map<string, Ax25ListenerSession>();
    const dataFromA: DataLinkSignal[] = [];
    const dataFromB: DataLinkSignal[] = [];
    const bothAccepted = new Promise<void>((resolve) => {
      listener.onSessionAccepted((s) => {
        sessions.set(s.context.remote.toString(), s);
        if (s.context.remote.equals(peerA)) {
          s.onDataLinkSignal((sig) => {
            if (sig.type === "DL_DATA_indication") dataFromA.push(sig);
          });
        } else if (s.context.remote.equals(peerB)) {
          s.onDataLinkSignal((sig) => {
            if (sig.type === "DL_DATA_indication") dataFromB.push(sig);
          });
        }
        if (sessions.size >= 2) resolve();
      });
    });

    await listener.start();
    transport.injectInbound(sabm({ destination: LocalCall, source: peerA }));
    transport.injectInbound(sabm({ destination: LocalCall, source: peerB }));
    await withTimeout(bothAccepted, 2000, "bothAccepted");

    const payloadA = new TextEncoder().encode("HELLO-A");
    transport.injectInbound(
      iFrame({
        destination: LocalCall,
        source: peerA,
        nr: 0,
        ns: 0,
        info: payloadA,
        pollBit: false,
      }),
    );
    await waitFor(() => dataFromA.length > 0, 2000);
    const aData = dataFromA[0]!;
    expect(aData.type).toBe("DL_DATA_indication");
    if (aData.type === "DL_DATA_indication") {
      expect(Array.from(aData.data)).toEqual(Array.from(payloadA));
    }
    expect(dataFromB.length).toBe(0);

    const payloadB = new TextEncoder().encode("HELLO-B");
    transport.injectInbound(
      iFrame({
        destination: LocalCall,
        source: peerB,
        nr: 0,
        ns: 0,
        info: payloadB,
        pollBit: false,
      }),
    );
    await waitFor(() => dataFromB.length > 0, 2000);
    const bData = dataFromB[0]!;
    if (bData.type === "DL_DATA_indication") {
      expect(Array.from(bData.data)).toEqual(Array.from(payloadB));
    }
    expect(dataFromA.length).toBe(1);

    await listener.dispose();
  });

  it("independent V(s) / V(r) / V(a) per peer", async () => {
    const peerA = Callsign.parse("G7AAA");
    const peerB = Callsign.parse("G7BBB");

    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    const sessions = new Map<string, Ax25ListenerSession>();
    const bothAccepted = new Promise<void>((resolve) => {
      listener.onSessionAccepted((s) => {
        sessions.set(s.context.remote.toString(), s);
        if (sessions.size >= 2) resolve();
      });
    });

    await listener.start();
    transport.injectInbound(sabm({ destination: LocalCall, source: peerA }));
    transport.injectInbound(sabm({ destination: LocalCall, source: peerB }));
    await withTimeout(bothAccepted, 2000, "bothAccepted");

    // Peer A sends two I-frames.
    transport.injectInbound(
      iFrame({
        destination: LocalCall,
        source: peerA,
        nr: 0,
        ns: 0,
        info: new Uint8Array([0x41]),
        pollBit: false,
      }),
    );
    transport.injectInbound(
      iFrame({
        destination: LocalCall,
        source: peerA,
        nr: 0,
        ns: 1,
        info: new Uint8Array([0x42]),
        pollBit: false,
      }),
    );

    await waitFor(
      () => sessions.get(peerA.toString())!.context.vr === 2,
      2000,
    );
    expect(sessions.get(peerB.toString())!.context.vr).toBe(0);

    await listener.dispose();
  });

  // ─── Category 3: cache lifecycle ────────────────────────────────────

  it("reuses session across peer reconnects (state preserved)", async () => {
    const peerA = Callsign.parse("G7AAA");
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    const accepted: Ax25ListenerSession[] = [];
    listener.onSessionAccepted((s) => accepted.push(s));

    await listener.start();

    transport.injectInbound(sabm({ destination: LocalCall, source: peerA }));
    await waitFor(() => accepted.length >= 1, 2000);
    const first = accepted[0]!;
    expect(first.state).toBe("Connected");

    // Stash a probe entry on context state the SDL t14 doesn't touch.
    first.context.sentIFrames.set(42, { data: new Uint8Array([0xaa]), pid: 0xf0 });

    transport.injectInbound(disc({ destination: LocalCall, source: peerA }));
    await waitFor(() => first.state === "Disconnected", 2000);

    transport.injectInbound(sabm({ destination: LocalCall, source: peerA }));
    await waitFor(() => accepted.length >= 2, 2000);
    const second = accepted[1]!;
    expect(second).toBe(first);
    expect(second.context.sentIFrames.has(42)).toBe(true);

    await listener.dispose();
  });

  it("evicts oldest peer past maxCachedPeers", async () => {
    const cap = 3;
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, {
      myCall: LocalCall,
      maxCachedPeers: cap,
    });

    // Capture first session instance per peer.
    const firstByPeer = new Map<string, Ax25ListenerSession>();
    listener.onSessionAccepted((s) => {
      const key = s.context.remote.toString();
      if (!firstByPeer.has(key)) firstByPeer.set(key, s);
    });

    await listener.start();

    const peers: Callsign[] = [];
    for (let i = 0; i < cap + 1; i++) {
      peers.push(Callsign.parse(`G7P${i.toString().padStart(2, "0")}`));
    }

    for (const p of peers) {
      transport.injectInbound(sabm({ destination: LocalCall, source: p }));
      await waitFor(() => firstByPeer.has(p.toString()), 2000);
      await waitFor(() => firstByPeer.get(p.toString())!.state === "Connected", 2000);
      transport.injectInbound(disc({ destination: LocalCall, source: p }));
      await waitFor(() => firstByPeer.get(p.toString())!.state === "Disconnected", 2000);
    }

    const oldFirst = firstByPeer.get(peers[0]!.toString())!;
    firstByPeer.delete(peers[0]!.toString());

    transport.injectInbound(sabm({ destination: LocalCall, source: peers[0]! }));
    await waitFor(() => firstByPeer.has(peers[0]!.toString()), 2000);
    const newFirst = firstByPeer.get(peers[0]!.toString())!;
    expect(newFirst).not.toBe(oldFirst);

    await listener.dispose();
  });

  it("evicted peer reconnect builds a fresh session (no state carry-over)", async () => {
    const cap = 2;
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, {
      myCall: LocalCall,
      maxCachedPeers: cap,
    });
    const firstByPeer = new Map<string, Ax25ListenerSession>();
    listener.onSessionAccepted((s) => {
      const key = s.context.remote.toString();
      if (!firstByPeer.has(key)) firstByPeer.set(key, s);
    });

    await listener.start();

    const p0 = Callsign.parse("G7P00");
    const p1 = Callsign.parse("G7P01");
    const p2 = Callsign.parse("G7P02");

    transport.injectInbound(sabm({ destination: LocalCall, source: p0 }));
    await waitFor(() => firstByPeer.has(p0.toString()), 2000);
    const s0Original = firstByPeer.get(p0.toString())!;
    s0Original.context.sentIFrames.set(1, { data: new Uint8Array([0xcc]), pid: 0xf0 });
    transport.injectInbound(disc({ destination: LocalCall, source: p0 }));
    await waitFor(() => s0Original.state === "Disconnected", 2000);

    transport.injectInbound(sabm({ destination: LocalCall, source: p1 }));
    await waitFor(() => firstByPeer.has(p1.toString()), 2000);
    transport.injectInbound(disc({ destination: LocalCall, source: p1 }));
    await waitFor(() => firstByPeer.get(p1.toString())!.state === "Disconnected", 2000);

    transport.injectInbound(sabm({ destination: LocalCall, source: p2 }));
    await waitFor(() => firstByPeer.has(p2.toString()), 2000);

    // p0 should now be evicted (cap=2, oldest is p0). Reconnect.
    firstByPeer.delete(p0.toString());
    transport.injectInbound(sabm({ destination: LocalCall, source: p0 }));
    await waitFor(() => firstByPeer.has(p0.toString()), 2000);
    const s0Fresh = firstByPeer.get(p0.toString())!;
    expect(s0Fresh).not.toBe(s0Original);
    expect(s0Fresh.context.vs).toBe(0);
    expect(s0Fresh.context.vr).toBe(0);
    expect(s0Fresh.context.va).toBe(0);
    expect(s0Fresh.context.sentIFrames.size).toBe(0);

    await listener.dispose();
  });

  it("dispose() releases all cached sessions promptly", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    const sessions: Ax25ListenerSession[] = [];
    const twoAccepted = new Promise<void>((resolve) => {
      listener.onSessionAccepted((s) => {
        sessions.push(s);
        if (sessions.length >= 2) resolve();
      });
    });
    await listener.start();
    transport.injectInbound(
      sabm({ destination: LocalCall, source: Callsign.parse("G7AAA") }),
    );
    transport.injectInbound(
      sabm({ destination: LocalCall, source: Callsign.parse("G7BBB") }),
    );
    await withTimeout(twoAccepted, 2000, "twoAccepted");

    transport.injectInbound(
      disc({ destination: LocalCall, source: Callsign.parse("G7AAA") }),
    );
    transport.injectInbound(
      disc({ destination: LocalCall, source: Callsign.parse("G7BBB") }),
    );

    const start = Date.now();
    await withTimeout(listener.dispose(), 3000, "dispose()");
    expect(Date.now() - start).toBeLessThan(3000);

    // Calling dispose() twice is a no-op.
    await listener.dispose();
  });
});
