import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import { appendFcs, computeFcs, stripFcs } from "../src/fcs.js";
import { encodeFrame, sabm, ui } from "../src/frame.js";

/**
 * CRC-16/X.25 frame-check-sequence codec for AXUDP (BPQAXIP / RFC-1226). The
 * vectors here lock the bit-ordering against the C# reference
 * `Packet.Core.Crc16Ccitt` (and LinBPQ's `bpqaxip.c` `compute_crc`) so the
 * FCS interoperates byte-for-byte — a reflected/non-reflected mix-up would
 * change every value below.
 */
describe("computeFcs — CRC-16/X.25 catalogue vectors", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("matches the standard check value: '123456789' -> 0x906E", () => {
    expect(computeFcs(enc("123456789"))).toBe(0x906e);
  });

  it("empty input yields Init ^ XorOut = 0x0000", () => {
    expect(computeFcs(new Uint8Array(0))).toBe(0x0000);
  });

  it("single-byte vectors lock the reflected bit-ordering", () => {
    // Same sanity values the C# Crc16CcittTests assert.
    expect(computeFcs(new Uint8Array([0x00]))).toBe(0xf078);
    expect(computeFcs(new Uint8Array([0xff]))).toBe(0xff00);
  });

  it("is deterministic — same input, same FCS", () => {
    const data = new Uint8Array([0xaa, 0x55, 0x12, 0x34, 0x56, 0x78]);
    expect(computeFcs(data)).toBe(computeFcs(data));
  });
});

describe("appendFcs / stripFcs — AXUDP wire form (FCS always present)", () => {
  // A real, parseable AX.25 frame body (KISS form, no FCS) to wrap.
  const body = encodeFrame(
    ui({
      destination: Callsign.parse("APRS"),
      source: Callsign.parse("G7XYZ-7"),
      info: new TextEncoder().encode("hello"),
    }),
  );

  it("appends the 2-octet FCS low byte first", () => {
    const datagram = appendFcs(body);
    expect(datagram.length).toBe(body.length + 2);
    expect(Array.from(datagram.subarray(0, body.length))).toEqual(Array.from(body));
    const fcs = computeFcs(body);
    expect(datagram[datagram.length - 2]).toBe(fcs & 0xff); // low byte first
    expect(datagram[datagram.length - 1]).toBe((fcs >> 8) & 0xff);
  });

  it("round-trips: stripFcs(appendFcs(body)) === body", () => {
    const stripped = stripFcs(appendFcs(body));
    expect(stripped).not.toBeNull();
    expect(Array.from(stripped!)).toEqual(Array.from(body));
  });

  it("a complete datagram leaves BPQAXIP's good CRC residue 0xF0B8 (wire-compat anchor)", () => {
    // BPQAXIP validates by running its *raw* CRC register (no final XOR-out)
    // over the whole frame||FCS datagram and checking the residue == 0xF0B8.
    // Our polynomial/init must produce that exact residue or we wouldn't
    // interoperate. (Our own stripFcs validates by recompute-and-compare,
    // which is equivalent — see fcs.ts.)
    const datagram = appendFcs(body);
    const REFLECTED_POLYNOMIAL = 0x8408;
    let crc = 0xffff;
    for (let i = 0; i < datagram.length; i++) {
      crc ^= datagram[i]!;
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc & 1) !== 0 ? (crc >>> 1) ^ REFLECTED_POLYNOMIAL : crc >>> 1;
      }
    }
    expect(crc & 0xffff).toBe(0xf0b8);
  });

  it("drops a datagram whose FCS doesn't check (returns null)", () => {
    const datagram = appendFcs(body);
    datagram[datagram.length - 1] ^= 0xff; // corrupt the FCS high byte
    expect(stripFcs(datagram)).toBeNull();
  });

  it("drops a datagram too short to carry a frame + FCS", () => {
    // Shorter than two addresses + control + FCS — can't be valid.
    expect(stripFcs(new Uint8Array([0x01, 0x02, 0x03]))).toBeNull();
    expect(stripFcs(new Uint8Array(0))).toBeNull();
  });

  it("the stripped body is a standalone buffer (does not alias the datagram)", () => {
    const datagram = appendFcs(body);
    const stripped = stripFcs(datagram)!;
    datagram[0] ^= 0xff; // mutate the datagram after stripping
    // The stripped body must be unchanged (it was copied out).
    expect(stripped[0]).toBe(body[0]);
  });

  it("round-trips an S-frame-sized body (the case an unstripped tail would break)", () => {
    // An RR/RNR/REJ ack has no info; the AX.25 parser rejects trailing bytes
    // on it, so stripping the FCS is mandatory not cosmetic.
    const rrBody = encodeFrame(
      sabm({ destination: Callsign.parse("PN0TST"), source: Callsign.parse("PNTEST-1") }),
    );
    const stripped = stripFcs(appendFcs(rrBody));
    expect(stripped).not.toBeNull();
    expect(Array.from(stripped!)).toEqual(Array.from(rrBody));
  });
});
