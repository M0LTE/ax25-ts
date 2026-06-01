/**
 * The `ax25Spec38SrejSelectiveRetransmit` session quirk
 * (packethacking/ax25spec#38). figc4.5 draws SREJ-received as the generic
 * fresh-DL-DATA "Push frame onto queue" verb followed by go-back-N "Invoke
 * Retransmission", contradicting §4.3.2.4/§6.4.8, figc4.4, and every
 * implementation. With the quirk on (default) the runtime does single-frame
 * selective retransmit; with it off (strictly-faithful) it runs the figure as
 * drawn — which throws on the payload-less push.
 *
 * TS port of packet.net's `Ax25SessionQuirksTests` (m0lte/packet.net #228).
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import { type Ax25Frame, rej } from "../src/frame.js";
import {
  ActionDispatcher,
  type DataLinkSignal,
  type PendingFrame,
  type TransitionContext,
} from "../src/sdl/action-dispatcher.js";
import type { Ax25Event } from "../src/sdl/events.js";
import {
  type Ax25SessionContext,
  createSessionContext,
} from "../src/sdl/session-context.js";
import {
  type Ax25SessionQuirks,
  defaultSessionQuirks,
  strictlyFaithfulSessionQuirks,
} from "../src/sdl/session-quirks.js";
import { DefaultSubroutineRegistry } from "../src/sdl/subroutine-registry.js";
import { RealTimerScheduler } from "../src/sdl/timer-scheduler.js";

const PID = 0xf0;

function newRig(quirks: Ax25SessionQuirks): {
  dispatcher: ActionDispatcher;
  ctx: Ax25SessionContext;
  makeTx: (event: Ax25Event) => TransitionContext;
} {
  const local = Callsign.parse("M0LTEA");
  const remote = Callsign.parse("M0LTEB");
  const ctx = createSessionContext(local, remote);
  ctx.quirks = { ...quirks };

  // A sent, unacked window: V(s)=3, V(a)=0, frames 0/1/2 still in storage.
  ctx.vs = 3;
  ctx.va = 0;
  for (let ns = 0; ns < 3; ns++) {
    ctx.sentIFrames.set(ns, { data: new Uint8Array([ns]), pid: PID });
  }

  const scheduler = new RealTimerScheduler();
  const dispatcher = new ActionDispatcher(6000, 1500, 30000, () => {});

  const makeTx = (event: Ax25Event): TransitionContext => {
    const pending: PendingFrame = { nr: null, ns: null, pfBit: null };
    return {
      context: ctx,
      scheduler,
      event,
      pending,
      sendFrame: (_f: Ax25Frame) => {},
      emitUpward: (_s: DataLinkSignal) => {},
      subroutines: new DefaultSubroutineRegistry(),
      postEvent: () => {},
    };
  };

  return { dispatcher, ctx, makeTx };
}

// figc4.5 draws the SREJ trigger as an `SREJ_received` event carrying the
// peer's N(R). The dispatcher only reads N(R) (via getNr), so a REJ frame
// with the same N(R) field is a faithful stand-in — there's no public SREJ
// factory yet.
function srejEvent(local: Callsign, remote: Callsign, nr: number): Ax25Event {
  const frame = rej({
    destination: local,
    source: remote,
    nr,
    isCommand: false,
    pollFinal: true,
  });
  return { name: "SREJ_received", frame };
}

describe("Ax25Spec38 SREJ selective-retransmit quirk", () => {
  it("quirk on does single-frame selective retransmit, not go-back-N", () => {
    const { dispatcher, ctx, makeTx } = newRig(defaultSessionQuirks); // on (default)
    const tx = makeTx(srejEvent(ctx.local, ctx.remote, 1));

    // The figc4.5 SREJ-received retransmit verbs as the table draws them.
    dispatcher.execute(
      [
        { verb: "push_frame_on_queue" },
        { verb: "Invoke Retransmission" },
      ],
      tx,
      "TimerRecovery",
    );

    // SREJ must selectively retransmit only the single N(r) frame, not
    // go-back-N the whole window.
    expect(ctx.iFrameQueue.length).toBe(1);
    // The re-queued frame is the requested N(r)=1.
    expect(Array.from(ctx.iFrameQueue[0]!.data)).toEqual([1]);
  });

  it("quirk off runs the figure as drawn and throws on the payload-less push", () => {
    const { dispatcher, ctx, makeTx } = newRig(strictlyFaithfulSessionQuirks); // off
    const tx = makeTx(srejEvent(ctx.local, ctx.remote, 1));

    // With the quirk off the figc4.5 figure runs as drawn — the fresh-DL-DATA
    // push carries no payload on an SREJ trigger and throws (the #38 defect,
    // faithfully reproduced).
    expect(() =>
      dispatcher.execute([{ verb: "push_frame_on_queue" }], tx, "TimerRecovery"),
    ).toThrow();
    expect(ctx.iFrameQueue.length).toBe(0);
  });
});
