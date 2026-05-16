import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import {
  classify,
  decodeFrame,
  disc,
  dm,
  encodeFrame,
  getNr,
  getNs,
  iFrame,
  isCommand,
  isResponse,
  pollFinal,
  rr,
  sabm,
  ua,
  ui,
} from "../src/frame.js";

describe("frame codec — U frames", () => {
  it("builds and round-trips a SABM command", () => {
    const f = sabm({
      destination: Callsign.parse("GB7CIP"),
      source: Callsign.parse("M0LTE-2"),
    });
    expect(classify(f)).toBe("SABM");
    expect(isCommand(f)).toBe(true);
    expect(pollFinal(f)).toBe(true);
    const bytes = encodeFrame(f);
    const round = decodeFrame(bytes);
    expect(classify(round)).toBe("SABM");
    expect(round.source.callsign.toString()).toBe("M0LTE-2");
    expect(round.destination.callsign.toString()).toBe("GB7CIP");
  });

  it("builds and round-trips a UA response", () => {
    const f = ua({
      destination: Callsign.parse("M0LTE-2"),
      source: Callsign.parse("GB7CIP"),
    });
    expect(classify(f)).toBe("UA");
    expect(isResponse(f)).toBe(true);
    const round = decodeFrame(encodeFrame(f));
    expect(classify(round)).toBe("UA");
  });

  it("builds a DISC and a DM that classify correctly", () => {
    const d = disc({
      destination: Callsign.parse("A"),
      source: Callsign.parse("B"),
    });
    expect(classify(d)).toBe("DISC");
    const dmf = dm({
      destination: Callsign.parse("A"),
      source: Callsign.parse("B"),
    });
    expect(classify(dmf)).toBe("DM");
    expect(isResponse(dmf)).toBe(true);
  });

  it("builds a UI frame with the configured PID and payload", () => {
    const f = ui({
      destination: Callsign.parse("APRS"),
      source: Callsign.parse("M0LTE-9"),
      info: new TextEncoder().encode(">test"),
    });
    expect(classify(f)).toBe("UI");
    expect(f.pid).toBe(0xf0);
    const round = decodeFrame(encodeFrame(f));
    expect(round.pid).toBe(0xf0);
    expect(new TextDecoder().decode(round.info)).toBe(">test");
  });
});

describe("frame codec — S frames", () => {
  it("builds RR with the correct N(R) and PF bits", () => {
    const f = rr({
      destination: Callsign.parse("A"),
      source: Callsign.parse("B"),
      nr: 5,
      isCommand: false,
      pollFinal: true,
    });
    expect(classify(f)).toBe("RR");
    expect(getNr(f)).toBe(5);
    expect(pollFinal(f)).toBe(true);
    const round = decodeFrame(encodeFrame(f));
    expect(classify(round)).toBe("RR");
    expect(getNr(round)).toBe(5);
  });
});

describe("frame codec — I frames", () => {
  it("encodes N(R), N(S), P, PID, info", () => {
    const f = iFrame({
      destination: Callsign.parse("A"),
      source: Callsign.parse("B"),
      nr: 3,
      ns: 2,
      info: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      pollBit: true,
    });
    expect(classify(f)).toBe("I");
    expect(getNs(f)).toBe(2);
    expect(getNr(f)).toBe(3);
    expect(pollFinal(f)).toBe(true);
    const round = decodeFrame(encodeFrame(f));
    expect(classify(round)).toBe("I");
    expect(getNs(round)).toBe(2);
    expect(getNr(round)).toBe(3);
    expect(Array.from(round.info)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("rejects frames whose first address fields are broken", () => {
    // 14 bytes of zeros = malformed (E-bit clear past offset, etc.)
    const bad = new Uint8Array(15);
    expect(() => decodeFrame(bad)).toThrow();
  });
});

describe("frame factories with digipeaters", () => {
  it("sets the E-bit on the last digipeater, not on source", () => {
    const f = sabm({
      destination: Callsign.parse("GB7CIP"),
      source: Callsign.parse("M0LTE-2"),
      digipeaters: [Callsign.parse("G8BPQ"), Callsign.parse("M5XYZ-1")],
    });
    expect(f.source.extensionBit).toBe(false);
    expect(f.digipeaters[0]!.extensionBit).toBe(false);
    expect(f.digipeaters[1]!.extensionBit).toBe(true);
    const round = decodeFrame(encodeFrame(f));
    expect(round.digipeaters.length).toBe(2);
    expect(round.digipeaters[0]!.callsign.toString()).toBe("G8BPQ");
    expect(round.digipeaters[1]!.callsign.toString()).toBe("M5XYZ-1");
  });

  it("sets the E-bit on the source slot when no digipeaters", () => {
    const f = sabm({
      destination: Callsign.parse("A"),
      source: Callsign.parse("B"),
    });
    expect(f.source.extensionBit).toBe(true);
  });
});
