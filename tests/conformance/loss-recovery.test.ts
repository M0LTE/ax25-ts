/**
 * Loss-recovery conformance — the TypeScript port of packet.net's
 * `LossRecoveryProperties` (`tests/Packet.Ax25.Tests/Session/Conformance/`).
 * Adversarial generative testing over the {@link TwoStationHarness}: a loss
 * pattern is generated, the run is driven over a lossy in-process link, and the
 * {@link InvariantChecker} oracle judges convergence. A failure is a
 * reproducible counterexample (the seed prints in the test name).
 *
 * ## Property-testing approach — seeded parametrized loops (no fast-check)
 *
 * packet.net uses FsCheck (`[Property(MaxTest = …)]`, generating `seedN`,
 * `seedDrop`, `srej`, …). ax25-ts has no property-testing library on its
 * dependency tree (checked `package.json` — no `fast-check`), and this suite
 * may only touch files under `tests/conformance/`, so adding one is out of
 * scope. We reproduce FsCheck's coverage with deterministic parametrized
 * `it`-loops over an enumerated seed space — the same `seedN`/`seedDrop`/`srej`
 * tuples FsCheck would draw, swept exhaustively over the small bounded ranges
 * (n ∈ 1..6, dropPos ∈ 0..n-1, both REJ and SREJ). Each case is its own `it`,
 * so a failure names the exact seed and the run stays a pure function of it —
 * the determinism FsCheck shrinking would rely on, without the dependency.
 *
 * ## What runs — the full recovery runtime is live
 *
 * The harness loss *infrastructure* (drop filter + `advanceT1`) is exercised
 * and self-verified here. Single-frame **SREJ** selective recovery (figc4.4
 * `Push Old I Frame N(r) on Queue`) runs end-to-end over a real SREJ frame on
 * the wire (the SREJ factory + `Select_T1` un-stub landed in this PR; the
 * harness also gives each station its own timer scheduler so one station's
 * `Stop T1` no longer cancels the other's pending T1). The DEEP recovery
 * properties — timeout-driven go-back-N reached purely by `advanceT1()`
 * (figc4.5/4.7 `Transmit_Enquiry` → `Invoke_Retransmission`), multi-frame
 * bursts, and the SREJ recovery quirks (`Ax25Spec40/41/42`) — now converge and
 * run unconditionally. The whole single-drop sweep (n ∈ 1..6, both modes) and
 * the whole bidirectional burst sweep converge; the named SREJ-quirk
 * regressions converge with the quirks on and livelock with them off (faithful
 * preset), which is what proves the quirks are load-bearing.
 */
import { describe, expect, it } from "vitest";
import { classify, getNs, type Ax25Frame } from "../../src/frame.js";
import { iFrameFrom, TwoStationHarness } from "./two-station-harness.js";

/** Non-negative modulo, overflow-safe — the TS port of packet.net's `Mod`. */
function mod(v: number, m: number): number {
  return ((v % m) + m) % m;
}

/** A one-shot drop latch: drops the first frame matching `match`, then never
 * again (the channel is clean once the single drop is consumed). Mirrors the
 * `dropped` flag in packet.net's single-drop property. */
function dropOnce(match: (f: Ax25Frame) => boolean): (f: Ax25Frame) => boolean {
  let done = false;
  return (f) => {
    if (done) return false;
    if (!match(f)) return false;
    done = true;
    return true;
  };
}

// ─── Harness loss infrastructure (self-verified — runs today) ──────────────

describe("loss-recovery — harness infrastructure", () => {
  it("the drop filter drops exactly the targeted I-frame (and still logs it)", () => {
    const h = TwoStationHarness.build({ k: 4 });
    h.connect();
    h.checkAfterEachStep = false; // a dropped frame is an intentional gap

    // Drop A's I-frame N(s)=0, once.
    h.dropWhen(dropOnce(iFrameFrom(h.a, 0)));
    h.submit(h.a, 0xa0);

    // It was put on the wire (logged) but never delivered to B.
    const i0OnWire = h.link.log.filter(
      (f) => classify(f) === "I" && getNs(f) === 0,
    );
    expect(i0OnWire.length).toBe(1); // A transmitted it…
    expect(h.b.delivered.length).toBe(0); // …but the link swallowed it.
  });

  it("a frame NOT matched by the drop filter is delivered normally", () => {
    const h = TwoStationHarness.build({ k: 4 });
    h.connect();
    // Filter targets N(s)=5, which never occurs in a single submit → no drop.
    h.dropWhen(iFrameFrom(h.a, 5));
    h.submit(h.a, 0xc7);
    expect(h.b.delivered.map((d) => d[0])).toEqual([0xc7]);
    h.assertConverged();
  });

  it("advanceT1() fires the live T1 timeout — Connected drops to TimerRecovery", () => {
    const h = TwoStationHarness.build({ k: 4 });
    h.connect();
    h.checkAfterEachStep = false;

    // Swallow A's only I-frame so its ack never comes back; T1 is now the only
    // thing that can fire.
    h.dropWhen(dropOnce(iFrameFrom(h.a, 0)));
    h.submit(h.a, 0xa0);
    expect(h.scheduler.isRunning("T1")).toBe(true); // T1 armed, awaiting ack
    expect(h.a.state).toBe("Connected");

    // Crossing T1 must fire the timeout: figc4.x takes Connected → TimerRecovery
    // on T1-expiry, where `Transmit_Enquiry` re-polls and the peer's response
    // drives `Invoke_Retransmission`. (The deep properties below exercise that
    // full cascade; here we just assert the timeout fires and parks A in
    // TimerRecovery — the hook the recovery properties hang on.)
    h.advanceT1();
    expect(h.a.state).toBe("TimerRecovery");
  });

  it("recoverUntilConverged returns true immediately on an already-clean link", () => {
    const h = TwoStationHarness.build({ k: 4 });
    h.connect();
    h.submit(h.a, 0x01);
    // No loss → already converged; the loop should not need a single round.
    expect(h.converged()).toBe(true);
    expect(h.recoverUntilConverged(40)).toBe(true);
  });
});

// ─── Single dropped I-frame — SREJ selective recovery (real SREJ wire) ─────
//
// packet.net's `A_single_dropped_iframe_always_recovers` over the natural wire
// path: drop A's frame 0 once; frame 1 arrives out of sequence at B, which now
// emits a real SREJ supervisory frame requesting the gap N(r)=0 (the SREJ
// factory landed). A's figc4.4 `Push Old I Frame N(r) on Queue` selectively
// retransmits ONLY frame 0 with its ORIGINAL N(s) (M0LTE/ax25-ts#8 /
// packet.net#231 — single-frame, not go-back-N); B fills the gap, retrieves the
// stored frame 1, and delivers both in order. No injected trigger — the SREJ
// flows on the wire end-to-end.

describe("loss-recovery — single dropped I-frame recovers (SREJ, selective)", () => {
  // Two distinct submit-byte patterns × dropping the first frame: a small
  // deterministic sweep standing in for the FsCheck `seedDrop` draw.
  for (const payloads of [
    [0xa0, 0xa1],
    [0x11, 0x22],
  ]) {
    it(`drop N(s)=0, B SREJs the gap, A selectively retransmits [${payloads.map((b) => b.toString(16)).join(",")}]`, () => {
      const h = TwoStationHarness.build({ srej: true, k: 4 });
      h.connect();
      h.checkAfterEachStep = false;

      // Drop A's frame 0 once; frame 1 arrives out of sequence → B sends SREJ(0).
      h.dropWhen(dropOnce(iFrameFrom(h.a, 0)));
      for (const b of payloads) h.submit(h.a, b);
      h.settle();

      // B's SREJ on the wire is a real selective reject — assert exactly one was
      // sent (single-frame selective recovery, not a REJ go-back-N storm).
      const srejs = h.link.log.filter((f) => classify(f) === "SREJ");
      expect(srejs.length).toBe(1);
      expect(h.b.delivered.map((d) => d[0])).toEqual(payloads);
      expect(h.a.context.vs).toBe(payloads.length); // no renumbering (#231)
      h.assertConverged();
    });
  }
});

// ─── Deep recovery properties — the heavy-loss acceptance gate ─────────────
//
// Ported from packet.net's `LossRecoveryProperties`. These exercise the full
// timeout-driven recovery runtime (figc4.5/4.7 `Transmit_Enquiry` →
// `Invoke_Retransmission` emitting real go-back-N retransmits), real SREJ on
// the wire, and the SREJ recovery quirks `Ax25Spec40/41/42`. Three things had
// to land before they converge: (1) each station gets its OWN timer scheduler
// in the harness (a shared one let B's `Stop T1` cancel A's pending T1, which
// silently killed every timeout-driven recovery); (2) the SREJ supervisory
// frame factory (B now SREJs the gap instead of falling back to REJ, which
// activates Ax25Spec40/42); (3) `Select_T1` is no longer a dispatcher no-op
// (it routes through the figc4.7 subroutine; in the harness T1V is frozen, so
// SRT/T1V stay put, but the verb chain — RC bookkeeping etc. — runs).
//
// Liveness watchdog: every drive method ultimately runs the synchronous
// settle pump, which throws after 256 non-converging round-trips. To turn a
// would-be runaway (a future regression that keeps the channel busy forever)
// into a fast, named failure rather than a worker hang, each property also
// installs a hard wire-length cap inside its drop filter — a storm trips it
// long before the run gets slow.

/** Hard ceiling on frames-on-wire for one property run. A converging scenario
 * settles in well under this; tripping it means a storm — fail fast (and
 * loud) instead of letting the synchronous pump grind. */
const WIRE_STORM_CAP = 4000;

/**
 * Wrap a drop predicate so it throws the moment the wire blows past
 * {@link WIRE_STORM_CAP} — converting a non-converging storm (which would
 * otherwise spin the synchronous pump) into an immediate, attributable
 * failure. `log` is the harness's wire log.
 */
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

/** Deterministic LCG → [0,1). The drop pattern is a pure function of its seed
 * (no Math.random — the run must be replayable, like the C# `Random`). */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("loss-recovery — deep recovery properties", () => {
  // FsCheck seed space, swept exhaustively over the bounded ranges the C#
  // `[Property]` draws: n ∈ 1..6 I-frames, dropPos ∈ 0..n-1, both REJ and SREJ.
  const singleDropSeeds: { n: number; dropPos: number; srej: boolean }[] = [];
  for (let seedN = 0; seedN < 6; seedN++) {
    const n = 1 + seedN; // 1..6
    for (let dropPos = 0; dropPos < n; dropPos++) {
      for (const srej of [false, true]) {
        singleDropSeeds.push({ n, dropPos, srej });
      }
    }
  }

  // Port of `A_single_dropped_iframe_always_recovers` — reaching recovery
  // purely through `advanceT1()` (no injected trigger): connect, submit n
  // frames, drop the one with N(s)=dropPos once, then drive T1 recovery until
  // the link converges. Both modes converge: SREJ does single-frame selective
  // retransmit of the gap; REJ does timeout-driven go-back-N.
  for (const { n, dropPos, srej } of singleDropSeeds) {
    const mode = srej ? "SREJ" : "REJ";
    it(`single dropped I-frame always recovers [n=${n} drop=N(s)${dropPos} ${mode}]`, () => {
      const k = Math.max(4, n);
      const h = TwoStationHarness.build({ srej, k });
      h.connect();
      h.checkAfterEachStep = false;

      const dropper = dropOnce(iFrameFrom(h.a, dropPos));
      h.dropWhen(withStormCap(h.link.log, dropper));
      for (let i = 0; i < n; i++) h.submit(h.a, i);

      // Channel is clean once the single drop is consumed; drive T1 recovery
      // until convergence (bounded — non-convergence is the bug we hunt).
      h.recoverUntilConverged(40);
      h.assertConverged();
    });
  }

  // Port of `A_finite_bidirectional_loss_burst_recovers`. A finite budget of
  // drops in EITHER direction (lost I-frames, acks, retransmits), then the
  // channel clears; recovery must complete on the clean tail. Exercises the
  // full recovery runtime + the SREJ quirks (the C# comment cites #242/#241/
  // #246 for the SREJ sweep). Seeds sweep n, budget, a pattern RNG seed, both
  // modes.
  const burstSeeds: {
    n: number;
    budget: number;
    pattern: number;
    srej: boolean;
  }[] = [];
  for (let seedN = 0; seedN < 6; seedN++) {
    const n = 1 + seedN; // 1..6
    for (let seedBudget = 0; seedBudget <= n; seedBudget++) {
      const budget = mod(seedBudget, n + 1); // 0..n total drops — finite
      for (const pattern of [1, 2, 7]) {
        for (const srej of [false, true]) {
          burstSeeds.push({ n, budget, pattern, srej });
        }
      }
    }
  }

  for (const { n, budget, pattern, srej } of burstSeeds) {
    const mode = srej ? "SREJ" : "REJ";
    it(`finite bidirectional loss burst recovers [n=${n} budget=${budget} pat=${pattern} ${mode}]`, () => {
      const k = Math.max(4, n);
      // N2 generous so the link doesn't give up before the finite loss clears.
      const h = TwoStationHarness.build({ srej, k, n2: 40 });
      h.connect();
      h.checkAfterEachStep = false;

      const next = lcg(pattern);
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

      for (let i = 0; i < n; i++) h.submit(h.a, i);
      h.recoverUntilConverged(80);
      h.assertConverged();
    });
  }

  // Regression for the ax25spec#40 SREJ livelock (packet.net#242): a multi-frame
  // bidirectional SREJ burst used to spin to the pump's bound (B SREJ'd
  // out-of-window duplicates, A re-sent, repeat). With Ax25Spec40 (window guard)
  // on, B discards out-of-window frames instead, so a moderate SREJ burst
  // converges. Port of `Srej_bidirectional_loss_burst_recovers_with_window_guard`.
  it("SREJ bidirectional loss burst recovers with window guard (ax25spec#40 / #242)", () => {
    const h = TwoStationHarness.build({ srej: true, k: 6, n2: 40 });
    h.connect();
    h.checkAfterEachStep = false;
    const next = lcg(2);
    let dropsLeft = 2;
    h.dropWhen(
      withStormCap(h.link.log, () => {
        if (dropsLeft > 0 && next() < 0.5) {
          dropsLeft--;
          return true;
        }
        return false;
      }),
    );
    for (let i = 0; i < 6; i++) h.submit(h.a, i);
    h.recoverUntilConverged(60);
    h.assertConverged();
  });

  // Convergence regression for the full SREJ recovery stack (packet.net#241/#242/
  // #246): a heavy burst needs the window guard (Ax25Spec40), the SRT overflow
  // guard (Ax25Spec41), and Ax25Spec42 (SREJ targets the gap V(R), not the
  // just-arrived frame). Port of `Srej_heavy_bidirectional_loss_burst_recovers`.
  it("SREJ heavy bidirectional loss burst recovers (ax25spec#40/#41/#42)", () => {
    const h = TwoStationHarness.build({ srej: true, k: 6, n2: 40 });
    h.connect();
    h.checkAfterEachStep = false;
    const next = lcg(2);
    let dropsLeft = 5;
    h.dropWhen(
      withStormCap(h.link.log, () => {
        if (dropsLeft > 0 && next() < 0.5) {
          dropsLeft--;
          return true;
        }
        return false;
      }),
    );
    for (let i = 0; i < 6; i++) h.submit(h.a, i);
    h.recoverUntilConverged(60);
    h.assertConverged();
  });
});
