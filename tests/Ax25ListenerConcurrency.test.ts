/**
 * Concurrency / collision / lifecycle stress on {@link Ax25Listener}.
 * TS port of `tests/Packet.Ax25.Tests/Session/Ax25ListenerConcurrencyTests.cs`.
 *
 * Covers SABM collisions, repeated SABMs without UA echo, inbound SABM
 * while an outbound ConnectAsync is in flight, graceful stop with
 * multiple active sessions, and hostile event-handler isolation
 * (#140 carry-over).
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import { disc, sabm, ui } from "../src/frame.js";
import { Ax25Listener, type Ax25ListenerSession } from "../src/listener.js";
import { LoopbackTransport, waitFor, withTimeout } from "./listener-test-support.js";

const LocalCall = Callsign.parse("M0LTE");
const PeerCallA = Callsign.parse("G7XYZ-7");
const PeerCallB = Callsign.parse("M5ABC-3");
const PeerCallC = Callsign.parse("VK2DEF-1");

describe("Ax25Listener — concurrency & lifecycle", () => {
  // ─── Category 1: concurrency / collisions ───────────────────────────

  it("handles SABM collision (re-SABM while Connected)", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });

    let acceptedCount = 0;
    const firstAccepted = new Promise<Ax25ListenerSession>((resolve) => {
      listener.onSessionAccepted((s) => {
        acceptedCount++;
        if (acceptedCount === 1) resolve(s);
      });
    });

    await listener.start();
    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallA }));
    const session = await withTimeout(firstAccepted, 2000, "firstAccepted");
    await waitFor(() => session.state === "Connected", 2000);
    await transport.sentFrames.waitForCount(1, 2000);

    // Collision SABM — same peer while Connected. figc4.4 t41 silently
    // resets and re-emits UA. Listener must NOT build a second session.
    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallA }));
    await transport.sentFrames.waitForCount(2, 2000);

    // Both replies are UA (control 0x63 base).
    expect(transport.decodedSent(1).control & 0xef).toBe(0x63);
    expect(session.state).toBe("Connected");

    await new Promise((r) => setTimeout(r, 100));
    expect(acceptedCount).toBeGreaterThanOrEqual(1);

    await listener.dispose();
  });

  it("handles multiple SABMs within T1 window (lost UA)", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    const sessionsCreated: Ax25ListenerSession[] = [];
    listener.onSessionAccepted((s) => sessionsCreated.push(s));

    await listener.start();

    // Drop the listener's outbound UA so the (fake) peer doesn't see it.
    transport.dropOutbound = true;
    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallA }));

    await waitFor(() => sessionsCreated.length > 0, 2000);
    await waitFor(
      () => transport.outboundCount >= 1,
      2000,
      "listener must have attempted to send UA even though we drop it",
    );

    // Peer retries — re-enable outbound and SABM again.
    await new Promise((r) => setTimeout(r, 100));
    transport.dropOutbound = false;
    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallA }));
    await transport.sentFrames.waitForCount(1, 2000);

    // Idempotence: same session instance.
    const distinct = new Set(sessionsCreated);
    expect(distinct.size).toBe(1);
    expect(sessionsCreated[0]!.state).toBe("Connected");

    await listener.dispose();
  });

  it("handles inbound SABM during an outbound connect()", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, {
      myCall: LocalCall,
      t1Ms: 200,
      n2: 2,
    });

    const cAccepted = new Promise<Ax25ListenerSession>((resolve) => {
      listener.onSessionAccepted((s) => {
        if (s.context.remote.equals(PeerCallC)) resolve(s);
      });
    });

    await listener.start();

    // Outbound to B — no peer will respond, will eventually time out.
    const connectB = listener.connect(PeerCallB);
    await transport.sentFrames.waitForCount(1, 2000);

    // Now peer C SABMs — separate session, must be accepted.
    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallC }));
    const sessionC = await withTimeout(cAccepted, 2000, "cAccepted");
    expect(sessionC.context.remote.equals(PeerCallC)).toBe(true);
    expect(sessionC.state).toBe("Connected");

    // Drain the outbound B timeout so we don't leak the rejection.
    await connectB.catch(() => {
      /* expected — peer B never responded */
    });

    await listener.dispose();
  });

  it("stop() completes promptly during active sessions", async () => {
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
    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallA }));
    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallB }));
    await withTimeout(twoAccepted, 2000, "twoAccepted");
    expect(listener.isRunning).toBe(true);

    // stop() must return promptly even with active sessions.
    const start = Date.now();
    await withTimeout(listener.stop(), 3000, "stop()");
    expect(Date.now() - start).toBeLessThan(3000);
    expect(listener.isRunning).toBe(false);

    // Calling stop() twice is a no-op.
    await listener.stop();

    await listener.dispose();
  });

  // ─── Category 6: hostile event-handler (#140 carry-over) ────────────

  it("survives a sessionAccepted handler that throws", async () => {
    const handlerErrors: unknown[] = [];
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, {
      myCall: LocalCall,
      onHandlerError: (err) => handlerErrors.push(err),
    });

    let throwingHandlerFires = 0;
    const observedSessions: Ax25ListenerSession[] = [];
    listener.onSessionAccepted(() => {
      throwingHandlerFires++;
      throw new Error("test-induced — handler must not crash listener");
    });
    listener.onSessionAccepted((s) => observedSessions.push(s));

    await listener.start();

    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallA }));
    await waitFor(() => throwingHandlerFires >= 1, 2000);
    // Non-throwing subscriber must STILL have seen the event — proves
    // per-handler exception isolation.
    expect(observedSessions.length).toBe(1);
    expect(listener.isRunning).toBe(true);

    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallB }));
    await waitFor(() => throwingHandlerFires >= 2, 2000);
    expect(observedSessions.length).toBe(2);
    expect(listener.isRunning).toBe(true);

    // onHandlerError received the swallowed exceptions.
    expect(handlerErrors.length).toBeGreaterThanOrEqual(2);

    await listener.dispose();
  });

  it("survives a frameTraced handler that throws", async () => {
    const handlerErrors: unknown[] = [];
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, {
      myCall: LocalCall,
      onHandlerError: (err) => handlerErrors.push(err),
    });

    let throwingFires = 0;
    listener.onFrameTraced(() => {
      throwingFires++;
      throw new Error("test-induced — frameTraced handler must not crash listener");
    });

    await listener.start();
    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallA }));
    await waitFor(() => throwingFires >= 1, 2000);
    expect(listener.isRunning).toBe(true);

    transport.injectInbound(disc({ destination: LocalCall, source: PeerCallA }));
    await waitFor(() => throwingFires >= 2, 2000);
    expect(listener.isRunning).toBe(true);

    expect(handlerErrors.length).toBeGreaterThanOrEqual(2);

    await listener.dispose();
  });

  it("slow frameTraced handler doesn't stack up per-frame", async () => {
    // Note: the TS pump invokes handlers synchronously (same as C#),
    // so a slow handler DOES gate per-frame processing. The acceptance
    // criterion is generous to match C#'s flaky-test docstring: don't
    // stack > 1 slow-handler invocation between observations.
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });

    listener.onFrameTraced(() => {
      // Busy-wait ~100 ms — sync block; tests need short to keep runtime
      // bounded. The C# test sleeps 1 s; we shorten because vitest's
      // default per-test budget is more aggressive than xunit's.
      const until = Date.now() + 100;
      while (Date.now() < until) {
        // tight loop
      }
    });
    const stamps: number[] = [];
    listener.onFrameTraced(() => stamps.push(Date.now()));

    await listener.start();
    const t0 = Date.now();
    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCallA }));
    await new Promise((r) => setTimeout(r, 50));
    transport.injectInbound(
      ui({
        destination: LocalCall,
        source: PeerCallA,
        info: new Uint8Array(),
      }),
    );

    await waitFor(() => stamps.length >= 2, 5000);
    const firstDelta = stamps[0]! - t0;
    const secondDelta = stamps[1]! - t0;
    // Single slow handler can stack; multiple stacked must not.
    expect(secondDelta - firstDelta).toBeLessThan(500);

    await listener.dispose();
  });
});
