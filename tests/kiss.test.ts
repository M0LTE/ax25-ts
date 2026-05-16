import { describe, expect, it } from "vitest";
import {
  FEND,
  FESC,
  KISS_CMD,
  KissDecoder,
  TFEND,
  TFESC,
  encodeKiss,
} from "../src/kiss.js";

describe("KISS encode", () => {
  it("wraps a payload with FENDs and a command byte", () => {
    const wire = encodeKiss(0, KISS_CMD.Data, new Uint8Array([1, 2, 3]));
    expect(wire[0]).toBe(FEND);
    expect(wire[wire.length - 1]).toBe(FEND);
    // No escapes needed → length = 2 FENDs + 1 cmd + 3 payload = 6
    expect(wire.length).toBe(6);
    expect(wire[1]).toBe(0x00); // port=0, cmd=Data
  });

  it("escapes FEND inside the payload", () => {
    const wire = encodeKiss(0, KISS_CMD.Data, new Uint8Array([FEND]));
    expect(Array.from(wire)).toEqual([FEND, 0x00, FESC, TFEND, FEND]);
  });

  it("escapes FESC inside the payload", () => {
    const wire = encodeKiss(0, KISS_CMD.Data, new Uint8Array([FESC]));
    expect(Array.from(wire)).toEqual([FEND, 0x00, FESC, TFESC, FEND]);
  });

  it("encodes the multi-drop port nibble in the command byte", () => {
    const wire = encodeKiss(5, KISS_CMD.Data, new Uint8Array(0));
    // Without escaping (port=5, cmd=0) the command byte is 0x50.
    expect(wire[1]).toBe(0x50);
  });

  it("rejects port > 15", () => {
    expect(() => encodeKiss(16, KISS_CMD.Data, new Uint8Array(0))).toThrow();
  });
});

describe("KISS decode", () => {
  it("extracts one frame from a complete wire stream", () => {
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const wire = encodeKiss(0, KISS_CMD.Data, payload);
    const dec = new KissDecoder();
    const frames = dec.push(wire);
    expect(frames.length).toBe(1);
    expect(frames[0]!.port).toBe(0);
    expect(frames[0]!.command).toBe(KISS_CMD.Data);
    expect(Array.from(frames[0]!.payload)).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it("reassembles a frame split across multiple pushes", () => {
    const wire = encodeKiss(0, KISS_CMD.Data, new Uint8Array([1, 2, 3, 4]));
    const dec = new KissDecoder();
    const f1 = dec.push(wire.subarray(0, 2));
    const f2 = dec.push(wire.subarray(2, 4));
    const f3 = dec.push(wire.subarray(4));
    expect(f1.length).toBe(0);
    expect(f2.length).toBe(0);
    expect(f3.length).toBe(1);
    expect(Array.from(f3[0]!.payload)).toEqual([1, 2, 3, 4]);
  });

  it("unescapes FEND/FESC inside the payload", () => {
    const original = new Uint8Array([FEND, FESC, 0x00, FEND]);
    const wire = encodeKiss(0, KISS_CMD.Data, original);
    const dec = new KissDecoder();
    const frames = dec.push(wire);
    expect(frames.length).toBe(1);
    expect(Array.from(frames[0]!.payload)).toEqual(Array.from(original));
  });

  it("silently drops empty inter-frame FENDs (re-sync prefix)", () => {
    const wire = encodeKiss(0, KISS_CMD.Data, new Uint8Array([0x11]));
    const prefix = new Uint8Array([FEND, FEND, FEND]);
    const combined = new Uint8Array(prefix.length + wire.length);
    combined.set(prefix, 0);
    combined.set(wire, prefix.length);
    const dec = new KissDecoder();
    const frames = dec.push(combined);
    expect(frames.length).toBe(1);
    expect(Array.from(frames[0]!.payload)).toEqual([0x11]);
  });
});
