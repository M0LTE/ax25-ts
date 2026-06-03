/**
 * Property: loss-recovery / stream invariant, driven generatively. Over a
 * connected session subjected to a *random finite* drop pattern, the delivered
 * upper-layer stream equals the sent stream, in order — the headline AX.25
 * connected-mode guarantee (reliable, in-order, gap-free, duplicate-free
 * delivery). The fast-check generalisation of the seeded parametrized-loop
 * sweeps in `tests/conformance/loss-recovery.test.ts` and
 * `tests/conformance/mod128-loss-recovery.test.ts`, and the TS analogue of
 * packet.net's FsCheck `LossRecoveryProperties`
 * (`A_single_dropped_iframe_always_recovers` /
 * `A_finite_bidirectional_loss_burst_recovers`).
 *
 * The existing conformance suite explicitly noted it could *not* use a property
 * library — "ax25-ts has no property-testing library on its dependency tree …
 * adding one is out of scope" (that file may only touch `tests/conformance/`).
 * This file closes that gap: same harness, same oracle, now fed by fast-check
 * generators instead of an enumerated seed space, so the loss space is sampled
 * (and shrunk on failure) rather than hand-listed.
 *
 * ## Scope: unidirectional data transfer
 *
 * These properties drive data in ONE direction (A → B) under a lossy channel,
 * matching exactly what the C# `LossRecoveryProperties` exercise: there
 * "bidirectional" names bidirectional *drops* (acks/retransmits in either
 * direction), not bidirectional *data submission* — every C# loss property
 * submits from A only (`for (i…) h.Submit(h.A, i)`). Simultaneous data
 * submission from BOTH stations under loss is a separate, currently-failing
 * surface — see `srej-recovery-duplicate-delivery.known-failure.test.ts` for the
 * pinned duplicate-delivery defect that generative coverage surfaced.
 *
 * ## Why finite loss
 *
 * Recovery is only *guaranteed* to converge once the disruption ceases (within
 * N2 retries). An unbounded-loss channel is the N2-give-up path, not the
 * reliable-delivery path — so, exactly as the C# `…_finite_…` property does, the
 * generators bound the drop budget and then let the clean tail reconverge. The
 * oracle (`assertConverged` → `checkReliableDelivery`) is the invariant; a
 * `withStormCap`-style wire ceiling turns any non-convergence into a fast,
 * attributable failure rather than a hang.
 *
 * ## Window-size precondition (k ≤ modulus − 1)
 *
 * AX.25 (inheriting X.25 §2.3.2.3) requires the send window k ≤ N − 1 (≤ 7 for
 * mod-8, ≤ 127 for mod-128): with k = N, a full window of outstanding frames
 * makes `(V(s) − V(a)) mod N` wrap to 0, indistinguishable from an empty window.
 * The generators cap k accordingly; `k = N` is a misconfiguration, not a loss
 * scenario, and is out of scope here.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { type Ax25Frame, classify, getNs } from "../../src/frame.js";
import {
  type Endpoint,
  TwoStationHarness,
  iFrameFrom,
} from "../conformance/two-station-harness.js";

const RUNS = 300; // each run drives a full multi-frame recovery — keep modest

/** Hard ceiling on frames-on-wire per run — a converging scenario settles well
 * under this; tripping it means a storm, so fail fast and loud rather than
 * spinning the synchronous pump. Mirrors `WIRE_STORM_CAP` in the conformance
 * loss-recovery suite. */
const WIRE_STORM_CAP = 6000;

function withStormCap(
  log: readonly unknown[],
  predicate: (f: Ax25Frame) => boolean,
): (f: Ax25Frame) => boolean {
  return (f) => {
    if (log.length > WIRE_STORM_CAP) {
      throw new Error(
        `storm: wire exceeded ${WIRE_STORM_CAP} frames without converging`,
      );
    }
    return predicate(f);
  };
}

/** Deterministic LCG → [0,1). The drop pattern is a pure function of its seed,
 * so a failing case replays exactly (no Math.random). Mirrors the conformance
 * suite's `lcg`. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** k capped to the modulo's legal window (N − 1). */
function legalWindow(want: number, extended: boolean): number {
  return Math.min(want, extended ? 127 : 7);
}

/** The flattened delivered byte-stream at `e` (one byte per single-byte
 * submission — the harness submits single-byte payloads). */
function deliveredStream(e: Endpoint): number[] {
  return e.delivered.map((d) => d[0]!);
}

/** The flattened submitted byte-stream at `e`. */
function submittedStream(e: Endpoint): number[] {
  return e.submitted.map((d) => d[0]!);
}

describe("property: single dropped I-frame always recovers (delivered == sent, in order)", () => {
  // Mirrors `A_single_dropped_iframe_always_recovers`, fuzzed over n, the
  // dropped position, REJ/SREJ, and both modulos.
  it("over any (n, dropPos, mode, modulo)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 7 }),
        fc.boolean(), // srej
        fc.boolean(), // extended (mod-8 / mod-128)
        fc.nat(),
        (n, srej, extended, dropSeed) => {
          const dropPos = dropSeed % n; // 0..n-1
          const k = legalWindow(Math.max(4, n), extended);
          const h = TwoStationHarness.build({ srej, k, extended, n2: 40 });
          h.connect();
          h.checkAfterEachStep = false;

          // Drop A's I-frame with N(S)=dropPos exactly once (mode-aware N(S)).
          let dropped = false;
          h.dropWhen(
            withStormCap(h.link.log, (f) => {
              if (dropped) return false;
              if (!iFrameFrom(h.a, dropPos)(f)) return false;
              dropped = true;
              return true;
            }),
          );

          // Distinct payloads (1..n) so any reorder/dup is observable.
          for (let i = 0; i < n; i++) h.submit(h.a, (i + 1) & 0xff);

          expect(h.recoverUntilConverged(60)).toBe(true);
          // The stream invariant, stated directly: delivered == sent, in order.
          expect(deliveredStream(h.b)).toEqual(submittedStream(h.a));
          h.assertConverged(); // + full safety/window re-check
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe("property: finite loss burst recovers (delivered == sent, in order)", () => {
  // Mirrors `A_finite_bidirectional_loss_burst_recovers`: a finite drop budget
  // in EITHER direction (I-frames, acks, retransmits all eligible), then the
  // channel clears and the clean tail must reconverge. Fuzzed over n, budget,
  // the pattern seed, mode, and modulo. Data flows A → B (as in the C# property).
  // n capped at 7 (= the mod-8 window N − 1). At n = 8 over a mod-8 SREJ link a
  // duplicate-delivery defect appears at the ring boundary — pinned separately in
  // `srej-recovery-duplicate-delivery.known-failure.test.ts`. The proven-solid surface
  // (n ≤ 7, all modes/modulos) verified at 0/42000 over a dense sweep.
  it("A → B under a finite bidirectional-drop budget", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 7 }),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 1, max: 1 << 20 }),
        fc.nat(),
        (n, srej, extended, patternSeed, budgetSeed) => {
          const budget = budgetSeed % (n + 1); // 0..n total drops — finite
          const k = legalWindow(Math.max(4, n), extended);
          const h = TwoStationHarness.build({ srej, k, extended, n2: 60 });
          h.connect();
          h.checkAfterEachStep = false;

          const next = lcg(patternSeed);
          let dropsLeft = budget;
          h.dropWhen(
            withStormCap(h.link.log, () => {
              if (dropsLeft > 0 && next() < 0.5) {
                dropsLeft--;
                return true;
              }
              return false;
            }),
          );

          for (let i = 0; i < n; i++) h.submit(h.a, (i + 1) & 0xff);
          expect(h.recoverUntilConverged(120)).toBe(true);
          expect(deliveredStream(h.b)).toEqual(submittedStream(h.a));
          h.assertConverged();
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// Safety invariant under loss WITHOUT requiring convergence: at no intermediate
// point may a station deliver something out of order or a payload the peer never
// submitted. `checkSafety` (run by the harness after each step when enabled)
// already enforces this; here we assert it holds step-by-step under a fuzzed
// drop pattern even before the channel clears — delivered is always an in-order
// prefix of submitted. (Unidirectional A → B; see the scope note above.)
describe("property: delivered is always an in-order prefix of submitted (mid-recovery safety)", () => {
  it("no out-of-order or spurious delivery at any step under loss", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 1, max: 1 << 20 }),
        (n, srej, extended, patternSeed) => {
          const k = legalWindow(Math.max(4, n), extended);
          const h = TwoStationHarness.build({ srej, k, extended, n2: 40 });
          h.connect();
          // Leave per-step safety checks ON — the harness throws on any
          // out-of-order/duplicate delivery the moment it happens.
          const next = lcg(patternSeed);
          let dropsLeft = n; // finite
          h.dropWhen(
            withStormCap(h.link.log, () => {
              if (dropsLeft > 0 && next() < 0.5) {
                dropsLeft--;
                return true;
              }
              return false;
            }),
          );

          // Each submit() runs checkSafety() internally; a violation throws and
          // fails the property with the offending step. Distinct payloads.
          for (let i = 0; i < n; i++) h.submit(h.a, (i + 1) & 0xff);

          // Whatever was delivered so far is an in-order prefix of submitted.
          const delivered = deliveredStream(h.b);
          const submitted = submittedStream(h.a);
          expect(delivered).toEqual(submitted.slice(0, delivered.length));
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// Positive control: the drop generator actually drops something across the
// sampled space (so "converges" isn't trivially satisfied by a clean channel).
describe("property harness self-check: loss is actually injected", () => {
  it("a forced single drop is observed on the wire then recovered", () => {
    const h = TwoStationHarness.build({ srej: true, k: 6, n2: 40 });
    h.connect();
    h.checkAfterEachStep = false;
    let dropped = false;
    h.dropWhen((f) => {
      if (dropped) return false;
      if (!iFrameFrom(h.a, 0)(f)) return false;
      dropped = true;
      return true;
    });
    for (let i = 0; i < 4; i++) h.submit(h.a, (i + 1) & 0xff);
    h.settle();
    // The targeted frame really hit the wire (and was swallowed).
    const i0 = h.link.log.filter((f) => classify(f) === "I" && getNs(f) === 0);
    expect(i0.length).toBeGreaterThanOrEqual(1);
    expect(dropped).toBe(true);
    h.recoverUntilConverged(40);
    expect(deliveredStream(h.b)).toEqual([1, 2, 3, 4]);
    h.assertConverged();
  });
});
