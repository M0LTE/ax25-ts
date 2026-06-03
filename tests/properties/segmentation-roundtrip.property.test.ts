/**
 * Property: §6.6 segmentation round-trip (`src/sdl/segmenter.ts` +
 * `src/sdl/segmentation-layer.ts`). For a random payload and a random N1, the
 * segment → reassemble cycle is the identity, in BOTH wire formats:
 *
 *  - **figure-literal** (Figure 6.2 as drawn — no inner PID): segments are
 *    `[F/X octet][data…]`; a reassembled payload carries no original L3 PID and
 *    is delivered as {@link PID_NO_LAYER_3} by {@link SegmentationLayer}.
 *  - **inner-PID** (Dire Wolf de-facto, the `segmentFirstCarriesL3Pid` quirk —
 *    default on): the first segment carries the original L3 PID after the F/X
 *    octet; the reassembler recovers it and the layer delivers the reassembled
 *    payload with that **original L3 PID**.
 *
 * The TS analogue of packet.net's `Segmenter`/`Reassembler` +
 * `SegmentationLayer` property coverage (#273 7-bit count fix, #279 inner-PID
 * format), generalising the example-pinned `segmenter.test.ts` /
 * `segmentation-layer.test.ts` across the (payload, N1) space. We assert the
 * original L3 PID is recovered under the quirk — the load-bearing claim of #279.
 *
 * Segment-count budget (Figure 6.2's 7-bit remaining-count → ≤128 segments):
 * the generators stay inside the budget by construction (an over-budget payload
 * is a `RangeError` *by design* — covered by the existing scenario tests, not
 * this identity property).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Callsign } from "../../src/callsign.js";
import { PID_NET_ROM, PID_NO_LAYER_3, PID_SEGMENTED } from "../../src/frame.js";
import {
  Reassembler,
  SEGMENT_FIRST_BIT,
  SEGMENT_MAX_SEGMENTS,
  segment,
} from "../../src/sdl/segmenter.js";
import { SegmentationLayer } from "../../src/sdl/segmentation-layer.js";
import { createSessionContext } from "../../src/sdl/session-context.js";
import {
  defaultSessionQuirks,
  strictlyFaithfulSessionQuirks,
} from "../../src/sdl/session-quirks.js";

const RUNS = 2000;

/** Any PID value an upper layer might tag a payload with. */
const pidArb = fc.integer({ min: 0, max: 255 });

/**
 * A (payload, N1) pair guaranteed inside the ≤128-segment budget for the given
 * format. We pick N1 first, then bound the payload length to the max that fits:
 *   - figure-literal: ceil(len / (N1−1)) ≤ 128  ⇒  len ≤ 128·(N1−1)
 *   - inner-PID:      ceil((len+1) / (N1−1)) ≤ 128 ⇒ len ≤ 128·(N1−1) − 1
 * N1 is capped modestly so the payload bound stays test-sized while still
 * forcing many segments at small N1.
 */
function payloadAndN1(innerPid: boolean): fc.Arbitrary<{ payload: Uint8Array; n1: number }> {
  const minN1 = innerPid ? 3 : 2;
  return fc.integer({ min: minN1, max: 40 }).chain((n1) => {
    const perSegment = n1 - 1;
    const hardMax = SEGMENT_MAX_SEGMENTS * perSegment - (innerPid ? 1 : 0);
    const maxLen = Math.min(hardMax, 1500); // keep test payloads bounded
    return fc
      .uint8Array({ minLength: 0, maxLength: maxLen })
      .map((payload) => ({ payload, n1 }));
  });
}

describe("property: segmenter ⇄ reassembler round-trip (figure-literal)", () => {
  it("segment(payload, N1) then reassemble equals payload", () => {
    fc.assert(
      fc.property(payloadAndN1(false), ({ payload, n1 }) => {
        const segs = segment(payload, n1);
        expect(segs.length).toBeGreaterThanOrEqual(1);
        expect(segs.length).toBeLessThanOrEqual(SEGMENT_MAX_SEGMENTS);
        // The first segment sets the First bit; the rest don't.
        expect((segs[0]![0]! & SEGMENT_FIRST_BIT) !== 0).toBe(true);

        const re = new Reassembler(false);
        let out: Uint8Array | null = null;
        for (const s of segs) out = re.push(s);
        expect(out).not.toBeNull();
        expect(Array.from(out!)).toEqual(Array.from(payload));
        // Figure-literal carries no inner PID.
        expect(re.lastRecoveredPid).toBeNull();
      }),
      { numRuns: RUNS },
    );
  });
});

describe("property: segmenter ⇄ reassembler round-trip (inner-PID / Dire Wolf)", () => {
  it("segment(payload, N1, pid) round-trips payload AND recovers the L3 PID", () => {
    fc.assert(
      fc.property(payloadAndN1(true), pidArb, ({ payload, n1 }, pid) => {
        const segs = segment(payload, n1, pid);
        expect(segs.length).toBeGreaterThanOrEqual(1);
        expect(segs.length).toBeLessThanOrEqual(SEGMENT_MAX_SEGMENTS);
        // The first segment's inner-PID octet is at index 1 (after the F/X byte).
        expect(segs[0]!.length).toBeGreaterThanOrEqual(2);
        expect(segs[0]![1]).toBe(pid & 0xff);

        const re = new Reassembler(true);
        let out: Uint8Array | null = null;
        for (const s of segs) out = re.push(s);
        expect(out).not.toBeNull();
        expect(Array.from(out!)).toEqual(Array.from(payload));
        // The load-bearing #279 claim: the original L3 PID is recovered.
        expect(re.lastRecoveredPid).toBe(pid & 0xff);
      }),
      { numRuns: RUNS },
    );
  });
});

// ─── End-to-end through the SegmentationLayer (the session boundary) ────────
//
// buildSendRequests → onDataIndication is the actual send/receive seam a session
// uses. Each emitted DL-DATA-request's `data` is a segment info field with PID
// 0x08; feeding them back as DL-DATA-indications drives the reassembler and the
// final delivery carries the correct PID per the active quirk.

function makeLayer(quirks: typeof defaultSessionQuirks, n1: number): SegmentationLayer {
  const ctx = createSessionContext(new Callsign("M0LTE", 1), new Callsign("G7XYZ", 2));
  ctx.n1 = n1;
  ctx.segmenterReassemblerEnabled = true;
  ctx.quirks = { ...quirks };
  return new SegmentationLayer(ctx);
}

/** Drive send→receive through two independent layers (sender + receiver) over
 * the same N1/quirks, returning the single reassembled indication. A payload
 * that fits in one frame is delivered unchanged (no segment PID). */
function sendReceive(
  quirks: typeof defaultSessionQuirks,
  n1: number,
  payload: Uint8Array,
  pid: number,
): { data: Uint8Array; pid: number } {
  const sender = makeLayer(quirks, n1);
  const receiver = makeLayer(quirks, n1);
  const requests = sender.buildSendRequests(payload, pid);
  const delivered: { data: Uint8Array; pid: number }[] = [];
  for (const req of requests) {
    // buildSendRequests emits DL_DATA_request events; on the wire each becomes
    // an I-frame whose info+PID arrive as a DL_DATA_indication. Mirror that.
    if (req.name !== "DL_DATA_request") throw new Error("unexpected event");
    const ind = receiver.onDataIndication({
      type: "DL_DATA_indication",
      data: req.data!,
      pid: req.pid!,
    });
    if (ind !== null) delivered.push({ data: ind.data, pid: ind.pid });
  }
  expect(delivered.length).toBe(1); // exactly one logical payload delivered
  return delivered[0]!;
}

describe("property: SegmentationLayer send→receive identity + PID delivery", () => {
  // Only payloads that exceed N1 actually segment; smaller ones pass through.
  // Generate across the boundary so both paths are covered.
  it("inner-PID quirk ON (default): payload identity + original L3 PID delivered", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 40 }),
        fc.uint8Array({ minLength: 0, maxLength: 1500 }),
        fc.constantFrom(PID_NO_LAYER_3, PID_NET_ROM, 0x01, 0xcc),
        (n1, payload, pid) => {
          // Stay inside the segment budget for the inner-PID format.
          fc.pre(payload.length + 1 <= SEGMENT_MAX_SEGMENTS * (n1 - 1));
          const got = sendReceive(defaultSessionQuirks, n1, payload, pid);
          expect(Array.from(got.data)).toEqual(Array.from(payload));
          // Quirk on → the original PID survives the segmented series.
          expect(got.pid).toBe(pid);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("inner-PID quirk OFF (strictlyFaithful): payload identity, reassembled PID = 0xF0", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 40 }),
        fc.uint8Array({ minLength: 0, maxLength: 1500 }),
        fc.constantFrom(PID_NO_LAYER_3, PID_NET_ROM, 0x01, 0xcc),
        (n1, payload, pid) => {
          fc.pre(payload.length <= SEGMENT_MAX_SEGMENTS * (n1 - 1));
          const got = sendReceive(strictlyFaithfulSessionQuirks, n1, payload, pid);
          expect(Array.from(got.data)).toEqual(Array.from(payload));
          // Figure-literal: a *segmented* payload loses its PID and is delivered
          // as PID_NO_LAYER_3. A payload that fit in one frame passes through
          // with its original PID (no segmentation happened).
          const wasSegmented = payload.length > n1;
          expect(got.pid).toBe(
            wasSegmented ? SegmentationLayer.figureLiteralReassembledPid : pid,
          );
          expect(SegmentationLayer.figureLiteralReassembledPid).toBe(PID_NO_LAYER_3);
        },
      ),
      { numRuns: RUNS },
    );
  });

  // A payload that fits within N1 is never segmented — it passes through with
  // its original PID under either quirk (the pass-through ceiling is N1 itself).
  it("a within-N1 payload passes through unsegmented with its PID (both quirks)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 40 }),
        // Exclude 0x08 so the pass-through PID is distinguishable from a segment
        // marker — a pass-through frame keeps the upper layer's PID, which could
        // otherwise legitimately *be* 0x08.
        pidArb.filter((p) => p !== PID_SEGMENTED),
        (n1, pid) => {
          const payload = Uint8Array.from(
            Array.from({ length: n1 }, (_, i) => i & 0xff),
          ); // exactly N1 bytes → fits
          for (const quirks of [defaultSessionQuirks, strictlyFaithfulSessionQuirks]) {
            const sender = makeLayer(quirks, n1);
            const reqs = sender.buildSendRequests(payload, pid);
            expect(reqs.length).toBe(1);
            // Pass-through keeps the original PID (not the 0x08 segment marker).
            expect(reqs[0]!.pid).toBe(pid);
            expect(reqs[0]!.pid).not.toBe(PID_SEGMENTED);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});
