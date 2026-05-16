import { Callsign } from "./callsign.js";
import {
  ADDRESS_ENCODED_LENGTH,
  type Ax25Address,
  readAddress,
  writeAddress,
} from "./address.js";

/** PID 0xF0 — no Layer 3 protocol implemented (AX.25 v2.2 §3.4). */
export const PID_NO_LAYER_3 = 0xf0;

/** PID 0xCF — NET/ROM. */
export const PID_NET_ROM = 0xcf;

/** Maximum digipeater chain length (§3.12.5). */
export const MAX_DIGIPEATERS = 8;

/** P/F bit position in the control byte. */
const CONTROL_PF_BIT = 0x10;

// U-frame control-byte bases (§4.3.3, P/F masked off).
const CONTROL_SABM = 0x2f;
const CONTROL_DISC = 0x43;
const CONTROL_UA = 0x63;
const CONTROL_DM = 0x0f;
const CONTROL_UI = 0x03;

// S-frame control-byte bases (§4.3.2).
const CONTROL_RR = 0x01;
const CONTROL_RNR = 0x05;
const CONTROL_REJ = 0x09;

/**
 * The high-level frame kind, after classification of the control byte.
 * Information mod-128 is NOT supported in v1 — only mod-8.
 */
export type FrameKind =
  | "SABM"
  | "DISC"
  | "UA"
  | "DM"
  | "UI"
  | "RR"
  | "RNR"
  | "REJ"
  | "I"
  | "UNKNOWN";

/**
 * One AX.25 frame as delivered by KISS — no opening / closing flag,
 * no FCS (the TNC handles HDLC framing and the FCS).
 *
 * Layout per AX.25 v2.2 §3:
 *   [destination 7B] [source 7B] [digipeaters 0..8 × 7B] [control 1B]
 *   [pid 0..1B] [info 0..N B]
 *
 * PID and info are present only on I and UI frames.
 */
export interface Ax25Frame {
  destination: Ax25Address;
  source: Ax25Address;
  digipeaters: readonly Ax25Address[];
  /** Raw control byte. */
  control: number;
  /** PID byte, present on I/UI frames only. */
  pid: number | null;
  /** Information field. Always present (zero-length if absent). */
  info: Uint8Array;
}

/** True if address C-bits encode a command per §6.1.2 (dest C=1, src C=0). */
export function isCommand(frame: Ax25Frame): boolean {
  return frame.destination.crhBit && !frame.source.crhBit;
}

/** True if address C-bits encode a response per §6.1.2 (dest C=0, src C=1). */
export function isResponse(frame: Ax25Frame): boolean {
  return !frame.destination.crhBit && frame.source.crhBit;
}

/** True if the P/F bit in the control byte is set. */
export function pollFinal(frame: Ax25Frame): boolean {
  return (frame.control & CONTROL_PF_BIT) !== 0;
}

/** Classify the control byte into a high-level frame kind. */
export function classify(frame: Ax25Frame): FrameKind {
  const ctrl = frame.control;
  if ((ctrl & 0x01) === 0) return "I";
  if ((ctrl & 0x03) === 0x01) {
    switch (ctrl & 0x0c) {
      case 0x00:
        return "RR";
      case 0x04:
        return "RNR";
      case 0x08:
        return "REJ";
      default:
        return "UNKNOWN"; // SREJ — out of scope for v1.
    }
  }
  const uBase = ctrl & 0xef;
  switch (uBase) {
    case CONTROL_SABM:
      return "SABM";
    case CONTROL_DISC:
      return "DISC";
    case CONTROL_UA:
      return "UA";
    case CONTROL_DM:
      return "DM";
    case CONTROL_UI:
      return "UI";
    default:
      return "UNKNOWN";
  }
}

/**
 * Mod-8 N(S) — only valid on I frames. Bits 3-1 of the control byte.
 */
export function getNs(frame: Ax25Frame): number {
  return (frame.control >> 1) & 0x07;
}

/**
 * Mod-8 N(R) — valid on I frames and S frames. Bits 7-5 of the control byte.
 */
export function getNr(frame: Ax25Frame): number {
  return (frame.control >> 5) & 0x07;
}

/** Compute total wire length the encoder will produce for this frame. */
export function requiredBytes(frame: Ax25Frame): number {
  return (
    ADDRESS_ENCODED_LENGTH + // destination
    ADDRESS_ENCODED_LENGTH + // source
    frame.digipeaters.length * ADDRESS_ENCODED_LENGTH +
    1 + // control
    (frame.pid === null ? 0 : 1) +
    frame.info.length
  );
}

/** Encode an Ax25Frame into a flat Uint8Array (no KISS framing). */
export function encodeFrame(frame: Ax25Frame): Uint8Array {
  const buf = new Uint8Array(requiredBytes(frame));
  let offset = 0;
  writeAddress(buf, offset, frame.destination);
  offset += ADDRESS_ENCODED_LENGTH;
  writeAddress(buf, offset, frame.source);
  offset += ADDRESS_ENCODED_LENGTH;
  for (const digi of frame.digipeaters) {
    writeAddress(buf, offset, digi);
    offset += ADDRESS_ENCODED_LENGTH;
  }
  buf[offset++] = frame.control & 0xff;
  if (frame.pid !== null) {
    buf[offset++] = frame.pid & 0xff;
  }
  buf.set(frame.info, offset);
  return buf;
}

/**
 * Decode an Ax25Frame from KISS-form bytes (no flag, no FCS). Throws on
 * malformed input — call inside try/catch when feeding raw KISS payloads.
 */
export function decodeFrame(bytes: Uint8Array): Ax25Frame {
  if (bytes.length < 2 * ADDRESS_ENCODED_LENGTH + 1) {
    throw new Error(`frame too short: ${bytes.length} bytes`);
  }
  let offset = 0;
  const destination = readAddress(bytes, offset);
  offset += ADDRESS_ENCODED_LENGTH;
  if (destination.extensionBit) {
    throw new Error("E-bit set on destination address");
  }
  const source = readAddress(bytes, offset);
  offset += ADDRESS_ENCODED_LENGTH;

  const digipeaters: Ax25Address[] = [];
  let last: Ax25Address = source;
  while (!last.extensionBit) {
    if (digipeaters.length >= MAX_DIGIPEATERS) {
      throw new Error(
        `E-bit not reached within ${MAX_DIGIPEATERS} digipeaters`,
      );
    }
    if (bytes.length < offset + ADDRESS_ENCODED_LENGTH) {
      throw new Error("truncated digipeater chain");
    }
    last = readAddress(bytes, offset);
    offset += ADDRESS_ENCODED_LENGTH;
    digipeaters.push(last);
  }

  if (bytes.length < offset + 1) {
    throw new Error("missing control byte");
  }
  const control = bytes[offset++]!;
  let pid: number | null = null;
  let info: Uint8Array = new Uint8Array(0);

  const isUi = (control & 0xef) === CONTROL_UI;
  const isI = (control & 0x01) === 0;
  if (isUi || isI) {
    if (bytes.length < offset + 1) {
      throw new Error("missing PID byte");
    }
    pid = bytes[offset++]!;
    info = bytes.slice(offset);
  } else if (offset < bytes.length) {
    // S-frames / non-info U-frames: be lenient and capture trailing bytes.
    info = bytes.slice(offset);
  }

  return { destination, source, digipeaters, control, pid, info };
}

// ─── Factories ────────────────────────────────────────────────────────────

function makeAddressChain(
  dest: Callsign,
  src: Callsign,
  via: readonly Callsign[],
  isCmd: boolean,
): { destination: Ax25Address; source: Ax25Address; digipeaters: Ax25Address[] } {
  if (via.length > MAX_DIGIPEATERS) {
    throw new Error(
      `AX.25 allows at most ${MAX_DIGIPEATERS} digipeaters (got ${via.length})`,
    );
  }
  const noDigi = via.length === 0;
  const destination: Ax25Address = {
    callsign: dest,
    crhBit: isCmd,
    extensionBit: false,
  };
  const source: Ax25Address = {
    callsign: src,
    crhBit: !isCmd,
    extensionBit: noDigi,
  };
  const digipeaters: Ax25Address[] = via.map((c, i) => ({
    callsign: c,
    crhBit: false,
    extensionBit: i === via.length - 1,
  }));
  return { destination, source, digipeaters };
}

export interface FrameFactoryOpts {
  destination: Callsign;
  source: Callsign;
  digipeaters?: readonly Callsign[];
}

/** Build a SABM (Set Async Balanced Mode, mod-8) command frame. */
export function sabm(opts: FrameFactoryOpts & { pollBit?: boolean }): Ax25Frame {
  const { destination, source, digipeaters = [] } = opts;
  const chain = makeAddressChain(destination, source, digipeaters, true);
  return {
    ...chain,
    control: (CONTROL_SABM | (opts.pollBit ?? true ? CONTROL_PF_BIT : 0)) & 0xff,
    pid: null,
    info: new Uint8Array(0),
  };
}

/** Build a DISC command frame. */
export function disc(opts: FrameFactoryOpts & { pollBit?: boolean }): Ax25Frame {
  const { destination, source, digipeaters = [] } = opts;
  const chain = makeAddressChain(destination, source, digipeaters, true);
  return {
    ...chain,
    control: (CONTROL_DISC | (opts.pollBit ?? true ? CONTROL_PF_BIT : 0)) & 0xff,
    pid: null,
    info: new Uint8Array(0),
  };
}

/** Build a UA response frame. */
export function ua(opts: FrameFactoryOpts & { finalBit?: boolean }): Ax25Frame {
  const { destination, source, digipeaters = [] } = opts;
  const chain = makeAddressChain(destination, source, digipeaters, false);
  return {
    ...chain,
    control:
      (CONTROL_UA | (opts.finalBit ?? true ? CONTROL_PF_BIT : 0)) & 0xff,
    pid: null,
    info: new Uint8Array(0),
  };
}

/** Build a DM response frame. */
export function dm(opts: FrameFactoryOpts & { finalBit?: boolean }): Ax25Frame {
  const { destination, source, digipeaters = [] } = opts;
  const chain = makeAddressChain(destination, source, digipeaters, false);
  return {
    ...chain,
    control:
      (CONTROL_DM | (opts.finalBit ?? false ? CONTROL_PF_BIT : 0)) & 0xff,
    pid: null,
    info: new Uint8Array(0),
  };
}

/** Build a UI frame. Command/response per `isCommand`. */
export function ui(
  opts: FrameFactoryOpts & {
    info: Uint8Array;
    pid?: number;
    isCommand?: boolean;
    pollFinal?: boolean;
  },
): Ax25Frame {
  const { destination, source, digipeaters = [], info } = opts;
  const isCmd = opts.isCommand ?? true;
  const chain = makeAddressChain(destination, source, digipeaters, isCmd);
  return {
    ...chain,
    control: (CONTROL_UI | (opts.pollFinal ? CONTROL_PF_BIT : 0)) & 0xff,
    pid: opts.pid ?? PID_NO_LAYER_3,
    info,
  };
}

/** Build a Receive Ready (RR) supervisory frame. */
export function rr(
  opts: FrameFactoryOpts & {
    nr: number;
    isCommand: boolean;
    pollFinal?: boolean;
  },
): Ax25Frame {
  const { destination, source, digipeaters = [], nr } = opts;
  const chain = makeAddressChain(destination, source, digipeaters, opts.isCommand);
  const control =
    (((nr & 0x07) << 5) | (opts.pollFinal ? CONTROL_PF_BIT : 0) | CONTROL_RR) &
    0xff;
  return {
    ...chain,
    control,
    pid: null,
    info: new Uint8Array(0),
  };
}

/** Build a Receive Not Ready (RNR) supervisory frame. */
export function rnr(
  opts: FrameFactoryOpts & {
    nr: number;
    isCommand: boolean;
    pollFinal?: boolean;
  },
): Ax25Frame {
  const { destination, source, digipeaters = [], nr } = opts;
  const chain = makeAddressChain(destination, source, digipeaters, opts.isCommand);
  const control =
    (((nr & 0x07) << 5) | (opts.pollFinal ? CONTROL_PF_BIT : 0) | CONTROL_RNR) &
    0xff;
  return {
    ...chain,
    control,
    pid: null,
    info: new Uint8Array(0),
  };
}

/** Build a REJ supervisory frame. */
export function rej(
  opts: FrameFactoryOpts & {
    nr: number;
    isCommand: boolean;
    pollFinal?: boolean;
  },
): Ax25Frame {
  const { destination, source, digipeaters = [], nr } = opts;
  const chain = makeAddressChain(destination, source, digipeaters, opts.isCommand);
  const control =
    (((nr & 0x07) << 5) | (opts.pollFinal ? CONTROL_PF_BIT : 0) | CONTROL_REJ) &
    0xff;
  return {
    ...chain,
    control,
    pid: null,
    info: new Uint8Array(0),
  };
}

/**
 * Build an Information (I) frame. Always a command per AX.25 v2.2 §4.3.1.
 * Mod-8 control: `(N(R) << 5) | (P << 4) | (N(S) << 1) | 0`.
 */
export function iFrame(
  opts: FrameFactoryOpts & {
    nr: number;
    ns: number;
    info: Uint8Array;
    pid?: number;
    pollBit?: boolean;
  },
): Ax25Frame {
  const { destination, source, digipeaters = [], nr, ns, info } = opts;
  const chain = makeAddressChain(destination, source, digipeaters, true);
  const control =
    (((nr & 0x07) << 5) |
      (opts.pollBit ? CONTROL_PF_BIT : 0) |
      ((ns & 0x07) << 1)) &
    0xff;
  return {
    ...chain,
    control,
    pid: opts.pid ?? PID_NO_LAYER_3,
    info,
  };
}
