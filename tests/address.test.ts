import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import {
  ADDRESS_ENCODED_LENGTH,
  readAddress,
  writeAddress,
} from "../src/address.js";

describe("address codec", () => {
  it("round-trips a 6-char callsign with SSID", () => {
    const buf = new Uint8Array(ADDRESS_ENCODED_LENGTH);
    writeAddress(buf, 0, {
      callsign: Callsign.parse("M0LTE-7"),
      crhBit: true,
      extensionBit: false,
    });
    const round = readAddress(buf, 0);
    expect(round.callsign.toString()).toBe("M0LTE-7");
    expect(round.crhBit).toBe(true);
    expect(round.extensionBit).toBe(false);
  });

  it("pads a short callsign with spaces", () => {
    const buf = new Uint8Array(ADDRESS_ENCODED_LENGTH);
    writeAddress(buf, 0, {
      callsign: Callsign.parse("G7AB"),
      crhBit: false,
      extensionBit: true,
    });
    // First 4 octets are letters shifted left, next 2 are 0x20 << 1 = 0x40.
    expect(buf[4]).toBe(0x40);
    expect(buf[5]).toBe(0x40);
    expect(buf[6]! & 0x01).toBe(0x01); // E-bit set
  });

  it("encodes the v2.2 default reserved bits as '11'", () => {
    const buf = new Uint8Array(ADDRESS_ENCODED_LENGTH);
    writeAddress(buf, 0, {
      callsign: Callsign.parse("G0XYZ"),
      crhBit: false,
      extensionBit: false,
    });
    // SSID byte: top bits CRH=0 | R=1 | R=1 | SSID(4) | E=0  ⇒ 0x60 base.
    expect(buf[6]! & 0x60).toBe(0x60);
  });

  it("encodes the C/H bit as the high bit of the SSID octet", () => {
    const buf = new Uint8Array(ADDRESS_ENCODED_LENGTH);
    writeAddress(buf, 0, {
      callsign: Callsign.parse("M0LTE"),
      crhBit: true,
      extensionBit: false,
    });
    expect((buf[6]! & 0x80) !== 0).toBe(true);
  });
});
