/**
 * Tests for the friendly facade methods on {@link Ax25ListenerSession} —
 * `to`, `onData`, `onDisconnected`, `write`, `disconnect`. These mirror
 * the same-named methods on {@link Ax25Session} (the outbound-only
 * facade owned by Ax25Stack), so a session from either source is
 * drop-in compatible from a consumer's point of view.
 *
 * The raw `postEvent` / `onDataLinkSignal` API is covered by the other
 * Ax25Listener test files; this file specifically pins the friendly
 * layer.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import {
  classify,
  decodeFrame,
  disc,
  iFrame,
  sabm,
  ua,
} from "../src/frame.js";
import { Ax25Listener, type Ax25ListenerSession } from "../src/listener.js";
import { LoopbackTransport, waitFor, withTimeout } from "./listener-test-support.js";

const LocalCall = Callsign.parse("M0LTE");
const PeerCall = Callsign.parse("G7XYZ-7");

/** Drive a listener through SABM/UA so the test has a Connected session. */
async function connectInbound(): Promise<{
  transport: LoopbackTransport;
  listener: Ax25Listener;
  session: Ax25ListenerSession;
}> {
  const transport = new LoopbackTransport();
  const listener = new Ax25Listener(transport, { myCall: LocalCall });
  const accepted = new Promise<Ax25ListenerSession>((resolve) => {
    listener.onSessionAccepted(resolve);
  });
  await listener.start();
  transport.injectInbound(sabm({ destination: LocalCall, source: PeerCall }));
  const session = await withTimeout(accepted, 2000, "sessionAccepted");
  await waitFor(() => session.state === "Connected", 2000);
  return { transport, listener, session };
}

describe("Ax25ListenerSession — friendly facade (Ax25Session parity)", () => {
  it("`to` returns the peer callsign", async () => {
    const { listener, session } = await connectInbound();
    expect(session.to.equals(PeerCall)).toBe(true);
    expect(session.to.toString()).toBe("G7XYZ-7");
    await listener.dispose();
  });

  it("`onData` delivers I-frame info to the callback", async () => {
    const { transport, listener, session } = await connectInbound();
    const received: Uint8Array[] = [];
    session.onData((chunk) => received.push(chunk));

    transport.injectInbound(
      iFrame({
        destination: LocalCall,
        source: PeerCall,
        ns: 0,
        nr: 0,
        info: new TextEncoder().encode("hello from peer"),
        pid: 0xf0,
        pollBit: false,
      }),
    );

    await waitFor(() => received.length >= 1, 2000);
    expect(received[0]).toBeTruthy();
    expect(new TextDecoder().decode(received[0]!)).toBe("hello from peer");
    await listener.dispose();
  });

  it("`onDisconnected` fires on peer-initiated DISC", async () => {
    const { transport, listener, session } = await connectInbound();
    let disconnectFired = 0;
    session.onDisconnected(() => disconnectFired++);

    transport.injectInbound(disc({ destination: LocalCall, source: PeerCall }));
    await waitFor(() => session.state === "Disconnected", 2000);
    await new Promise((r) => setTimeout(r, 50));
    expect(disconnectFired).toBeGreaterThanOrEqual(1);
    await listener.dispose();
  });

  it("`write` emits an I-frame with the right payload and default PID 0xF0", async () => {
    const { transport, listener, session } = await connectInbound();
    const baselineCount = transport.sentFrames.count;

    await session.write(new TextEncoder().encode("hello from us"));

    await transport.sentFrames.waitForCount(baselineCount + 1, 2000);
    const frame = transport.decodedSent(baselineCount);
    expect(classify(frame)).toBe("I");
    expect(frame.pid).toBe(0xf0);
    expect(frame.info).toBeTruthy();
    expect(new TextDecoder().decode(frame.info!)).toBe("hello from us");
    expect(frame.destination.callsign.equals(PeerCall)).toBe(true);
    expect(frame.source.callsign.equals(LocalCall)).toBe(true);
    await listener.dispose();
  });

  it("`write` respects a custom PID", async () => {
    const { transport, listener, session } = await connectInbound();
    const baselineCount = transport.sentFrames.count;

    await session.write(new TextEncoder().encode("netrom"), 0xcf);

    await transport.sentFrames.waitForCount(baselineCount + 1, 2000);
    const frame = transport.decodedSent(baselineCount);
    expect(frame.pid).toBe(0xcf);
    await listener.dispose();
  });

  it("`write` throws when the session is not Connected", async () => {
    const { transport, listener, session } = await connectInbound();
    transport.injectInbound(disc({ destination: LocalCall, source: PeerCall }));
    await waitFor(() => session.state === "Disconnected", 2000);

    await expect(session.write(new TextEncoder().encode("nope"))).rejects.toThrow(
      /cannot write in state Disconnected/,
    );
    await listener.dispose();
  });

  it("`write` of an empty buffer resolves without emitting a frame", async () => {
    const { transport, listener, session } = await connectInbound();
    const baselineCount = transport.sentFrames.count;
    await session.write(new Uint8Array(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(transport.sentFrames.count).toBe(baselineCount);
    await listener.dispose();
  });

  it("`disconnect` resolves when the session enters Disconnected", async () => {
    const { transport, listener, session } = await connectInbound();
    const baselineCount = transport.sentFrames.count;

    // Kick off disconnect — don't await yet. Promise resolves on
    // DL_DISCONNECT_confirm, which fires after the peer responds to
    // our DISC with UA. We orchestrate that response below.
    const disconnectPromise = session.disconnect();

    await transport.sentFrames.waitForCount(baselineCount + 1, 2000);
    const ourDisc = transport.decodedSent(baselineCount);
    expect(classify(ourDisc)).toBe("DISC");

    transport.injectInbound(ua({ destination: LocalCall, source: PeerCall, finalBit: true }));

    await withTimeout(disconnectPromise, 2000, "disconnect");
    expect(session.state).toBe("Disconnected");
    await listener.dispose();
  });

  it("`disconnect` on an already-disconnected session resolves immediately", async () => {
    const { transport, listener, session } = await connectInbound();
    transport.injectInbound(disc({ destination: LocalCall, source: PeerCall }));
    await waitFor(() => session.state === "Disconnected", 2000);
    // Already Disconnected — should resolve fast (well under 500ms).
    await withTimeout(session.disconnect(), 500, "disconnect (already-disconnected)");
    await listener.dispose();
  });
});
