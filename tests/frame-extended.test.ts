import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import {
  type FrameKind,
  classify,
  decodeFrame,
  encodeFrame,
  getNr,
  getNs,
  iFrame,
  isExtendedControl,
  pollFinal,
  rej,
  requiredBytes,
  rnr,
  rr,
  sabme,
  srej,
} from "../src/frame.js";

/**
 * Codec tests for the extended (modulo-128) 2-octet control field on I and S
 * frames (AX.25 v2.2 §4.2.1 Fig 4.1b, §4.3.1 Fig 4.2b, §4.3.2 Fig 4.3b). Each
 * octet value is pinned against the spec bit layout:
 *
 *   - I frame: octet0 = (N(S) << 1) | 0; octet1 = (N(R) << 1) | P.
 *   - S frame: octet0 = base (SS bits + "01", high nibble 0); octet1 = (N(R) << 1) | P/F.
 *   - U frames stay 1 octet in both modulos.
 *
 * The control-field width is not derivable from the octets alone, so parsing
 * requires the link's negotiated modulo — these tests exercise both the correct
 * (extended) parse and the deliberately-wrong modulo-8 parse to show why the
 * receive path must be mode-aware.
 *
 * The TS parity leg of packet.net's `Ax25FrameExtendedControlTests`
 * (m0lte/packet.net#266, v2.2 arc V1).
 */

const DEST = new Callsign("M0LTE", 0);
const SRC = new Callsign("G7XYZ", 7);

type SType = "RR" | "RNR" | "REJ" | "SREJ";

/** Build an extended (or mod-8) S frame of the given type. */
function buildS(
  type: SType,
  nr: number,
  isCommand: boolean,
  pollFinalBit: boolean,
  extended: boolean,
) {
  const opts = {
    destination: DEST,
    source: SRC,
    nr,
    isCommand,
    pollFinal: pollFinalBit,
    extended,
  };
  switch (type) {
    case "RR":
      return rr(opts);
    case "RNR":
      return rnr(opts);
    case "REJ":
      return rej(opts);
    case "SREJ":
      return srej(opts);
  }
}

describe("extended (mod-128) control field — encode: spec-pinned octets", () => {
  // ns, nr, p, expected octet0, expected octet1
  const cases: Array<[number, number, boolean, number, number]> = [
    [0, 0, false, 0x00, 0x00],
    [5, 3, true, 0x0a, 0x07], // 5<<1=0x0A ; (3<<1)|1=0x07
    [1, 0, false, 0x02, 0x00],
    [100, 70, false, 0xc8, 0x8c], // 100<<1=200=0xC8 ; 70<<1=140=0x8C
    [127, 127, true, 0xfe, 0xff], // 127<<1=0xFE ; (127<<1)|1=0xFF
  ];
  it.each(cases)(
    "I frame ns=%i nr=%i p=%s → octet0=0x%s octet1",
    (ns, nr, poll, octet0, octet1) => {
      const frame = iFrame({
        destination: DEST,
        source: SRC,
        nr,
        ns,
        info: new Uint8Array([0xaa]),
        pollBit: poll,
        extended: true,
      });
      expect(isExtendedControl(frame)).toBe(true);
      // octet0 carries 7-bit N(S) with bit 0 = 0.
      expect(frame.control).toBe(octet0);
      // octet1 carries 7-bit N(R) with bit 0 = P.
      expect(frame.controlExtension).toBe(octet1);
    },
  );

  // S-frame base octets (SS bits + "01", high nibble 0), N(R)=100, F=1 →
  // octet1 = (100<<1)|1 = 201 = 0xC9.
  const sCases: Array<[SType, number]> = [
    ["RR", 0x01],
    ["RNR", 0x05],
    ["REJ", 0x09],
    ["SREJ", 0x0d],
  ];
  it.each(sCases)("%s frame → base octet0=0x%s, octet1 carries N(R)/F", (type, base) => {
    const frame = buildS(type, 100, false, true, true);
    expect(isExtendedControl(frame)).toBe(true);
    // octet0 is the supervisory base (SS bits + 01, high nibble 0).
    expect(frame.control).toBe(base);
    // octet1 carries 7-bit N(R) with bit 0 = P/F.
    expect(frame.controlExtension).toBe(0xc9);
  });
});

describe("extended (mod-128) control field — round-trip via mode-aware parse", () => {
  // 7-bit N(S)/N(R) survive encode → bytes → parse(extended) → fields/classify.
  const seqCases: Array<[number, number]> = [
    [0, 0],
    [1, 2],
    [7, 8], // straddles the mod-8 3-bit boundary
    [63, 64],
    [100, 27],
    [126, 125],
    [127, 127],
  ];
  it.each(seqCases)("I frame round-trips ns=%i nr=%i", (ns, nr) => {
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const sent = iFrame({
      destination: DEST,
      source: SRC,
      nr,
      ns,
      info: payload,
      pollBit: true,
      extended: true,
    });
    const got = decodeFrame(encodeFrame(sent), true);
    expect(isExtendedControl(got)).toBe(true);
    expect(getNs(got)).toBe(ns); // 7-bit N(S) survives
    expect(getNr(got)).toBe(nr); // 7-bit N(R) survives
    expect(pollFinal(got)).toBe(true); // P lives in octet1 bit 0 under mod-128
    expect(got.pid).toBe(0xf0);
    expect(Array.from(got.info)).toEqual(Array.from(payload));
    expect(classify(got)).toBe<FrameKind>("I");
  });

  const sCases: Array<[SType, FrameKind]> = [
    ["RR", "RR"],
    ["RNR", "RNR"],
    ["REJ", "REJ"],
    ["SREJ", "SREJ"],
  ];
  it.each(sCases)("%s frame round-trips N(R) and classifies", (type, expected) => {
    const sent = buildS(type, 99, true, false, true);
    const got = decodeFrame(encodeFrame(sent), true);
    expect(isExtendedControl(got)).toBe(true);
    expect(getNr(got)).toBe(99); // 7-bit N(R) survives
    expect(pollFinal(got)).toBe(false);
    expect(got.info.length).toBe(0); // S frames carry no information field
    expect(classify(got)).toBe(expected);
  });

  it("round-trips all 0..127 N(S)/N(R) pairs (no truncation, no aliasing)", () => {
    // Full sweep — the exhaustive proof the 7-bit fields are not silently
    // masked to 3 bits anywhere in the encode/parse path.
    for (let ns = 0; ns < 128; ns++) {
      const nr = (127 - ns) & 0x7f;
      const sent = iFrame({
        destination: DEST,
        source: SRC,
        nr,
        ns,
        info: new Uint8Array([ns & 0xff]),
        pollBit: (ns & 1) === 1,
        extended: true,
      });
      const got = decodeFrame(encodeFrame(sent), true);
      expect(getNs(got)).toBe(ns);
      expect(getNr(got)).toBe(nr);
      expect(pollFinal(got)).toBe((ns & 1) === 1);
      expect(classify(got)).toBe<FrameKind>("I");
    }
  });
});

describe("extended (mod-128) control field — sizing", () => {
  it("an extended I frame is exactly one octet longer than mod-8", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const mod8 = iFrame({ destination: DEST, source: SRC, nr: 3, ns: 5, info: payload });
    const ext = iFrame({
      destination: DEST,
      source: SRC,
      nr: 3,
      ns: 5,
      info: payload,
      extended: true,
    });
    // The second control octet adds one byte.
    expect(requiredBytes(ext)).toBe(requiredBytes(mod8) + 1);
    expect(encodeFrame(ext).length).toBe(encodeFrame(mod8).length + 1);
  });
});

describe("U frames are modulo-independent", () => {
  it("a U frame stays one octet even when parsed extended", () => {
    // SABME is a U frame: 1-octet control in both modulos. Parsing it on an
    // extended link must NOT consume a second control octet.
    const frame = sabme({ destination: DEST, source: SRC, pollBit: true });
    const got = decodeFrame(encodeFrame(frame), true);
    expect(isExtendedControl(got)).toBe(false); // U frames have no extended control octet
    expect(got.controlExtension).toBeNull();
    expect(got.control).toBe(frame.control);
    expect(classify(got)).toBe<FrameKind>("SABME");
  });
});

describe("why mode-awareness is required", () => {
  it("an extended I frame parsed as mod-8 mis-frames", () => {
    // An extended I-frame decoded at the wrong modulo (mod-8) swallows the
    // second control octet as the PID and mis-reads N(S) — demonstrating the
    // width genuinely can't be inferred from the bytes.
    const sent = iFrame({
      destination: DEST,
      source: SRC,
      nr: 9,
      ns: 70,
      info: new Uint8Array([0xaa]),
      pollBit: true,
      extended: true,
    });
    const bytes = encodeFrame(sent);

    const wrong = decodeFrame(bytes, false);
    expect(isExtendedControl(wrong)).toBe(false);
    // octet1 = (9<<1)|1 = 0x13 gets read as the PID rather than N(R)/P.
    expect(wrong.pid).toBe(0x13);
    expect(getNs(wrong)).not.toBe(70); // N(S) is mis-read at 3-bit width

    // The same bytes, parsed at the correct modulo, decode cleanly.
    const right = decodeFrame(bytes, true);
    expect(getNs(right)).toBe(70);
    expect(getNr(right)).toBe(9);
  });
});

describe("mod-8 regression: extended support leaves mod-8 unchanged", () => {
  it("a mod-8 I frame is unaffected by extended support", () => {
    const frame = iFrame({
      destination: DEST,
      source: SRC,
      nr: 3,
      ns: 5,
      info: new Uint8Array([0x42]),
      pollBit: true,
    });
    expect(isExtendedControl(frame)).toBe(false);
    expect(frame.controlExtension).toBeNull();
    // mod-8 I control = (N(R)<<5) | (P<<4) | (N(S)<<1) = 0x60|0x10|0x0A = 0x7A.
    expect(frame.control).toBe(0x7a);
    expect(getNs(frame)).toBe(5);
    expect(getNr(frame)).toBe(3);
    expect(pollFinal(frame)).toBe(true);
  });

  it("a mod-8 RR keeps N(R)/P-F packed in the single control octet", () => {
    const frame = rr({
      destination: DEST,
      source: SRC,
      nr: 5,
      isCommand: false,
      pollFinal: true,
    });
    expect(isExtendedControl(frame)).toBe(false);
    // mod-8 RR control = (5<<5) | (P/F<<4) | 0x01 = 0xA0|0x10|0x01 = 0xB1.
    expect(frame.control).toBe(0xb1);
    expect(frame.controlExtension).toBeNull();
    expect(getNr(frame)).toBe(5);
    expect(pollFinal(frame)).toBe(true);
  });
});
