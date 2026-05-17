/**
 * Baseline unit tests for {@link Ax25Listener} — TS port of
 * `tests/Packet.Ax25.Tests/Session/Ax25ListenerTests.cs`. Each test wires
 * a {@link LoopbackTransport} in place of a real KISS modem so the test
 * owns both ends of the wire. Inbound SABM/UA/DISC sequences are injected
 * by writing the bytes the peer would send.
 *
 * Sibling files cover concurrency / hostile handlers, multi-peer + cache
 * lifecycle, and reject + spec edge cases.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import {
  type Ax25Frame,
  classify,
  disc,
  sabm,
} from "../src/frame.js";
import { Ax25Listener, type Ax25ListenerSession } from "../src/listener.js";
import { LoopbackTransport, waitFor, withTimeout } from "./listener-test-support.js";

const LocalCall = Callsign.parse("M0LTE");
const PeerCallA = Callsign.parse("G7XYZ-7");
const PeerCallB = Callsign.parse("M5ABC-3");

describe("Ax25Listener — baseline", () => {
  it("accepts inbound SABM and fires sessionAccepted", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    let observed: Ax25ListenerSession | null = null;
    const accepted = new Promise<Ax25ListenerSession>((resolve) => {
      listener.onSessionAccepted((session) => {
        observed = session;
        resolve(session);
      });
    });

    await listener.start();

    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallA }));

    const session = await withTimeout(accepted, 2000, "sessionAccepted");
    expect(session).toBeTruthy();
    expect(session.context.local.equals(LocalCall)).toBe(true);
    expect(session.context.remote.equals(PeerCallA)).toBe(true);

    await transport.sentFrames.waitForCount(1, 2000);
    expect(transport.sentFrames.count).toBeGreaterThanOrEqual(1);
    const first = transport.decodedSent(0);
    // UA is a U-frame with control 0x63 + optional F bit.
    expect(first.control & 0xef).toBe(0x63);
    expect(session.state).toBe("Connected");

    await listener.dispose();
    void observed;
  });

  it("reuses session across sequential disconnects (same peer)", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    const captured: Ax25ListenerSession[] = [];
    listener.onSessionAccepted((s) => captured.push(s));

    await listener.start();

    // First connect.
    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallA }));
    await waitFor(() => captured.length >= 1, 2000);
    const first = captured[0]!;
    await waitFor(() => first.state === "Connected", 2000);

    // Peer disconnects.
    transport.injectInbound(disc({ destination: LocalCall, source: PeerCallA }));
    await waitFor(() => first.state === "Disconnected", 2000);

    // Re-SABM from the same peer. Cached session must be reused.
    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallA }));
    await waitFor(() => captured.length >= 2, 2000);
    const second = captured[1]!;
    expect(second).toBe(first); // same Ax25ListenerSession instance

    await listener.dispose();
  });

  it("drops DM for disallowed inbound (acceptIncoming=false)", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    listener.acceptIncoming = false;

    let sessionAcceptedFires = 0;
    listener.onSessionAccepted(() => sessionAcceptedFires++);

    await listener.start();

    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallA }));
    await transport.sentFrames.waitForCount(1, 2000);
    expect(transport.sentFrames.count).toBe(1);

    const reply = transport.decodedSent(0);
    // DM control: 0x0F (+ optional F bit).
    expect(reply.control & 0xef).toBe(0x0f);

    // Brief settle then check no sessionAccepted fires.
    await new Promise((r) => setTimeout(r, 150));
    expect(sessionAcceptedFires).toBe(0);

    await listener.dispose();
  });

  it("handles two concurrent peers — distinct sessions", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    const sessionsByPeer = new Map<string, Ax25ListenerSession>();
    const bothAccepted = new Promise<void>((resolve) => {
      listener.onSessionAccepted((session) => {
        sessionsByPeer.set(session.context.remote.toString(), session);
        if (sessionsByPeer.size === 2) resolve();
      });
    });

    await listener.start();

    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallA }));
    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallB }));

    await withTimeout(bothAccepted, 2000, "bothAccepted");
    expect(sessionsByPeer.size).toBe(2);
    const sA = sessionsByPeer.get(PeerCallA.toString())!;
    const sB = sessionsByPeer.get(PeerCallB.toString())!;
    expect(sA.context.remote.equals(PeerCallA)).toBe(true);
    expect(sB.context.remote.equals(PeerCallB)).toBe(true);
    expect(sA).not.toBe(sB);
    expect(sA.state).toBe("Connected");
    expect(sB.state).toBe("Connected");

    await listener.dispose();
  });

  it("frameTraced fires for all TX and RX", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    const traced: { dir: "tx" | "rx"; frame: Ax25Frame }[] = [];
    listener.onFrameTraced((e) => traced.push({ dir: e.direction, frame: e.frame }));

    await listener.start();

    // SABM in → UA out → DISC in → UA out. Four frames total.
    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallA }));
    await transport.sentFrames.waitForCount(1, 2000);
    transport.injectInbound(disc({ destination: LocalCall, source: PeerCallA }));
    await transport.sentFrames.waitForCount(2, 2000);

    await waitFor(() => traced.length >= 4, 2000);
    expect(traced.length).toBeGreaterThanOrEqual(4);
    expect(traced.filter((t) => t.dir === "rx").length).toBeGreaterThanOrEqual(2);
    expect(traced.filter((t) => t.dir === "tx").length).toBeGreaterThanOrEqual(2);

    // Sanity: the first RX must be the inbound SABM.
    const firstRx = traced.find((t) => t.dir === "rx")!;
    expect(classify(firstRx.frame)).toBe("SABM");

    await listener.dispose();
  });
});
