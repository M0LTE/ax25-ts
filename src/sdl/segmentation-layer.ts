/**
 * AX.25 v2.2 §2.4 / §6.6 segmentation-reassembly shim — the TS analogue of
 * packet.net's `SegmentationLayer` (`src/Packet.Ax25/Session/SegmentationLayer.cs`).
 * It sits at the data-link primitive boundary — between Layer 3 (the upper
 * layer) and a session — and the data-link state machine / session stay
 * **unchanged**: segments travel as ordinary I-frames carrying PID
 * {@link PID_SEGMENTED} (0x08), so the FSM just sends and receives them. This
 * layer is the §6.6 "the segmenter passes all other signals unchanged" boundary
 * process.
 *
 * One instance per data-link session — it owns the per-session
 * {@link Reassembler} (which holds in-flight multi-segment state). The spec
 * models exactly this placement (§2557 / §2560): the reassembler examines the
 * DL-DATA / DL-UNIT-DATA *indication* (a 0x08 PID means reassemble, anything
 * else passes through transparently); the segmenter examines the DL-DATA /
 * DL-UNIT-DATA *request* (over-N1 means segment, otherwise pass through).
 *
 * ## Gating
 *
 * Segmentation is a v2.2, negotiated capability (§1621 — "only enabled if both
 * stations on the link are using AX.25 version 2.2 or higher", set via the XID
 * HDLC-Optional-Functions segmenter bit). This layer gates the send side on
 * {@link Ax25SessionContext.segmenterReassemblerEnabled} (V3's MDL negotiation
 * sets it). If a payload exceeds N1 and the segmenter is *not* enabled,
 * {@link SegmentationLayer.buildSendRequests} throws — the request is rejected
 * cleanly rather than silently truncated or sent as an oversize frame.
 *
 * ## Inner PID on reassembly
 *
 * Figure 6.2 defines the segment header as the 0x08 PID octet plus one F/X
 * octet — there is **no field carrying the original Layer-3 PID** through a
 * segmented series. So a reassembled payload is delivered with PID
 * {@link PID_NO_LAYER_3} (0xF0): §6.6 reassembly has no PID-recovery mechanism,
 * and 0xF0 ("no Layer 3 protocol") is the faithful "PID unknown / raw" value. A
 * future revision that carries the inner PID (some stacks prepend it as the
 * first reassembled byte) would change {@link SegmentationLayer.reassembledPid}.
 * Mirrors C#'s documented `ReassembledPid`.
 */
import { PID_NO_LAYER_3, PID_SEGMENTED } from "../frame.js";
import { type Ax25Event, dlDataRequestEvent } from "./events.js";
import type { Ax25SessionContext } from "./session-context.js";
import { Reassembler, segment } from "./segmenter.js";

/**
 * A DL-DATA-indication {@link DataLinkSignal} — the narrowed shape the receive
 * shim consumes and produces. (`DataLinkSignal` is a tagged union; this is the
 * `"DL_DATA_indication"` arm.) Re-declared locally to keep the type narrow at
 * the shim boundary; structurally identical to the union member.
 */
export interface DataLinkDataIndication {
  readonly type: "DL_DATA_indication";
  readonly data: Uint8Array;
  readonly pid: number;
}

export class SegmentationLayer {
  private readonly context: Ax25SessionContext;
  private readonly reassembler = new Reassembler();

  /**
   * PID delivered with a reassembled payload. Per §6.6 / Figure 6.2 the segment
   * header carries no inner Layer-3 PID, so reassembled data is delivered as
   * {@link PID_NO_LAYER_3} (0xF0). Mirrors the C# `SegmentationLayer.ReassembledPid`.
   */
  static readonly reassembledPid = PID_NO_LAYER_3;

  /**
   * @param context The session's context — read for the negotiated
   *   segmenter-enabled flag and N1.
   */
  constructor(context: Ax25SessionContext) {
    this.context = context;
  }

  /**
   * Send-side shim. Given an upper-layer payload + its Layer-3 PID, return the
   * sequence of `DL_DATA_request` {@link Ax25Event}s to post to the session:
   *
   *  - If the segmenter is enabled and the payload exceeds N1, one
   *    `DL_DATA_request` per segment, each carrying PID {@link PID_SEGMENTED}
   *    (0x08); the session enqueues + sends each as a normal I-frame.
   *  - Otherwise a single `DL_DATA_request` with the original payload + PID,
   *    unchanged.
   *
   * @throws Error if the payload exceeds N1 and the segmenter has not been
   *   negotiated (v2.0 / not enabled) — the request can't be honoured without
   *   violating N1, so it is rejected cleanly. Mirrors the C#
   *   `InvalidOperationException`.
   */
  buildSendRequests(data: Uint8Array, pid: number = PID_NO_LAYER_3): Ax25Event[] {
    // N1 is the max info-field octet count. An un-segmented info field is the
    // whole payload (one PID, no segment-control byte), so the pass-through
    // ceiling is N1 itself. A *segment's* info field is the F/X control byte +
    // payload, so per-segment payload is N1−1.
    const fits = data.length <= this.context.n1;

    if (fits) {
      return [dlDataRequestEvent(data, pid)];
    }

    if (!this.context.segmenterReassemblerEnabled) {
      throw new Error(
        `payload of ${data.length} bytes exceeds N1=${this.context.n1} and the ` +
          "segmenter/reassembler has not been negotiated (AX.25 v2.2 §6.6 — segmentation requires " +
          "both peers to advertise the XID HDLC-Optional-Functions segmenter bit). Cannot send " +
          "without segmenting; rejecting the request rather than truncating or producing an " +
          "oversize frame.",
      );
    }

    // Segment into PID-0x08 info fields (segment-control byte + ≤ N1−1 payload
    // bytes each) and post each as its own I-frame request.
    return segment(data, this.context.n1).map((seg) =>
      dlDataRequestEvent(seg, PID_SEGMENTED),
    );
  }

  /**
   * Receive-side shim. Given a `DL_DATA_indication` the session raised, either:
   *
   *  - If its PID is {@link PID_SEGMENTED} (0x08), feed the info field to the
   *    per-session {@link Reassembler} and return the completed payload as a
   *    single reassembled `DL_DATA_indication` on the last segment, or `null`
   *    while more segments are expected (nothing to deliver yet).
   *  - Otherwise return the indication unchanged (pass-through).
   *
   * @returns The indication to deliver upward, or `null` when a segment was
   *   consumed but the series is incomplete. Mirrors the C#
   *   `SegmentationLayer.OnDataIndication`.
   */
  onDataIndication(
    indication: DataLinkDataIndication,
  ): DataLinkDataIndication | null {
    if (indication.pid !== PID_SEGMENTED) {
      return indication; // not a segment — pass through transparently
    }

    const completed = this.reassembler.push(indication.data);
    return completed === null
      ? null
      : {
          type: "DL_DATA_indication",
          data: completed,
          pid: SegmentationLayer.reassembledPid,
        };
  }
}
