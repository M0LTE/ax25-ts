/**
 * KNOWN FAILURE — *residual* duplicate-/non-delivery defects under SIMULTANEOUS
 * BIDIRECTIONAL data submission with SREJ, surfaced by the generative
 * loss-recovery tier (Workstream 2). The headline ring-wrap defect — the sender
 * replaying already-acked I-frames so a wrapped duplicate is re-delivered — is
 * FIXED (see below); what remains here are narrower, distinct cases.
 *
 * ## What was fixed (and is no longer pinned here)
 *
 * The headline finding was a mod-8 SREJ *ring-wrap* duplicate: A bursts ≥ 8
 * frames so V(S) wraps the 0–7 ring, one drops, and the receiver re-delivered
 * the wrapped retransmits (`[1..8, 1, 2]`). Root cause: the sender's SREJ
 * store-and-replay path replayed I-frames even after they were acknowledged.
 * Mirrored from the C# reference fix (M0LTE/packet.net#285): the selective-replay
 * verb (`pushOldIFrameNrOnQueue` → `emitOldIFrame(..., selectiveReplay=true)`)
 * now gates on the live send window `[V(a), V(s))` (`isOutstanding`) and to
 * once-per-recovery-cycle (`selectivelyRetransmittedSinceAck`, cleared on V(a)
 * advance), and the sent-frame store is pruned on every V(a) advance
 * (`pruneAcknowledgedSentIFrames`). The go-back-N `Invoke_Retransmission` replay
 * is left unguarded (genuine loss must still resend the window via T1). The
 * UNIDIRECTIONAL ring-wrap regression (n ≥ 8, both modulos, REJ + SREJ) and the
 * BIDIRECTIONAL go-back-N (REJ) wrapping burst now recover and are asserted green
 * in `loss-recovery.property.test.ts`.
 *
 * ## What is still pinned here — both are SIMULTANEOUS-bidirectional SREJ gaps
 *
 * Both residuals share a root: under SIMULTANEOUS bidirectional traffic with
 * SREJ, an incoming RR can drive one station's go-back-N `Invoke_Retransmission`
 * (or N(r) error recovery) which re-sends an outstanding tail; with SREJ the peer
 * has already selectively taken some of those frames, and at a wrapped mod-N
 * receive window it cannot disambiguate the re-sent copy from new data, so it
 * re-delivers (or the link fails to converge). The unguarded go-back-N path is
 * exactly the path #285 leaves alone (it must, for genuine loss), so this is a
 * separate, deeper recovery-sequencing defect — NOT a regression of the ring-wrap
 * fix, and NOT addressed by #285's selective-replay guards.
 *
 *   1. **Low-n (k = 4), shared with the C# reference.** mod-8 SREJ, k = 4, A
 *      submits one payload while B submits two, finite LCG(seed = 1) drop budget
 *      of 3 → A delivers B's two payloads twice (`[0x80, 0x81, 0x80, 0x81]`).
 *      Reproduced IDENTICALLY against the C# reference at the merged #285 commit
 *      with the same LCG — `Packet.Ax25` post-#285 produces the same duplicate.
 *      So this case fails the same on both sides: a shared, pre-existing
 *      limitation, not a TS divergence.
 *
 *   2. **Ring-wrap (n = k + 2), a TS-only divergence.** Both stations burst
 *      n = k + 2 frames simultaneously (each ring wraps) under a small drop
 *      budget. A rare (~0.1–0.2%) subset of patterns fails to converge at BOTH
 *      modulos. The pinned seeds below (mod-8: LCG(1828421821) budget 4; mod-128:
 *      LCG(4203678057) budget 4) are deterministic reproducers. UNLIKE case 1,
 *      the C# reference (post-#285) CONVERGES cleanly on these exact patterns —
 *      so this is a genuine TS-vs-C# recovery-sequencing divergence (TS enters
 *      go-back-N where C# stays in selective replay), beyond the #285 mirror.
 *
 * The C# `LossRecoveryProperties` never exercise simultaneous bidirectional
 * *data* ("bidirectional" there means bidirectional *drops*; every loss property
 * submits from A only — `for (i…) h.Submit(h.A, i)`), and the new #285
 * `Bidirectional_wrapping_bursts_recover` property's RANDOM patterns happen not to
 * hit case 2 — so neither residual is covered on the C# side either. Per
 * `CLAUDE.md`, runtime behaviour defers to the C# reference; pinning these (rather
 * than a speculative TS-only change to go-back-N / N(r)-recovery sequencing that
 * would risk diverging further) is the correct treatment. The fix belongs in a
 * focused follow-up (and, for case 1, in BOTH runtimes together).
 *
 * ## How these guards behave
 *
 * Each `it.fails` reproducer asserts the CORRECT (duplicate-free, converging)
 * behaviour: while the defect exists the assertion fails and `it.fails` keeps the
 * suite green; the moment a case is fixed, its `it.fails` flips RED — the tripwire
 * telling whoever fixes it to remove that case and fold it into
 * `loss-recovery.property.test.ts`. The companion `witnesses …` test documents
 * what the code does TODAY, so the exact failure is legible without reading the
 * SDL.
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

/** Run a simultaneous bidirectional WRAPPING burst (both stations submit n=k+2
 * frames before settling) under a finite LCG drop budget, then recover. Returns
 * the harness for the caller to assert on. The shape of case 2 above. */
function runBidirectionalWrappingBurst(
  extended: boolean,
  budget: number,
  patternSeed: number,
): TwoStationHarness {
  const k = extended ? 16 : 7;
  const n = k + 2;
  const h = TwoStationHarness.build({ srej: true, k, extended, n2: 80 });
  h.connect();
  h.checkAfterEachStep = false;
  h.dropWhen(finiteDrops(patternSeed, budget));
  for (let i = 0; i < n; i++) {
    const a = Uint8Array.from([(0x10 + i) & 0xff]);
    const b = Uint8Array.from([(0x80 + i) & 0xff]);
    h.a.submitted.push(a);
    h.a.driver.postEvent({ name: "DL_DATA_request", data: a, pid: 0xf0 });
    h.b.submitted.push(b);
    h.b.driver.postEvent({ name: "DL_DATA_request", data: b, pid: 0xf0 });
  }
  h.settle();
  h.recoverUntilConverged(200);
  return h;
}

describe("KNOWN FAILURE: simultaneous bidirectional SREJ recovery residuals (beyond #285)", () => {
  // ── Case 1: low-n (k=4), shared with the C# reference ──────────────────────
  // mod-8 SREJ, k=4, A submits 0x01 while B submits 0x80,0x81, LCG(1) budget 3.
  // A delivers [0x80,0x81,0x80,0x81] today. Reproduced identically against the C#
  // reference post-#285. `it.fails` passes WHILE the defect exists; turns RED when
  // fixed on both sides.
  it.fails(
    "case 1 (shared w/ C#): A↔B mod-8 SREJ nA=1 nB=2 (LCG 1, budget 3) — A must deliver B's stream once",
    () => {
      const h = TwoStationHarness.build({ srej: true, k: 4, extended: false, n2: 80 });
      h.connect();
      h.checkAfterEachStep = false;
      h.dropWhen(finiteDrops(1, 3));
      h.submit(h.a, 0x01);
      h.submit(h.b, 0x80);
      h.submit(h.b, 0x81);
      h.recoverUntilConverged(160);
      expect(h.a.delivered.map((d) => d[0])).toEqual([0x80, 0x81]);
      expect(h.b.delivered.map((d) => d[0])).toEqual([0x01]);
      h.assertConverged();
    },
  );

  it("case 1 witness: the low-n bidirectional duplicate (documents the defect)", () => {
    const h = TwoStationHarness.build({ srej: true, k: 4, extended: false, n2: 80 });
    h.connect();
    h.checkAfterEachStep = false;
    h.dropWhen(finiteDrops(1, 3));
    h.submit(h.a, 0x01);
    h.submit(h.b, 0x80);
    h.submit(h.b, 0x81);
    h.recoverUntilConverged(160);
    // Current (defective) outcome: B's two payloads delivered to A twice — the
    // SAME shape the C# reference produces post-#285.
    expect(h.a.delivered.map((d) => d[0])).toEqual([0x80, 0x81, 0x80, 0x81]);
    expect(h.a.delivered.length).toBeGreaterThan(h.b.submitted.length);
  });

  // ── Case 2: ring-wrap (n=k+2), a TS-only divergence (C# converges here) ─────
  // Both stations burst n=k+2 simultaneously under a small drop budget; a rare
  // subset of patterns fails to converge. The pinned seeds reproduce the failure
  // at each modulo. C# (post-#285) converges on these exact patterns. `it.fails`
  // flips RED when the TS recovery-sequencing divergence is closed.
  it.fails(
    "case 2 (TS-only; C# converges): mod-8 SREJ simultaneous wrap burst LCG(1828421821) budget 4 must converge",
    () => {
      const h = runBidirectionalWrappingBurst(false, 4, 1828421821);
      h.assertConverged();
    },
  );

  it.fails(
    "case 2 (TS-only; C# converges): mod-128 SREJ simultaneous wrap burst LCG(4203678057) budget 4 must converge",
    () => {
      const h = runBidirectionalWrappingBurst(true, 4, 4203678057);
      h.assertConverged();
    },
  );

  it("case 2 witness: the wrap burst over-delivers / fails to converge (documents the defect)", () => {
    const h = runBidirectionalWrappingBurst(false, 4, 1828421821);
    // Today this does NOT converge: more delivered than submitted (re-delivery)
    // and/or windows not empty. (C# delivers each of the 9 frames exactly once.)
    expect(h.converged()).toBe(false);
    expect(h.a.delivered.length).toBeGreaterThan(h.b.submitted.length);
  });
});
