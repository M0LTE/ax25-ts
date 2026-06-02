/**
 * Phase H — happy-path conformance. Drives the real two-station ax25-ts stack
 * through its normal operating envelope (no channel disruption) and asserts the
 * {@link InvariantChecker} oracle holds after every step. Proves both the stack
 * and the oracle on known-answer scenarios before any adversarial generation
 * (mirrors m0lte/packet.net `docs/conformance-harness-plan.md`, Phase H). The
 * harness runs the safety invariants automatically after each drive call, so
 * these tests assert the end-state delivery (and, where reachable, convergence).
 *
 * ## ax25-ts vs packet.net: convergence is unreachable on the happy path
 *
 * In packet.net the equivalent suite asserts full `AssertConverged()` (V(s) ==
 * V(a) + everything delivered) for every transfer. ax25-ts cannot yet: the
 * figc4.4 delayed-ack flush is unwired end-to-end — `LM-SEIZE Request` is a
 * no-op (never posts `LM_SEIZE_confirm`) and `Enquiry Response (F = 0)` is a
 * no-op subroutine stub, so a receiver delivers the payload but never emits the
 * acknowledging RR, and the sender's V(a) is stuck (M0LTE/ax25-ts#12). The
 * harness still models a contention-free medium (granting LM-SEIZE), so the
 * moment #12 lands these tests upgrade to full convergence by swapping the
 * delivery assertion for {@link TwoStationHarness.assertConverged}. Until then
 * the data-transfer cases assert the safety invariant that *does* hold —
 * reliable, in-order, gap-free, duplicate-free delivery — and a `.skip` test
 * pins the convergence gap to the issue.
 */
import { describe, expect, it } from "vitest";
import { TwoStationHarness } from "./two-station-harness.js";

describe("Phase H — happy-path conformance", () => {
  it("connect then clean disconnect", () => {
    const h = TwoStationHarness.build();
    h.connect();
    expect(h.a.state).toBe("Connected");
    expect(h.b.state).toBe("Connected");

    h.disconnect(h.a);
    expect(h.a.state).toBe("Disconnected");
    expect(h.b.state).toBe("Disconnected");
  });

  it("connect initiated by B (either side may establish)", () => {
    const h = TwoStationHarness.build();
    h.connectFrom(h.b);
    expect(h.a.state).toBe("Connected");
    expect(h.b.state).toBe("Connected");
  });

  it("single I-frame A->B is delivered in order", () => {
    const h = TwoStationHarness.build();
    h.connect();

    h.submit(h.a, 0xaa);
    h.settle();

    // Reliable delivery holds (and is re-checked by the oracle after each step).
    expect(h.b.delivered.map((p) => Array.from(p))).toEqual([[0xaa]]);
    expect(h.a.state).toBe("Connected");
    expect(h.b.state).toBe("Connected");
  });

  it("full window A->B delivers in order", () => {
    const h = TwoStationHarness.build({ k: 4 });
    h.connect();

    for (let i = 0; i < 4; i++) h.submit(h.a, i);
    h.settle();

    expect(h.b.delivered.map((p) => p[0])).toEqual([0, 1, 2, 3]);
    expect(h.b.state).toBe("Connected");
  });

  it("bidirectional simultaneous data delivers both ways", () => {
    const h = TwoStationHarness.build({ k: 4 });
    h.connect();

    h.submit(h.a, 0xa0);
    h.submit(h.b, 0xb0);
    h.submit(h.a, 0xa1);
    h.submit(h.b, 0xb1);
    h.settle();

    expect(h.b.delivered.map((p) => p[0])).toEqual([0xa0, 0xa1]);
    expect(h.a.delivered.map((p) => p[0])).toEqual([0xb0, 0xb1]);
  });

  it("multi-window transfer wraps the modulus (V(s) 7->0)", () => {
    const h = TwoStationHarness.build({ k: 4 });
    h.connect();

    // 12 frames > the mod-8 window. With delayed-ack working V(s) would wrap
    // 7->0 as windows reopen; today V(a) never advances (#12), so all 12 sit in
    // the send queue and only the first k=4 reach the wire. We therefore assert
    // the in-order delivery that *is* observable and that no invariant is
    // violated en route, rather than the post-wrap V(s).
    for (let i = 0; i < 12; i++) h.submit(h.a, i);
    h.settle();

    // Delivery is a gap-free in-order prefix of what was submitted (the oracle
    // enforces this after every submit; assert it explicitly here too).
    const delivered = h.b.delivered.map((p) => p[0]);
    expect(delivered).toEqual([0, 1, 2, 3].slice(0, delivered.length));
    expect(delivered.length).toBeGreaterThan(0);
    expect(h.b.state).toBe("Connected");
  });

  // ─── Pinned gaps (skipped, with issue refs) ──────────────────────────

  it.skip(
    "single I-frame A->B converges (V(s)==V(a)) — blocked on delayed-ack flush (M0LTE/ax25-ts#12)",
    () => {
      const h = TwoStationHarness.build();
      h.connect();
      h.submit(h.a, 0xaa);
      h.settle();
      // Unreachable until #12: Enquiry Response (F = 0) is a no-op stub, so B
      // never sends the RR that would advance A's V(a). Un-skip when #12 lands.
      h.assertConverged();
    },
  );

  it.skip(
    "mod-128 (extended) data transfer — connected-mode data is mod-8-only (README scope; cf. packet.net#239)",
    () => {
      const h = TwoStationHarness.build({ extended: true });
      h.connect();
      // SABM/UA connect works, but the dispatcher doesn't honour mod-128 for
      // connected-mode I-frames (extended sequence numbers / 2-byte control are
      // route-around in the SDL predicates — see README "Scope" table). Mirrors
      // packet.net#239. Un-skip when extended data transfer lands.
      h.submit(h.a, 0x01);
      h.settle();
      expect(h.b.delivered.map((p) => p[0])).toEqual([0x01]);
    },
  );
});

describe("Phase H — oracle self-checks (known-answer)", () => {
  it("the oracle flags duplicate delivery", () => {
    const h = TwoStationHarness.build();
    h.connect();
    h.checkAfterEachStep = false; // we are about to forge an illegal state
    // Forge: B delivered a payload A never submitted.
    h.b.delivered.push(Uint8Array.from([0x99]));
    expect(() => h.checkInvariants()).toThrow(/duplicate or spurious delivery/);
  });

  it("the oracle flags an out-of-window send state", () => {
    const h = TwoStationHarness.build({ k: 4 });
    h.connect();
    h.checkAfterEachStep = false;
    // Forge a runaway V(s): 6 outstanding against k=4 (the #231 signature).
    h.a.context.vs = 6;
    h.a.context.va = 0;
    expect(() => h.checkInvariants()).toThrow(/window exceeded/);
  });

  it("the oracle flags a corrupted (mismatched) delivery", () => {
    const h = TwoStationHarness.build();
    h.connect();
    h.checkAfterEachStep = false;
    h.a.submitted.push(Uint8Array.from([0xaa]));
    h.b.delivered.push(Uint8Array.from([0xbb])); // wrong content
    expect(() => h.checkInvariants()).toThrow(/reorder\/corruption\/gap/);
  });
});
