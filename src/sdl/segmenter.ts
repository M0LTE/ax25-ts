/**
 * AX.25 v2.2 §6.6 segmentation / reassembly — the TS analogue of packet.net's
 * `Segmenter` / `Reassembler` (`src/Packet.Ax25/Session/Segmenter.cs`, as fixed
 * in packet.net#273 to a 7-bit count). Splits a long upper-layer payload into a
 * sequence of I-frame info-field byte arrays (each prefixed with the segment
 * control octet) on the send side, and accumulates them back into one payload
 * on the receive side.
 *
 * Segment control byte format (AX.25 v2.2 Figure 6.2 — `FXXXXXXX`, value
 * `F*128+X`):
 *
 * ```
 * bit 7    = First indicator (1 on the first segment of a series)
 * bits 6:0 = X, the 7-bit count of segments still to come
 * ```
 *
 * With 7 bits of remaining-count, a payload may span at most 128 segments. At
 * the default N1=256 the per-segment payload is 255 bytes, so the maximum
 * upper-layer payload through the segmenter is 128 × 255 = 32 640 bytes.
 * (Figure 6.2 makes X a 7-bit field; direwolf masks the count with `0x7f` —
 * `ax25_link.c` reassembler — so both spec and de-facto agree the count is
 * 7-bit, not 6. This mirrors the packet.net#273 fix.)
 *
 * Layer-3 packets segmented this way travel as I-frames with PID
 * {@link PID_SEGMENTED} (0x08); reassembly is the receiving side's job (see
 * {@link Reassembler}).
 */
import { PID_SEGMENTED } from "../frame.js";

/** First-segment indicator (bit 7 of the segment control byte). */
export const SEGMENT_FIRST_BIT = 0x80;

/** Seven-bit mask for the remaining-count field (bits 6:0), per Figure 6.2. */
export const SEGMENT_COUNT_MASK = 0x7f;

/** Maximum number of segments a single upper-layer payload may span (7-bit count → 128). */
export const SEGMENT_MAX_SEGMENTS = 128;

// Re-export so callers segmenting can reach the PID from one place.
export { PID_SEGMENTED };

/**
 * Split a payload into I-frame info fields. Each info field is prefixed with
 * the segment control byte; the rest is up to `maxInfoFieldBytes − 1` bytes of
 * payload. An empty payload yields a single (first + last) segment carrying no
 * data bytes. Mirrors the C# `Segmenter.Segment`.
 *
 * @param payload The upper-layer payload to segment.
 * @param maxInfoFieldBytes N1 — the max info-field size per I-frame.
 * @throws RangeError if `maxInfoFieldBytes` is < 2.
 * @throws RangeError if `payload` exceeds {@link SEGMENT_MAX_SEGMENTS} ×
 *   `(maxInfoFieldBytes − 1)` bytes.
 */
export function segment(
  payload: Uint8Array,
  maxInfoFieldBytes: number,
): Uint8Array[] {
  if (maxInfoFieldBytes < 2) {
    throw new RangeError(
      "maxInfoFieldBytes must be at least 2 (1 byte for the segment control byte + at least 1 byte of payload)",
    );
  }

  const perSegment = maxInfoFieldBytes - 1;
  const segmentCount =
    payload.length === 0
      ? 1
      : Math.ceil(payload.length / perSegment);
  if (segmentCount > SEGMENT_MAX_SEGMENTS) {
    throw new RangeError(
      `payload of ${payload.length} bytes would need ${segmentCount} segments at N1=${maxInfoFieldBytes}; max is ${SEGMENT_MAX_SEGMENTS}`,
    );
  }

  const result: Uint8Array[] = [];
  for (let i = 0; i < segmentCount; i++) {
    const remaining = segmentCount - 1 - i;
    const firstBit = i === 0 ? SEGMENT_FIRST_BIT : 0;
    const header = firstBit | (remaining & SEGMENT_COUNT_MASK);

    const offset = i * perSegment;
    const thisLen = Math.min(perSegment, payload.length - offset);
    const out = new Uint8Array(1 + Math.max(thisLen, 0));
    out[0] = header;
    if (thisLen > 0) out.set(payload.subarray(offset, offset + thisLen), 1);
    result.push(out);
  }
  return result;
}

/**
 * AX.25 v2.2 §6.6 reassembly — accumulates a sequence of segments (each pushed
 * as the info field of one I-frame with PID 0x08) into a single upper-layer
 * payload. Mirrors the C# `Reassembler`.
 *
 * One {@link Reassembler} handles one in-flight multi-segment payload at a
 * time. A new "First" segment discards any previously accumulated partial state
 * — matching the spec's behaviour when a fresh packet arrives mid-way through a
 * prior series.
 */
export class Reassembler {
  private readonly accumulated: Uint8Array[] = [];
  private expectedRemaining = -1; // -1 = waiting for a "First" segment

  /**
   * Push the info-field bytes of one segment. Returns the completed payload
   * when the last segment of a series arrives (remaining count == 0); returns
   * `null` when more segments are expected.
   *
   * @throws RangeError if `infoField` is empty.
   * @throws Error if a non-First segment arrives without a prior First, or if
   *   the remaining count is out of sequence vs. the prior segment.
   */
  push(infoField: Uint8Array): Uint8Array | null {
    if (infoField.length < 1) {
      throw new RangeError(
        "segment info field must be at least 1 byte (the control byte)",
      );
    }

    const header = infoField[0];
    const isFirst = (header & SEGMENT_FIRST_BIT) !== 0;
    const remaining = header & SEGMENT_COUNT_MASK;
    const data = infoField.subarray(1);

    if (isFirst) {
      this.accumulated.length = 0;
      this.expectedRemaining = remaining;
    } else if (this.expectedRemaining < 0) {
      throw new Error(
        "non-First segment received before any First segment — no in-progress reassembly to attach to",
      );
    } else if (remaining !== this.expectedRemaining - 1) {
      throw new Error(
        `segment count out of sequence: expected ${this.expectedRemaining - 1}, got ${remaining}`,
      );
    } else {
      this.expectedRemaining = remaining;
    }

    // Copy out of the (possibly aliased) info-field view so a caller reusing
    // the source buffer can't corrupt accumulated state.
    this.accumulated.push(Uint8Array.from(data));

    if (remaining !== 0) return null;

    let totalLen = 0;
    for (const chunk of this.accumulated) totalLen += chunk.length;
    const out = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of this.accumulated) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    this.accumulated.length = 0;
    this.expectedRemaining = -1;
    return out;
  }
}
