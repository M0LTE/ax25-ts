/**
 * Direct unit-level proof that {@link ActionDispatcher} reverses the
 * digipeater chain on responses to digipeated triggers. No listener
 * involved — drives the dispatcher directly. TS port of the
 * `ActionDispatcher_Reverses_Digipeater_Path_On_Response` C# test (PR #141).
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import { type Ax25Frame, sabm } from "../src/frame.js";
import {
  ActionDispatcher,
  type DataLinkSignal,
  type PendingFrame,
  type TransitionContext,
} from "../src/sdl/action-dispatcher.js";
import type { Ax25Event } from "../src/sdl/events.js";
import { createSessionContext } from "../src/sdl/session-context.js";
import { DefaultSubroutineRegistry } from "../src/sdl/subroutine-registry.js";
import { RealTimerScheduler } from "../src/sdl/timer-scheduler.js";

describe("ActionDispatcher — via-chain reversal (#141)", () => {
  it("reverses the digipeater path on a U-frame response", () => {
    const localCall = Callsign.parse("M0LTE");
    const peer = Callsign.parse("G7XYZ");
    const digi1 = Callsign.parse("GB7CIP");
    const digi2 = Callsign.parse("MB7UR");

    const ctx = createSessionContext(localCall, peer);
    const scheduler = new RealTimerScheduler();
    const emitted: Ax25Frame[] = [];
    const dispatcher = new ActionDispatcher(
      6000, // t1Ms (unused — see freezeT1V semantics)
      1500,
      30000,
      () => {
        /* no-op timer expiry */
      },
    );

    // Inbound SABM via [digi1, digi2] in transmission order.
    const inbound = sabm({
      destination: localCall,
      source: peer,
      digipeaters: [digi1, digi2],
    });
    const trigger: Ax25Event = { name: "SABM_received", frame: inbound };

    const pending: PendingFrame = { nr: null, ns: null, pfBit: null };
    const upward: DataLinkSignal[] = [];
    const tx: TransitionContext = {
      context: ctx,
      scheduler,
      event: trigger,
      pending,
      sendFrame: (f) => emitted.push(f),
      emitUpward: (s) => upward.push(s),
      subroutines: new DefaultSubroutineRegistry(),
      postEvent: () => {
        /* no-op */
      },
    };

    // figc4.1 t14's UA emit, simplified — just F:=P and UA.
    dispatcher.execute([{ verb: "F := P" }, { verb: "UA" }], tx, "Disconnected");

    expect(emitted.length).toBe(1);
    const ua = emitted[0]!;
    // Reversed chain on the wire: [digi2, digi1] — digi closest to
    // responder first.
    const wireDigis = ua.digipeaters.map((d) => d.callsign.toString());
    expect(wireDigis).toEqual([digi2.toString(), digi1.toString()]);
  });
});
