import type { Ax25Guard } from "ax25sdl";
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import type { Ax25Frame } from "../src/frame.js";
import { ActionDispatcher, UnknownActionError } from "../src/sdl/action-dispatcher.js";
import type { Ax25Event } from "../src/sdl/events.js";
import { GuardEvaluationError, GuardEvaluator } from "../src/sdl/guard-evaluator.js";
import { createSessionBindings } from "../src/sdl/session-bindings.js";
import { createSessionContext } from "../src/sdl/session-context.js";
import { SdlSessionDriver } from "../src/sdl/session-driver.js";
import { DefaultSubroutineRegistry } from "../src/sdl/subroutine-registry.js";
import { RealTimerScheduler } from "../src/sdl/timer-scheduler.js";

// ─── Fixture builders ───────────────────────────────────────────────────

function makeDriver(opts?: {
  state?: string;
  onUnhandled?: (e: Ax25Event, s: string) => void;
  recordFrames?: Ax25Frame[];
  recordSignals?: unknown[];
}): {
  driver: SdlSessionDriver;
  frames: Ax25Frame[];
  signals: unknown[];
} {
  const frames: Ax25Frame[] = opts?.recordFrames ?? [];
  const signals: unknown[] = opts?.recordSignals ?? [];
  const ctx = createSessionContext(
    Callsign.parse("A"),
    Callsign.parse("B"),
  );
  ctx.k = 1;
  const scheduler = new RealTimerScheduler();
  const driver = new SdlSessionDriver(ctx, scheduler, {
    sendFrame: (f) => frames.push(f),
    emitUpward: (s) => signals.push(s),
    onUnhandledEvent: opts?.onUnhandled,
    freezeT1V: true,
    t1Ms: 1000,
  });
  if (opts?.state) driver.setState(opts.state);
  return { driver, frames, signals };
}

// ─── Tests: table-walking behaviour ─────────────────────────────────────

describe("SDL driver — catchall behaviour", () => {
  it("silently ignores events in states with no matching transition", () => {
    const unhandled: { event: Ax25Event; state: string }[] = [];
    const { driver } = makeDriver({
      onUnhandled: (event, state) => unhandled.push({ event, state }),
    });
    // T3_expiry has no transition in Disconnected.
    driver.postEvent({ name: "T3_expiry" });
    expect(unhandled.length).toBe(1);
    expect(unhandled[0]!.state).toBe("Disconnected");
    expect(unhandled[0]!.event.name).toBe("T3_expiry");
    // Driver state should be unchanged.
    expect(driver.currentState).toBe("Disconnected");
  });

  it("dispatches matching transitions and advances state", () => {
    const { driver, frames } = makeDriver();
    driver.postEvent({ name: "DL_CONNECT_request" });
    // Should emit a SABM and transition to AwaitingConnection.
    expect(driver.currentState).toBe("AwaitingConnection");
    expect(frames.length).toBe(1);
    expect((frames[0]!.control & 0xef)).toBe(0x2f); // SABM control byte
  });
});

describe("SDL driver — guard ordering", () => {
  it("picks the first matching transition for an event with multiple guards", () => {
    // In Disconnected, SABM_received has two transitions:
    //   t14_sabm_received_able   (guard: able_to_establish)   → Connected
    //   t15_sabm_received_unable (guard: not able_to_establish) → Disconnected
    // With our default `able_to_establish` binding returning true, t14
    // fires.
    const { driver, frames } = makeDriver();
    const sabmFrame = {
      destination: {
        callsign: Callsign.parse("A"),
        crhBit: true,
        extensionBit: false,
      },
      source: {
        callsign: Callsign.parse("B"),
        crhBit: false,
        extensionBit: true,
      },
      digipeaters: [],
      control: 0x3f, // SABM with P=1
      pid: null,
      info: new Uint8Array(0),
    };
    driver.postEvent({ name: "SABM_received", frame: sabmFrame });
    // t14 takes us to Connected.
    expect(driver.currentState).toBe("Connected");
    // t14 emits UA — we should see one frame.
    const uaFrames = frames.filter((f) => (f.control & 0xef) === 0x63);
    expect(uaFrames.length).toBe(1);
  });
});

describe("SDL driver — unbound predicate", () => {
  it("throws GuardEvaluationError when a guard references an unknown identifier", () => {
    const ctx = createSessionContext(
      Callsign.parse("A"),
      Callsign.parse("B"),
    );
    const sched = new RealTimerScheduler();
    const bindings = createSessionBindings(ctx, sched, () => null);
    // Strip the binding to make it unbound. (In normal operation the typed
    // Ax25Guard-keyed map is exhaustive by construction, so this can't happen —
    // but the evaluator still throws defensively, matching the C# walker's
    // GuardEvaluationException it catches.)
    const stripped = new Map(bindings);
    stripped.delete("layer_3_initiated");
    const evaluator = new GuardEvaluator(stripped);
    const guard = [{ atom: "layer_3_initiated", negate: false }] as const;
    expect(() => evaluator.evaluate(guard)).toThrow(GuardEvaluationError);
    expect(() => evaluator.evaluate(guard)).toThrow(
      /unbound guard atom 'layer_3_initiated'/,
    );
  });

  it("treats empty / null / undefined guards as true (no guard)", () => {
    const ctx = createSessionContext(
      Callsign.parse("A"),
      Callsign.parse("B"),
    );
    const sched = new RealTimerScheduler();
    const evaluator = new GuardEvaluator(
      createSessionBindings(ctx, sched, () => null),
    );
    expect(evaluator.evaluate([])).toBe(true);
    expect(evaluator.evaluate(null)).toBe(true);
    expect(evaluator.evaluate(undefined)).toBe(true);
  });
});

describe("SDL driver — unknown action verb", () => {
  it("throws UnknownActionError with the verb name and current state", () => {
    const ctx = createSessionContext(
      Callsign.parse("A"),
      Callsign.parse("B"),
    );
    const sched = new RealTimerScheduler();
    const dispatcher = new ActionDispatcher(1000, 1500, 30000, () => {});
    expect(() =>
      dispatcher.execute(
        [{ verb: "this_verb_does_not_exist", kind: "processing" }],
        {
          context: ctx,
          scheduler: sched,
          event: { name: "T1_expiry" },
          pending: { nr: null, ns: null, pfBit: null },
          sendFrame: () => {},
          emitUpward: () => {},
          subroutines: new DefaultSubroutineRegistry(),
          postEvent: () => {},
        },
        "Connected",
      ),
    ).toThrow(UnknownActionError);
    expect(() =>
      dispatcher.execute(
        [{ verb: "another_unknown_verb", kind: "processing" }],
        {
          context: ctx,
          scheduler: sched,
          event: { name: "T1_expiry" },
          pending: { nr: null, ns: null, pfBit: null },
          sendFrame: () => {},
          emitUpward: () => {},
          subroutines: new DefaultSubroutineRegistry(),
          postEvent: () => {},
        },
        "Disconnected",
      ),
    ).toThrow(/another_unknown_verb.*Disconnected/);
  });
});

describe("SDL driver — guard evaluator (typed GuardTerm conjunction)", () => {
  // `a` = true, `b` = true, `c` = false — using real Ax25Guard atoms as stubs
  // so the typed bindings map typechecks.
  const stubBindings = new Map<Ax25Guard, () => boolean>([
    ["P_eq_1", () => true], // a
    ["F_eq_1", () => true], // b
    ["command", () => false], // c
  ]);

  it("ANDs the terms of a conjunction", () => {
    const e = new GuardEvaluator(stubBindings);
    expect(
      e.evaluate([
        { atom: "P_eq_1", negate: false },
        { atom: "F_eq_1", negate: false },
      ]),
    ).toBe(true);
    expect(
      e.evaluate([
        { atom: "P_eq_1", negate: false },
        { atom: "command", negate: false },
      ]),
    ).toBe(false);
    expect(
      e.evaluate([
        { atom: "P_eq_1", negate: false },
        { atom: "F_eq_1", negate: false },
        { atom: "command", negate: false },
      ]),
    ).toBe(false);
  });

  it("applies a term's negate flag", () => {
    const e = new GuardEvaluator(stubBindings);
    // not a (a=true) → false
    expect(e.evaluate([{ atom: "P_eq_1", negate: true }])).toBe(false);
    // not c (c=false) → true
    expect(e.evaluate([{ atom: "command", negate: true }])).toBe(true);
    // not a and b → false
    expect(
      e.evaluate([
        { atom: "P_eq_1", negate: true },
        { atom: "F_eq_1", negate: false },
      ]),
    ).toBe(false);
    // a and not c → true
    expect(
      e.evaluate([
        { atom: "P_eq_1", negate: false },
        { atom: "command", negate: true },
      ]),
    ).toBe(true);
  });

  it("evaluates a single term via evaluateTerm (loop predicate)", () => {
    const e = new GuardEvaluator(stubBindings);
    expect(e.evaluateTerm({ atom: "P_eq_1", negate: false })).toBe(true);
    expect(e.evaluateTerm({ atom: "P_eq_1", negate: true })).toBe(false);
    expect(e.evaluateTerm({ atom: "command", negate: true })).toBe(true);
  });
});

describe("SDL driver — bindings dictionary", () => {
  it("binds session-context flags and sequence variables", () => {
    const ctx = createSessionContext(
      Callsign.parse("A"),
      Callsign.parse("B"),
    );
    ctx.acknowledgePending = true;
    ctx.vs = 3;
    ctx.va = 3;
    const sched = new RealTimerScheduler();
    const bindings = createSessionBindings(ctx, sched, () => null);
    expect(bindings.get("ack_pending")!()).toBe(true);
    expect(bindings.get("vs_eq_va")!()).toBe(true);
    ctx.vs = 4;
    expect(bindings.get("vs_eq_va")!()).toBe(false);
  });

  it("binds timer-running predicates against the scheduler", () => {
    const ctx = createSessionContext(
      Callsign.parse("A"),
      Callsign.parse("B"),
    );
    const sched = new RealTimerScheduler();
    const bindings = createSessionBindings(ctx, sched, () => null);
    expect(bindings.get("T1_running")!()).toBe(false);
    sched.arm("T1", 1000, () => {});
    expect(bindings.get("T1_running")!()).toBe(true);
    sched.cancel("T1");
  });
});
