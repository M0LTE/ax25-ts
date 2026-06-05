/**
 * Tests for {@link Ax25Listener.sendUi} — the connectionless UI (unproto) send
 * path added for NET/ROM NODES origination. It bypasses the session layer: the
 * source is the listener's own callsign and the frame is a UI frame with the
 * supplied destination + PID + info, traced as a `tx` frame.
 *
 * TS port of `tests/Packet.Ax25.Tests/Session/Ax25ListenerSendUiTests.cs`.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import {
  classify,
  isCommand,
  PID_NET_ROM,
} from "../src/frame.js";
import {
  Ax25Listener,
  type Ax25FrameTracedEvent,
  type FrameDirection,
} from "../src/listener.js";
import { LoopbackTransport } from "./listener-test-support.js";

const LocalCall = Callsign.parse("M0LTE");

describe("Ax25Listener.sendUi", () => {
  it("emits a UI frame with the given dest, pid, info and the listener's source", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    await listener.start();

    const nodesDest = Callsign.parse("NODES");
    const info = Uint8Array.from([0xff, "R".charCodeAt(0), "D".charCodeAt(0), "G".charCodeAt(0)]);
    await listener.sendUi(nodesDest, info, PID_NET_ROM);

    expect(transport.sentFrames.count).toBe(1);
    const sent = transport.decodedSent(0);
    expect(classify(sent)).toBe("UI"); // a NODES broadcast rides a UI frame
    expect(sent.pid).toBe(PID_NET_ROM);
    expect(sent.destination.callsign.equals(nodesDest)).toBe(true);
    // The source is the listener's own callsign — not overridable.
    expect(sent.source.callsign.equals(LocalCall)).toBe(true);
    expect(Array.from(sent.info)).toEqual(Array.from(info));
    // UI broadcasts are commands (dest C-bit set, src C-bit clear).
    expect(isCommand(sent)).toBe(true);

    await listener.dispose();
  });

  it("defaults the PID to no-layer-3 (0xF0) when omitted", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    await listener.start();

    await listener.sendUi(Callsign.parse("CQ"), Uint8Array.from([1, 2, 3]));
    expect(transport.decodedSent(0).pid).toBe(0xf0);

    await listener.dispose();
  });

  it("traces the originated frame as transmitted (tx) AFTER it is sent", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    await listener.start();

    const traced: Ax25FrameTracedEvent[] = [];
    let outboundCountWhenTraced = -1;
    listener.onFrameTraced((e) => {
      traced.push(e);
      // The send must already have happened by the time the trace fires.
      outboundCountWhenTraced = transport.outboundCount;
    });

    await listener.sendUi(Callsign.parse("NODES"), Uint8Array.from([0xff]), PID_NET_ROM);

    expect(traced).toHaveLength(1);
    const direction: FrameDirection = traced[0]!.direction;
    expect(direction).toBe("tx"); // the monitor should see the originated NODES broadcast
    expect(outboundCountWhenTraced).toBe(1); // traced after the wire send, not before

    await listener.dispose();
  });

  it("a throwing frame-trace subscriber cannot stop sendUi (handler isolation)", async () => {
    const errors: unknown[] = [];
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, {
      myCall: LocalCall,
      onHandlerError: (err) => errors.push(err),
    });
    await listener.start();

    listener.onFrameTraced(() => {
      throw new Error("hostile tap");
    });

    // The send must complete (the frame is on the wire) despite the throwing tap.
    await expect(
      listener.sendUi(Callsign.parse("NODES"), Uint8Array.from([0xff]), PID_NET_ROM),
    ).resolves.toBeUndefined();
    expect(transport.outboundCount).toBe(1);
    expect(errors).toHaveLength(1); // the handler exception was routed to onHandlerError

    await listener.dispose();
  });

  it("throws after the listener is disposed", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: LocalCall });
    await listener.start();
    await listener.dispose();

    await expect(
      listener.sendUi(Callsign.parse("NODES"), Uint8Array.from([0xff]), PID_NET_ROM),
    ).rejects.toThrow(/disposed/);
  });
});
