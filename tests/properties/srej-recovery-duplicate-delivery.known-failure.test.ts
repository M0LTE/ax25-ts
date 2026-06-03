/**
 * KNOWN FAILURE — pinned regressions for a duplicate-delivery defect in mod-8
 * SREJ loss recovery, surfaced by the generative loss-recovery tier
 * (Workstream 2). The existing scenario / parametrized-loop suites never reached
 * it; fast-check did.
 *
 * ## The finding
 *
 * Over a **mod-8, SREJ** connected-mode link under a finite loss burst, a
 * receiver re-delivers already-delivered I-frames when the sender retransmits
 * frames at the mod-8 sequence-ring boundary (sending more than one window's
 * worth — n > k, where the mod-8 window is k ≤ 7). The retransmitted copies are
 * delivered a SECOND time, violating the duplicate-free / reliable-delivery
 * invariant (`InvariantChecker.checkReliableDelivery`: delivered must be an
 * in-order, gap-free, duplicate-free prefix of submitted).
 *
 * Two pinned, fully-deterministic reproducers:
 *
 *  1. **Unidirectional** (the minimal/core case): mod-8 SREJ, k = 7, A submits
 *     **8** payloads (`1..8`), finite LCG(seed = 5) drop budget of 7. B delivers
 *     **ten** frames — `[1,2,3,4,5,6,7,8,1,2]` — i.e. frames 1 and 2 are
 *     delivered twice. The link never reconverges (the duplicate is stable, not
 *     slow recovery — still failing at 800 recovery rounds).
 *  2. **Simultaneous bidirectional**: mod-8 SREJ, k = 4, A submits one payload
 *     while B submits two, finite LCG(seed = 1) drop budget of 3. A delivers B's
 *     two payloads twice — `[0x80,0x81,0x80,0x81]`.
 *
 * Boundary (dense sweep): the *only* failing unidirectional config is
 * `n = 8, srej = true, mod-8` (26/240 seed·budget combos). Every config with
 * n ≤ 7 (= the mod-8 window N − 1) is clean at **0/42000**; n = 8 with **REJ** is
 * clean; n = 8 at **mod-128** is clean (its 127-frame ring is nowhere near the
 * boundary). So the defect is specific to SREJ store-and-replay recovery crossing
 * the mod-8 sequence ring. Simultaneous bidirectional traffic hits the same defect
 * at much lower n (each direction's recovery interleaves), at ≈18% under finite
 * loss vs ≈2% for sequential bidirectional and 0% unidirectional n ≤ 7.
 *
 * Mechanism sketch: the receive-side `ax25Spec40` out-of-window discard guard
 * (`src/sdl/session-bindings.ts`) discards a duplicate whose N(S) is behind an
 * *already-advanced* V(R); the leak is the SREJ store-and-replay path delivering
 * a stored/retransmitted frame whose N(S) has wrapped the mod-8 ring before V(R)
 * advanced past it — so it is treated as a fresh in-window frame and delivered
 * again.
 *
 * ## Why these are pinned, not fixed
 *
 * 1. **Out of scope for a low-risk fix.** The defect is in the SDL recovery
 *    bindings / selective-reject store-and-replay semantics, which deliberately
 *    mirror the C# reference and the `ax25sdl` figures. The repo rule is that
 *    runtime behaviour defers to the C# reference (`CLAUDE.md`); a speculative
 *    TS-only change to recovery sequencing risks diverging from it.
 * 2. **Untested on BOTH sides — likely a shared defect.** The C#
 *    `LossRecoveryProperties` sweep n ∈ 1..6 only and submit from ONE station
 *    ("bidirectional" there = bidirectional *drops*, not bidirectional *data*),
 *    so neither suite reaches n = 8 mod-8 SREJ or simultaneous bidirectional
 *    traffic. Whether the C# reference exhibits the same duplicate is currently
 *    unknown — the mirror adversarial coverage in packet.net (Workstream 1)
 *    should extend its SREJ burst to n ≥ 8 and add simultaneous bidirectional
 *    traffic to find out, then fix both sides together.
 *
 * ## How these guards behave
 *
 * The `it.fails` reproducers assert the CORRECT (duplicate-free) behaviour: while
 * the defect exists the assertion fails and `it.fails` keeps the suite green; the
 * moment the defect is fixed, `it.fails` flips them RED — a deliberate tripwire
 * telling whoever fixes it to delete this file and raise the n cap in
 * `loss-recovery.property.test.ts` (and add the simultaneous-bidirectional
 * property back). The companion `witnesses …` tests assert what the code does
 * TODAY, so the exact duplicate is legible without reading the SDL.
 */
import { describe, expect, it } from "vitest";
import { TwoStationHarness } from "../conformance/two-station-harness.js";

/** Deterministic LCG → [0,1) — identical to the conformance suite's, so the
 * drop pattern replays exactly. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Build a finite drop filter from an LCG seed + budget (drops in either
 * direction until the budget is spent, then the channel is clean). */
function finiteDrops(seed: number, budget: number): () => boolean {
  const next = lcg(seed);
  let left = budget;
  return () => {
    if (left > 0 && next() < 0.5) {
      left--;
      return true;
    }
    return false;
  };
}

describe("KNOWN FAILURE: mod-8 SREJ recovery duplicates delivery at the sequence-ring boundary", () => {
  // ── Unidirectional (minimal/core) ─────────────────────────────────────────
  // mod-8 SREJ, k=7, A submits 8 frames, LCG(5) budget 7. B delivers
  // [1,2,3,4,5,6,7,8,1,2] today (frames 1 & 2 duplicated). `it.fails` passes
  // WHILE the defect exists; turns RED when fixed → remove this file and raise the
  // n cap in loss-recovery.property.test.ts.
  it.fails(
    "A→B mod-8 SREJ n=8 (LCG 5, budget 7): B must deliver 1..8 exactly once — duplicates 1,2 today",
    () => {
      const h = TwoStationHarness.build({ srej: true, k: 7, extended: false, n2: 80 });
      h.connect();
      h.checkAfterEachStep = false;
      h.dropWhen(finiteDrops(5, 7));
      for (let i = 0; i < 8; i++) h.submit(h.a, (i + 1) & 0xff);
      h.recoverUntilConverged(200);
      // CORRECT behaviour (fails today): each submitted frame delivered once.
      expect(h.b.delivered.map((d) => d[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      h.assertConverged();
    },
  );

  it("witnesses the unidirectional duplicate (documents the defect)", () => {
    const h = TwoStationHarness.build({ srej: true, k: 7, extended: false, n2: 80 });
    h.connect();
    h.checkAfterEachStep = false;
    h.dropWhen(finiteDrops(5, 7));
    for (let i = 0; i < 8; i++) h.submit(h.a, (i + 1) & 0xff);
    h.recoverUntilConverged(200);
    // Current (defective) outcome: frames 1 and 2 are delivered a second time.
    expect(h.b.delivered.map((d) => d[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 1, 2]);
    expect(h.b.delivered.length).toBeGreaterThan(h.a.submitted.length);
  });

  // ── Simultaneous bidirectional (same defect, lower n) ──────────────────────
  it.fails(
    "A↔B mod-8 SREJ nA=1 nB=2 (LCG 1, budget 3): A must deliver B's stream once — duplicates today",
    () => {
      const h = TwoStationHarness.build({ srej: true, k: 4, extended: false, n2: 80 });
      h.connect();
      h.checkAfterEachStep = false;
      h.dropWhen(finiteDrops(1, 3));
      // Simultaneous bidirectional submission. A: 0x01 ; B: 0x80, 0x81.
      h.submit(h.a, 0x01);
      h.submit(h.b, 0x80);
      h.submit(h.b, 0x81);
      h.recoverUntilConverged(160);
      expect(h.a.delivered.map((d) => d[0])).toEqual([0x80, 0x81]);
      expect(h.b.delivered.map((d) => d[0])).toEqual([0x01]);
      h.assertConverged();
    },
  );

  it("witnesses the bidirectional duplicate (documents the defect)", () => {
    const h = TwoStationHarness.build({ srej: true, k: 4, extended: false, n2: 80 });
    h.connect();
    h.checkAfterEachStep = false;
    h.dropWhen(finiteDrops(1, 3));
    h.submit(h.a, 0x01);
    h.submit(h.b, 0x80);
    h.submit(h.b, 0x81);
    h.recoverUntilConverged(160);
    // Current (defective) outcome: B's two payloads delivered to A twice.
    expect(h.a.delivered.map((d) => d[0])).toEqual([0x80, 0x81, 0x80, 0x81]);
    expect(h.a.delivered.length).toBeGreaterThan(h.b.submitted.length);
  });
});
