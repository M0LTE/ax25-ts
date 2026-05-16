/**
 * KISS TNC framing (SLIP-style escape sequences).
 *
 * See https://github.com/packethacking/ax25spec/blob/main/doc/kiss-tnc-protocol.md
 *
 * Wire layout: `FEND | (port<<4)|cmd | (escaped payload) | FEND`
 *   - FEND (0xC0) inside the payload escapes to FESC TFEND.
 *   - FESC (0xDB) inside the payload escapes to FESC TFESC.
 */

export const FEND = 0xc0;
export const FESC = 0xdb;
export const TFEND = 0xdc;
export const TFESC = 0xdd;

/** KISS command codes (low nibble of the command byte). */
export const KISS_CMD = {
  Data: 0x0,
  TxDelay: 0x1,
  Persistence: 0x2,
  SlotTime: 0x3,
  TxTail: 0x4,
  FullDuplex: 0x5,
  SetHardware: 0x6,
  ExitKissMode: 0xff,
} as const;

export type KissCommand = (typeof KISS_CMD)[keyof typeof KISS_CMD];

/** One decoded KISS frame. */
export interface KissFrame {
  /** Multi-drop port (0-15). */
  port: number;
  /** KISS command code (low nibble). */
  command: number;
  /** Payload, unescaped. */
  payload: Uint8Array;
}

/**
 * Encode a single KISS frame for transmission. The command byte
 * (`(port<<4)|cmd`) is itself escaped if it happens to collide with FEND/FESC,
 * to handle e.g. port=12 + Data=0xC -> 0xCC0 -> 0xC0 collision corner cases.
 */
export function encodeKiss(
  port: number,
  command: number,
  payload: Uint8Array,
): Uint8Array {
  if (port < 0 || port > 15) {
    throw new Error(`KISS port must be 0-15 (got ${port})`);
  }
  // Worst case: every byte escapes to 2; plus 2 FENDs.
  const maxLen = 4 + payload.length * 2;
  const buf = new Uint8Array(maxLen);
  let i = 0;
  buf[i++] = FEND;
  const cmdByte = ((port & 0x0f) << 4) | (command & 0x0f);
  i += writeEscaped(buf, i, cmdByte);
  for (let j = 0; j < payload.length; j++) {
    i += writeEscaped(buf, i, payload[j]!);
  }
  buf[i++] = FEND;
  return buf.subarray(0, i);
}

function writeEscaped(dst: Uint8Array, offset: number, b: number): number {
  if (b === FEND) {
    dst[offset] = FESC;
    dst[offset + 1] = TFEND;
    return 2;
  }
  if (b === FESC) {
    dst[offset] = FESC;
    dst[offset + 1] = TFESC;
    return 2;
  }
  dst[offset] = b;
  return 1;
}

/**
 * Stateful KISS frame decoder. Push raw bytes from the serial port as they
 * arrive; each `push` returns any complete frames extracted from the byte
 * stream. The decoder retains in-progress frame state and escape mode across
 * calls.
 */
export class KissDecoder {
  private current: number[] = [];
  private inEscape = false;

  /** Push a chunk of received bytes. Returns 0+ decoded frames. */
  push(bytes: Uint8Array): KissFrame[] {
    const out: KissFrame[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      if (this.inEscape) {
        this.inEscape = false;
        if (b === TFEND) this.current.push(FEND);
        else if (b === TFESC) this.current.push(FESC);
        // else: lenient drop on malformed escape.
        continue;
      }
      if (b === FEND) {
        if (this.current.length > 0) {
          const frame = this.finish();
          if (frame) out.push(frame);
          this.current = [];
        }
        // empty inter-frame FEND: ignored.
      } else if (b === FESC) {
        this.inEscape = true;
      } else {
        this.current.push(b);
      }
    }
    return out;
  }

  reset(): void {
    this.current = [];
    this.inEscape = false;
  }

  private finish(): KissFrame | null {
    if (this.current.length < 1) return null;
    const cmdByte = this.current[0]!;
    const port = (cmdByte >> 4) & 0x0f;
    const command = cmdByte & 0x0f;
    const payload = new Uint8Array(this.current.length - 1);
    for (let i = 1; i < this.current.length; i++) {
      payload[i - 1] = this.current[i]!;
    }
    return { port, command, payload };
  }
}
