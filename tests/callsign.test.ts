import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";

describe("Callsign", () => {
  it("parses BASE form", () => {
    const c = Callsign.parse("G7XYZ");
    expect(c.base).toBe("G7XYZ");
    expect(c.ssid).toBe(0);
    expect(c.toString()).toBe("G7XYZ");
  });

  it("parses BASE-SSID form", () => {
    const c = Callsign.parse("M0LTE-7");
    expect(c.base).toBe("M0LTE");
    expect(c.ssid).toBe(7);
    expect(c.toString()).toBe("M0LTE-7");
  });

  it("rejects SSID > 15", () => {
    expect(() => Callsign.parse("M0LTE-16")).toThrow();
  });

  it("rejects lowercase", () => {
    expect(() => Callsign.parse("m0lte")).toThrow();
  });

  it("rejects empty base", () => {
    expect(() => Callsign.parse("")).toThrow();
  });

  it("rejects base > 6 chars", () => {
    expect(() => Callsign.parse("G7XYZ12")).toThrow();
  });

  it("compares by value", () => {
    const a = Callsign.parse("G7ABC-1");
    const b = Callsign.parse("G7ABC-1");
    const c = Callsign.parse("G7ABC-2");
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });

  it("permits empty base via direct constructor (BPQ ID-beacon parity)", () => {
    const c = new Callsign("", 0);
    expect(c.base).toBe("");
    expect(c.toString()).toBe("");
  });
});
