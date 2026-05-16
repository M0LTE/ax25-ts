import { Callsign } from "./callsign.js";

/**
 * One 7-octet address slot in an AX.25 frame header (AX.25 v2.2 §3.12).
 *
 * Octets 1-6: callsign chars, each left-shifted by 1.
 * Octet 7 (SSID byte): C/H | R | R | SSID(4) | E
 *   - C/H: command/response on destination & source slots; has-been-repeated on digi slots.
 *   - R: reserved bits — v2.2 default is "11".
 *   - SSID: 4-bit station identifier.
 *   - E: end-of-address — set on the LAST slot of the whole address field.
 *
 * Mirrors `Packet.Core.Ax25Address` on the C# side.
 */
export interface Ax25Address {
  callsign: Callsign;
  /** C-bit (destination/source) or H-bit (repeater). */
  crhBit: boolean;
  /** End-of-address (set on the last slot only). */
  extensionBit: boolean;
}

/** Number of octets one address slot occupies on the wire. */
export const ADDRESS_ENCODED_LENGTH = 7;

/** Read one 7-octet slot starting at `offset`. */
export function readAddress(bytes: Uint8Array, offset: number): Ax25Address {
  if (bytes.length < offset + ADDRESS_ENCODED_LENGTH) {
    throw new Error(
      `address slot needs ${ADDRESS_ENCODED_LENGTH} bytes (got ${bytes.length - offset})`,
    );
  }
  // First 6 bytes: callsign chars, each in upper 7 bits.
  let baseStr = "";
  let inPadding = false;
  for (let i = 0; i < 6; i++) {
    const c = String.fromCharCode(bytes[offset + i]! >> 1);
    if (c === " ") {
      inPadding = true;
      continue;
    }
    if (inPadding) {
      throw new Error(`address octet ${i} contains non-space after padding`);
    }
    baseStr += c;
  }
  const ssidByte = bytes[offset + 6]!;
  const ssid = (ssidByte >> 1) & 0x0f;
  const crhBit = (ssidByte & 0x80) !== 0;
  const extensionBit = (ssidByte & 0x01) !== 0;
  return {
    callsign: new Callsign(baseStr, ssid),
    crhBit,
    extensionBit,
  };
}

/** Encode this address slot into 7 bytes at `offset`. */
export function writeAddress(
  dest: Uint8Array,
  offset: number,
  addr: Ax25Address,
): void {
  if (dest.length < offset + ADDRESS_ENCODED_LENGTH) {
    throw new Error(
      `address slot needs ${ADDRESS_ENCODED_LENGTH} bytes of room`,
    );
  }
  const base = addr.callsign.base;
  for (let i = 0; i < 6; i++) {
    const c = i < base.length ? base.charCodeAt(i) : 0x20;
    dest[offset + i] = (c << 1) & 0xff;
  }
  // R bits default to "11" per v2.2.
  let ssidByte = 0x60 | ((addr.callsign.ssid & 0x0f) << 1);
  if (addr.crhBit) ssidByte |= 0x80;
  if (addr.extensionBit) ssidByte |= 0x01;
  dest[offset + 6] = ssidByte & 0xff;
}
