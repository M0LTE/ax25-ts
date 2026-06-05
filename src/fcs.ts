/**
 * AX.25 frame check sequence (FCS) — CRC-16/X.25.
 *
 * AX.25 v2.2 §3.7 names ISO 3309 CRC-CCITT with polynomial 0x1021. The
 * per-byte processing is LSB-first (§3.8 transmits data least-significant bit
 * first) while the resulting FCS is transmitted MSB-first; on the wire / in an
 * AXUDP datagram the two FCS octets sit **low byte first**. In CRC-catalogue
 * terms this is CRC-16/X-25:
 *
 *   - Polynomial: 0x1021 (x^16 + x^12 + x^5 + 1)
 *   - Init:       0xFFFF
 *   - RefIn:      true
 *   - RefOut:     true
 *   - XorOut:     0xFFFF
 *
 * Standard test vector: `"123456789"` → 0x906E. Byte-for-byte identical to
 * the C# reference `Packet.Core.Crc16Ccitt` (and to LinBPQ's `bpqaxip.c`
 * `compute_crc`, ax25ipd, XRouter) — so the FCS interoperates exactly.
 *
 * Plain KISS transports (Web Serial, KISS-TCP) never touch this: the TNC owns
 * HDLC framing + the FCS. It exists for **AXUDP** (BPQAXIP-over-UDP), which is
 * AX.25-frames-over-UDP with no TNC, so the transport itself must append the
 * FCS on send and strip + validate it on receive (see `axudp-transport.ts`).
 */

// 0x8408 is the bit-reverse of 0x1021 — RefIn/RefOut=true is implemented by
// reflecting the polynomial and shifting right.
const REFLECTED_POLYNOMIAL = 0x8408;

/** Number of octets the FCS occupies on the wire. */
export const FCS_LENGTH = 2;

/**
 * Compute the AX.25 FCS (CRC-16/X.25) over `data`.
 *
 * @param data the bytes to checksum (an AX.25 frame body, KISS form — no flag,
 *   no FCS).
 * @returns the 16-bit FCS. To place it on the wire, write the **low byte
 *   first** (see {@link appendFcs}).
 */
export function computeFcs(data: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!;
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 1) !== 0) {
        crc = (crc >>> 1) ^ REFLECTED_POLYNOMIAL;
      } else {
        crc >>>= 1;
      }
    }
  }
  return (crc ^ 0xffff) & 0xffff;
}

/**
 * Return a new buffer holding `body` followed by its 2-octet FCS, low byte
 * first — the RFC-1226 AXIP/AXUDP wire form every real peer (LinBPQ BPQAXIP,
 * XRouter, ax25ipd, JNOS) requires. The FCS is unconditional; there is no
 * FCS-less form.
 */
export function appendFcs(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + FCS_LENGTH);
  out.set(body, 0);
  const fcs = computeFcs(body);
  out[body.length] = fcs & 0xff;
  out[body.length + 1] = (fcs >> 8) & 0xff;
  return out;
}

/**
 * Validate + strip the trailing 2-octet FCS (low byte first) from an AXUDP
 * datagram. Returns the bare AX.25 frame body, or `null` when the datagram is
 * too short to carry an FCS, or its FCS doesn't check — a corrupt datagram to
 * **drop**, exactly as every real AXIP/AXUDP peer drops a bad-CRC datagram
 * (BPQAXIP logs "Invalid CRC").
 *
 * Validation here recomputes the FCS over the body and compares (mirroring the
 * C# `AxudpSocket`). That is equivalent to BPQAXIP's residue check — running
 * the *raw* CRC register (no final XOR-out) over the whole `body || FCS`
 * datagram yields the catalogue good residue 0xF0B8 — but recompute-and-compare
 * needs no separate residue form.
 *
 * The minimum is a real AX.25 frame (two 7-octet addresses + a 1-octet control
 * field) plus the 2-octet FCS.
 */
export function stripFcs(datagram: Uint8Array): Uint8Array | null {
  const MIN_FRAME = 2 * 7 + 1; // two addresses + control
  if (datagram.length < MIN_FRAME + FCS_LENGTH) {
    return null;
  }
  const body = datagram.subarray(0, datagram.length - FCS_LENGTH);
  const expected = computeFcs(body);
  const actual = datagram[datagram.length - 2]! | (datagram[datagram.length - 1]! << 8);
  if (expected !== actual) {
    return null;
  }
  // Copy out so callers own a standalone buffer (the subarray aliases the
  // datagram's backing store, which the socket may recycle).
  return body.slice();
}
