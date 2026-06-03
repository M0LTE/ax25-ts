/**
 * Property: frame encode → parse round-trip, in BOTH modulos (mod-8 and
 * extended/mod-128). For any well-formed I/S/U frame the codec builds,
 * `decodeFrame(encodeFrame(f), extended)` reproduces every field — addresses
 * (callsign + C/H + E bits), the control octet(s), PID, and the information
 * field — and the mode-aware accessors recover the 7-bit N(S)/N(R) + P/F under
 * mod-128 (including the 127→0 wrap).
 *
 * Generative tier (fast-check) for the v2.2 frame surface — the property
 * generalisation of the example-pinned `frame.test.ts` /
 * `frame-extended.test.ts` scenario suites, and the TS analogue of packet.net's
 * FsCheck frame round-trip property. The control-field width is not derivable
 * from the bytes alone (Fig 4.1b), so the parse is fed the same modulo the frame
 * was built in — exactly what the real receive path does from the session's
 * negotiated modulo.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Callsign } from "../../src/callsign.js";
import {
  type Ax25Address,
  type Ax25Frame,
  classify,
  decodeFrame,
  encodeFrame,
  getNr,
  getNs,
  iFrame,
  isExtendedControl,
  pollFinal,
} from "../../src/frame.js";
import { frameArb } from "./arbitraries.js";

const RUNS = 2000;

function addressesEqual(a: Ax25Address, b: Ax25Address): boolean {
  return (
    a.callsign.equals(b.callsign) &&
    a.crhBit === b.crhBit &&
    a.extensionBit === b.extensionBit
  );
}

/** Every field the codec is responsible for preserving must survive the
 * round-trip exactly. */
function expectFrameEqual(got: Ax25Frame, want: Ax25Frame): void {
  expect(addressesEqual(got.destination, want.destination)).toBe(true);
  expect(addressesEqual(got.source, want.source)).toBe(true);
  expect(got.digipeaters.length).toBe(want.digipeaters.length);
  for (let i = 0; i < want.digipeaters.length; i++) {
    expect(addressesEqual(got.digipeaters[i]!, want.digipeaters[i]!)).toBe(true);
  }
  expect(got.control).toBe(want.control);
  expect(got.controlExtension).toBe(want.controlExtension);
  expect(got.pid).toBe(want.pid);
  expect(Array.from(got.info)).toEqual(Array.from(want.info));
}

describe("property: frame encode→parse round-trip", () => {
  for (const extended of [false, true]) {
    const modLabel = extended ? "mod-128 (extended)" : "mod-8";

    it(`reproduces every field for any I/S/U frame [${modLabel}]`, () => {
      fc.assert(
        fc.property(frameArb(extended), (frame) => {
          const round = decodeFrame(encodeFrame(frame), extended);
          expectFrameEqual(round, frame);
        }),
        { numRuns: RUNS },
      );
    });

    it(`classification is stable across the round-trip [${modLabel}]`, () => {
      fc.assert(
        fc.property(frameArb(extended), (frame) => {
          const round = decodeFrame(encodeFrame(frame), extended);
          expect(classify(round)).toBe(classify(frame));
        }),
        { numRuns: RUNS },
      );
    });
  }
});

// The extended axis carries the load-bearing claim of mod-128: the 7-bit
// N(S)/N(R) and the migrated P/F bit (octet1 bit 0, Fig 4.1b) survive where
// mod-8 would mask to 3 bits. fast-check's integer range includes the 0 and 127
// boundaries directly, so the 127→0 wrap is always inside the sampled space.
describe("property: extended I-frame sequence-number fidelity", () => {
  const dest = new Callsign("M0LTE", 0);
  const src = new Callsign("G7XYZ", 7);

  it("7-bit N(S)/N(R) + migrated P/F survive at mod-128", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 127 }),
        fc.integer({ min: 0, max: 127 }),
        fc.boolean(),
        (ns, nr, poll) => {
          const sent = iFrame({
            destination: dest,
            source: src,
            nr,
            ns,
            info: new Uint8Array([ns & 0xff]),
            pollBit: poll,
            extended: true,
          });
          const got = decodeFrame(encodeFrame(sent), true);
          expect(isExtendedControl(got)).toBe(true);
          expect(getNs(got)).toBe(ns);
          expect(getNr(got)).toBe(nr);
          expect(pollFinal(got)).toBe(poll);
        },
      ),
      { numRuns: RUNS },
    );
  });

  // Explicit wrap-boundary cases — fast-check samples these too, but pinning
  // them documents the 127↔0 edge the mod-128 7-bit field must not alias.
  it("the 127↔0 sequence wrap is exact (boundary pins)", () => {
    for (const [ns, nr] of [
      [127, 0],
      [0, 127],
      [127, 127],
      [0, 0],
    ] as const) {
      const got = decodeFrame(
        encodeFrame(
          iFrame({
            destination: dest,
            source: src,
            nr,
            ns,
            info: new Uint8Array([0]),
            pollBit: true,
            extended: true,
          }),
        ),
        true,
      );
      expect(getNs(got)).toBe(ns);
      expect(getNr(got)).toBe(nr);
    }
  });
});
