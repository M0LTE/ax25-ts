/**
 * Property: the XID information-field codec (`src/xid.ts`) round-trips, and its
 * parser never throws. The TS analogue of packet.net's `XidInfoField` FsCheck
 * coverage (`m0lte/packet.net`), generalising the example-pinned `xid.test.ts`
 * (Figure 4.6 worked example + per-parameter cases) across the parameter space.
 *
 *  1. **Round-trip**: for any well-formed {@link XidParameters}, parsing the
 *     encoded bytes reproduces the same parameter set. The codec's own doc
 *     promises "`tryParseXid(encodeXid(x))` reproduces `x`"; this sweeps it.
 *     An *absent* field stays absent (¶1024 "use the currently-negotiated
 *     value") — distinct from a present default — so the comparison treats a
 *     missing key as `undefined`.
 *  2. **Parse-never-throws**: {@link tryParseXid} returns a clean
 *     `{ ok: false, reason }` (never throws) on arbitrary bytes, under BOTH the
 *     strict and lenient option sets; on success the parameters are well-formed.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  type ClassesOfProcedures,
  type HdlcOptionalFunctions,
  type RejectMode,
  type XidParameters,
  XID_PARSE_LENIENT,
  XID_PARSE_STRICT,
  encodeXid,
  tryParseXid,
} from "../../src/xid.js";

const RUNS = 3000;

const classesOfProceduresArb: fc.Arbitrary<ClassesOfProcedures> = fc.record({
  halfDuplex: fc.boolean(),
});

const rejectModeArb: fc.Arbitrary<RejectMode> = fc.constantFrom<RejectMode>(
  "implicit",
  "selective",
);

const hdlcOptionalFunctionsArb: fc.Arbitrary<HdlcOptionalFunctions> = fc.record({
  reject: rejectModeArb,
  modulo128: fc.boolean(),
  srejMultiframe: fc.boolean(),
  segmenterReassembler: fc.boolean(),
});

/**
 * A well-formed {@link XidParameters}. Each field is independently present or
 * absent (`undefined`), so the generator covers the full subset lattice the
 * encoder emits in ascending-PI order. Numeric ranges are chosen to round-trip
 * exactly:
 *   - `windowSizeRx` is masked to 0..127 by the encoder (single octet, bits
 *     0..6), so it is generated in 0..127.
 *   - the big-endian Type-B fields (`iFieldLengthRxBits`, `ackTimerMillis`,
 *     `retries`) round-trip for any non-negative integer whose PV is ≤ 255
 *     octets; bounded here to realistic on-air magnitudes.
 */
const xidParametersArb: fc.Arbitrary<XidParameters> = fc.record(
  {
    classesOfProcedures: classesOfProceduresArb,
    hdlcOptionalFunctions: hdlcOptionalFunctionsArb,
    iFieldLengthRxBits: fc.integer({ min: 0, max: 0xffff }),
    windowSizeRx: fc.integer({ min: 0, max: 127 }),
    ackTimerMillis: fc.integer({ min: 0, max: 0xffffff }),
    retries: fc.integer({ min: 0, max: 0xff }),
  },
  { requiredKeys: [] }, // every field is optional → present-or-absent lattice
);

/** Compare two optional fields: equal, or both absent. */
function sameOpt<T>(a: T | undefined, b: T | undefined, eq?: (x: T, y: T) => boolean): boolean {
  if (a === undefined || b === undefined) return a === b;
  return eq ? eq(a, b) : a === b;
}

function paramsEqual(a: XidParameters, b: XidParameters): boolean {
  return (
    sameOpt(
      a.classesOfProcedures,
      b.classesOfProcedures,
      (x, y) => x.halfDuplex === y.halfDuplex,
    ) &&
    sameOpt(
      a.hdlcOptionalFunctions,
      b.hdlcOptionalFunctions,
      (x, y) =>
        x.reject === y.reject &&
        x.modulo128 === y.modulo128 &&
        x.srejMultiframe === y.srejMultiframe &&
        x.segmenterReassembler === y.segmenterReassembler,
    ) &&
    sameOpt(a.iFieldLengthRxBits, b.iFieldLengthRxBits) &&
    sameOpt(a.windowSizeRx, b.windowSizeRx) &&
    sameOpt(a.ackTimerMillis, b.ackTimerMillis) &&
    sameOpt(a.retries, b.retries)
  );
}

describe("property: XID information-field round-trip", () => {
  it("tryParseXid(encodeXid(x)) reproduces x for any parameter subset", () => {
    fc.assert(
      fc.property(xidParametersArb, (params) => {
        const result = tryParseXid(encodeXid(params));
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(paramsEqual(result.parameters, params)).toBe(true);
        }
      }),
      { numRuns: RUNS },
    );
  });

  // Re-encoding the parsed result yields byte-identical output (the codec is a
  // canonical, deterministic encoder — ascending PI order, fixed widths).
  it("encode is idempotent through a parse cycle (byte-stable)", () => {
    fc.assert(
      fc.property(xidParametersArb, (params) => {
        const once = encodeXid(params);
        const reparsed = tryParseXid(once);
        expect(reparsed.ok).toBe(true);
        if (reparsed.ok) {
          const twice = encodeXid(reparsed.parameters);
          expect(Array.from(twice)).toEqual(Array.from(once));
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe("property: tryParseXid never throws (clean parse failure)", () => {
  const rawBytesArb = fc.uint8Array({ minLength: 0, maxLength: 64 });

  // Bias toward the valid FI/GI header so the parameter-loop (PI/PL/PV walk)
  // is reached often, not just the header rejection.
  const headerBiasedArb: fc.Arbitrary<Uint8Array> = fc
    .record({
      gl: fc.integer({ min: 0, max: 40 }),
      tail: fc.uint8Array({ minLength: 0, maxLength: 40 }),
    })
    .map(({ gl, tail }) =>
      Uint8Array.from([0x82, 0x80, (gl >> 8) & 0xff, gl & 0xff, ...tail]),
    );

  for (const options of [XID_PARSE_STRICT, XID_PARSE_LENIENT]) {
    const label =
      options === XID_PARSE_STRICT ? "strict" : "lenient";

    it(`returns ok:false (never throws) on pure-random bytes [${label}]`, () => {
      fc.assert(
        fc.property(rawBytesArb, (bytes) => {
          const r = tryParseXid(bytes, options);
          // Discriminated union — must always be one arm, never a throw.
          if (r.ok) {
            expect(r.parameters).toBeTypeOf("object");
          } else {
            expect(typeof r.reason).toBe("string");
          }
        }),
        { numRuns: RUNS },
      );
    });

    it(`returns a clean result on header-biased fuzz [${label}]`, () => {
      fc.assert(
        fc.property(headerBiasedArb, (bytes) => {
          const r = tryParseXid(bytes, options);
          if (r.ok) {
            // Recognised numeric parameters decode to non-negative integers.
            const p = r.parameters;
            for (const v of [
              p.iFieldLengthRxBits,
              p.windowSizeRx,
              p.ackTimerMillis,
              p.retries,
            ]) {
              if (v !== undefined) {
                expect(Number.isInteger(v)).toBe(true);
                expect(v).toBeGreaterThanOrEqual(0);
              }
            }
          } else {
            expect(typeof r.reason).toBe("string");
          }
        }),
        { numRuns: RUNS },
      );
    });
  }

  // The lenient option set must accept at least as much as strict: anything
  // strict accepts, lenient accepts too (leniency only widens). A divergence
  // would mean a lenient flag rejected something strict allowed — a real bug.
  it("lenient accepts a superset of strict", () => {
    fc.assert(
      fc.property(headerBiasedArb, (bytes) => {
        const strict = tryParseXid(bytes, XID_PARSE_STRICT);
        const lenient = tryParseXid(bytes, XID_PARSE_LENIENT);
        if (strict.ok) expect(lenient.ok).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });
});
