/**
 * Listener-level coverage for the per-listener compatibility knobs
 * ({@link Ax25ListenerOptions.parseOptions} / {@link Ax25ListenerOptions.quirks},
 * packet.net#366 parity) and the connectionless TEST responder
 * (packet.net#348 parity).
 *
 * TS port of the C# `Ax25ListenerCompatTests` + the TEST half of
 * `Ax25ListenerTestResponderTests`.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import {
  STRICT_PARSE,
  classify,
  encodeFrame,
  isResponse,
  pollFinal,
  sabm,
  test as testFrame,
} from "../src/frame.js";
import { Ax25Listener, type Ax25ListenerSession } from "../src/listener.js";
import {
  defaultSessionQuirks,
  strictlyFaithfulSessionQuirks,
} from "../src/sdl/session-quirks.js";
import { LoopbackTransport, waitFor } from "./listener-test-support.js";

const LocalCall = Callsign.parse("M0LTE");
const PeerCall = Callsign.parse("G7XYZ-7");

/** Wire bytes of a response-direction SABM (the v1.x-flavoured connect, #142).
 * Same bit-twiddle as the C# tests. */
function responseSabmBytes(): Uint8Array {
  const bytes = encodeFrame(sabm({ destination: LocalCall, source: PeerCall }));
  bytes[6]! &= 0x7f; // destination SSID octet: clear C-bit
  bytes[13]! |= 0x80; // source SSID octet: set C-bit → response shape
  return bytes;
}

describe("Ax25Listener parseOptions (#366 parity)", () => {
  it("a strict listener is deaf to a response-SABM: no session, no reply, no trace", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, {
      myCall: LocalCall,
      parseOptions: STRICT_PARSE,
    });
    let accepted = 0;
    let traced = 0;
    listener.onSessionAccepted(() => accepted++);
    listener.onFrameTraced(() => traced++);
    await listener.start();

    transport.injectInboundBytes(responseSabmBytes());
    await new Promise((r) => setTimeout(r, 100));

    expect(accepted).toBe(0); // strict drops it at decode — no session can open
    expect(traced).toBe(0); // dropped before the monitor trace — deaf end-to-end
    expect(transport.sentFrames.count).toBe(0); // nothing (UA or DM) went out
    await listener.dispose();
  });

  it("the default (lenient) listener accepts the same bytes and connects", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    let session: Ax25ListenerSession | null = null;
    listener.onSessionAccepted((s) => (session = s));
    await listener.start();

    transport.injectInboundBytes(responseSabmBytes());
    await waitFor(() => session !== null, 2000, "session accepted");
    await waitFor(() => transport.sentFrames.count >= 1, 2000, "UA sent");

    expect(session!.state).toBe("Connected");
    expect(classify(transport.decodedSent(0))).toBe("UA");
    await listener.dispose();
  });

  it("a strict listener still accepts a spec-valid (command) SABM", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, {
      myCall: LocalCall,
      parseOptions: STRICT_PARSE,
    });
    let session: Ax25ListenerSession | null = null;
    listener.onSessionAccepted((s) => (session = s));
    await listener.start();

    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCall }));
    await waitFor(() => session !== null, 2000, "session accepted");
    expect(session!.state).toBe("Connected");
    await listener.dispose();
  });
});

describe("Ax25Listener quirks (#366 parity)", () => {
  it("configured quirks seed onto newly-built sessions", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, {
      myCall: LocalCall,
      quirks: strictlyFaithfulSessionQuirks,
    });
    let session: Ax25ListenerSession | null = null;
    listener.onSessionAccepted((s) => (session = s));
    await listener.start();

    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCall }));
    await waitFor(() => session !== null, 2000, "session accepted");
    expect(session!.context.quirks).toEqual(strictlyFaithfulSessionQuirks);
    await listener.dispose();
  });

  it("absent quirks leave the spec-correct defaults", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    let session: Ax25ListenerSession | null = null;
    listener.onSessionAccepted((s) => (session = s));
    await listener.start();

    transport.injectInbound(sabm({ destination: LocalCall, source: PeerCall }));
    await waitFor(() => session !== null, 2000, "session accepted");
    expect(session!.context.quirks).toEqual(defaultSessionQuirks);
    await listener.dispose();
  });
});

describe("connectionless TEST (§4.3.4.2, #348 parity)", () => {
  it("answers a TEST command with a TEST response echoing the info, F mirroring P", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    let accepted = 0;
    listener.onSessionAccepted(() => accepted++);
    await listener.start();

    const probe = Uint8Array.from([0x01, 0x02, 0x03]);
    transport.injectInbound(
      testFrame({
        destination: LocalCall,
        source: PeerCall,
        info: probe,
        isCommand: true,
        pollFinal: true,
      }),
    );
    await transport.sentFrames.waitForCount(1, 2000);

    const reply = transport.decodedSent(0);
    expect(classify(reply)).toBe("TEST");
    expect(isResponse(reply)).toBe(true); // we answer as a response…
    expect(pollFinal(reply)).toBe(true); // …whose F bit mirrors the command's P
    expect(Array.from(reply.info)).toEqual(Array.from(probe)); // echoed verbatim
    expect(reply.destination.callsign.equals(PeerCall)).toBe(true);
    expect(reply.source.callsign.equals(LocalCall)).toBe(true);

    // Connectionless: no session was built, and exactly one frame (no DM) went out.
    expect(accepted).toBe(0);
    expect(transport.sentFrames.count).toBe(1);
    await listener.dispose();
  });

  it("absorbs a TEST response without provoking a DM", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    await listener.start();

    transport.injectInbound(
      testFrame({
        destination: LocalCall,
        source: PeerCall,
        info: Uint8Array.from([0xaa]),
        isCommand: false,
        pollFinal: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 100));

    // Pre-parity behaviour was the Disconnected t05 catch-all → DM (spec-noise
    // back at a station that just answered our probe). Now: silence.
    expect(transport.sentFrames.count).toBe(0);
    await listener.dispose();
  });

  it("sendTest emits a TEST command probe from the listener's own call", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    await listener.start();

    const probe = Uint8Array.from([0x55, 0xaa]);
    await listener.sendTest(PeerCall, probe);

    expect(transport.sentFrames.count).toBe(1);
    const sent = transport.decodedSent(0);
    expect(classify(sent)).toBe("TEST");
    expect(isResponse(sent)).toBe(false);
    expect(pollFinal(sent)).toBe(true); // a command soliciting a response
    expect(Array.from(sent.info)).toEqual(Array.from(probe));
    expect(sent.source.callsign.equals(LocalCall)).toBe(true);
    await listener.dispose();
  });
});
