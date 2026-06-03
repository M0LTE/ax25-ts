/**
 * AX.25 §6.6 segmenter / reassembler round-trip tests — the TS port of
 * packet.net's `SegmenterTests` (`tests/Packet.Ax25.Tests/Session/SegmenterTests.cs`),
 * including the 7-bit segment-count boundary (packet.net#273): a 128-segment
 * payload round-trips and a 129-segment one throws.
 */
import { describe, expect, it } from "vitest";
import {
  Reassembler,
  SEGMENT_COUNT_MASK,
  SEGMENT_FIRST_BIT,
  SEGMENT_MAX_SEGMENTS,
  segment,
} from "../src/sdl/segmenter.js";

describe("Segmenter / Reassembler — round-trip", () => {
  // 32640 = MaxSegments (128) × (N1-1=255) at N1=256 — the 7-bit boundary.
  for (const payloadSize of [0, 1, 100, 254, 255, 256, 1500, 16320, 32640]) {
    it(`round-trips a ${payloadSize}-byte payload through segmenter + reassembler`, () => {
      const payload = new Uint8Array(payloadSize);
      for (let i = 0; i < payloadSize; i++) payload[i] = (i * 31) & 0xff; // deterministic pattern

      const segments = segment(payload, 256);

      let completed: Uint8Array | null = null;
      const reassembler = new Reassembler();
      for (const seg of segments) completed = reassembler.push(seg);

      expect(completed).not.toBeNull();
      expect((completed as Uint8Array).length).toBe(payloadSize);
      expect(Array.from(completed as Uint8Array)).toEqual(Array.from(payload));
    });
  }

  it("the boundary uses the full 7-bit count: 32640 bytes is exactly 128 segments", () => {
    const segments = segment(new Uint8Array(32640), 256);
    expect(segments.length).toBe(SEGMENT_MAX_SEGMENTS); // 128
    // First segment: First=1, remaining=127 (the top of the 7-bit field — a
    // 6-bit count would have overflowed here, which is the packet.net#273 fix).
    expect(segments[0][0] & SEGMENT_FIRST_BIT).not.toBe(0);
    expect(segments[0][0] & SEGMENT_COUNT_MASK).toBe(127);
  });
});

describe("Segmenter — header layout", () => {
  it("first segment has First bit set; remaining-count equals segments after it", () => {
    // 1500 bytes at N1=256 → per-segment payload 255 → 6 segments.
    const segments = segment(new Uint8Array(1500), 256);
    expect(segments.length).toBe(6);

    expect(segments[0][0] & SEGMENT_FIRST_BIT).not.toBe(0);
    expect(segments[0][0] & SEGMENT_COUNT_MASK).toBe(5);

    expect(segments[5][0] & SEGMENT_FIRST_BIT).toBe(0);
    expect(segments[5][0] & SEGMENT_COUNT_MASK).toBe(0);
  });
});

describe("Segmenter — rejects", () => {
  it("throws if the payload would need more than 128 segments (7-bit count)", () => {
    // 128 × 255 = 32640 is the limit; one more byte needs a 129th segment.
    expect(() => segment(new Uint8Array(32641), 256)).toThrow(/128/);
  });

  it("throws if maxInfoFieldBytes is too small (< 2)", () => {
    expect(() => segment(new Uint8Array(10), 1)).toThrow(RangeError);
  });
});

describe("Reassembler — rejects + restart", () => {
  it("throws on a non-First segment without a prior First", () => {
    const reassembler = new Reassembler();
    // Header: First=0, remaining=5 ("I'm segment 1 of 6") with no First seen.
    const stray = Uint8Array.from([0x05, 1, 2, 3]);
    expect(() => reassembler.push(stray)).toThrow(/non-First/);
  });

  it("throws on out-of-sequence segments", () => {
    const reassembler = new Reassembler();
    reassembler.push(Uint8Array.from([SEGMENT_FIRST_BIT | 5, 0xaa])); // First, expects 4 next
    expect(() => reassembler.push(Uint8Array.from([3, 0xbb]))).toThrow(
      /out of sequence/,
    );
  });

  it("a fresh First segment mid-stream discards the partial state", () => {
    const reassembler = new Reassembler();
    reassembler.push(Uint8Array.from([SEGMENT_FIRST_BIT | 5, 1, 2])); // start a 6-segment series
    reassembler.push(Uint8Array.from([4, 3, 4]));
    // A new First restarts the buffer; completing the fresh single-segment
    // series yields only the fresh bytes.
    const completed = reassembler.push(
      Uint8Array.from([SEGMENT_FIRST_BIT | 0, 0xde, 0xad]),
    );
    expect(Array.from(completed as Uint8Array)).toEqual([0xde, 0xad]);
  });
});
