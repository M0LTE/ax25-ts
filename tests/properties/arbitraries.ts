/**
 * Shared fast-check arbitraries for the generative/property tier (Workstream 2
 * of the test-coverage campaign — see the PR). The scenario suite already pins
 * concrete spec examples; these generators let the property tests sweep the
 * *space* around them. They mirror the intent of packet.net's FsCheck
 * generators (`m0lte/packet.net`) — random I/S/U frames, random XID parameter
 * sets, random payloads/N1 — so the TS side closes the asymmetry called out in
 * `tests/conformance/loss-recovery.test.ts` ("ax25-ts has no property-testing
 * library on its dependency tree").
 *
 * Everything here produces only *well-formed* inputs (valid callsigns, in-range
 * sequence numbers, etc.) — the round-trip properties need a valid value to
 * start from. The "parser-never-throws" properties feed raw arbitrary bytes
 * instead (built inline in their own files), so they don't use these.
 */
import fc from "fast-check";
import { Callsign } from "../../src/callsign.js";
import {
  type Ax25Frame,
  PID_NO_LAYER_3,
  disc,
  dm,
  iFrame,
  rej,
  rnr,
  rr,
  sabm,
  sabme,
  srej,
  ua,
  ui,
} from "../../src/frame.js";

/** A single valid callsign base character (A-Z / 0-9), matching
 * {@link Callsign}'s `isValidBaseChar`. */
const baseChar = fc.constantFrom(
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split(""),
);

/**
 * A valid {@link Callsign}: 1-6 base chars + SSID 0-15. The base is left of any
 * padding (no internal spaces), so it survives the address codec's
 * "non-space-after-padding" check — i.e. every generated callsign round-trips
 * through {@link writeAddress}/{@link readAddress}.
 */
export const callsignArb: fc.Arbitrary<Callsign> = fc
  .tuple(
    fc.array(baseChar, { minLength: 1, maxLength: 6 }).map((cs) => cs.join("")),
    fc.integer({ min: 0, max: 15 }),
  )
  .map(([base, ssid]) => new Callsign(base, ssid));

/** 0..8 digipeater callsigns (AX.25 allows at most 8 — §3.12.5). */
export const digipeatersArb: fc.Arbitrary<Callsign[]> = fc.array(callsignArb, {
  minLength: 0,
  maxLength: 8,
});

/** An information field of 0..N bytes (default 0..64). */
export function infoArb(maxLength = 64): fc.Arbitrary<Uint8Array> {
  return fc
    .array(fc.integer({ min: 0, max: 255 }), { minLength: 0, maxLength })
    .map((xs) => Uint8Array.from(xs));
}

/** Routing common to every frame factory: dest, source, optional via. */
const routingArb = fc.record({
  destination: callsignArb,
  source: callsignArb,
  digipeaters: digipeatersArb,
});

/**
 * A random AX.25 frame in the requested modulo. Covers every frame kind the
 * codec builds — I/S (mod-aware sequence numbers + P/F) and U (modulo-
 * independent) — so a round-trip property exercises the whole control-field
 * space. The N(S)/N(R) ranges are mod-aware: 0..127 under `extended`, 0..7
 * under mod-8, matching Fig 4.1b's 7-bit vs 3-bit sequence fields.
 */
export function frameArb(extended: boolean): fc.Arbitrary<Ax25Frame> {
  const seqMax = extended ? 127 : 7;
  const nr = fc.integer({ min: 0, max: seqMax });
  const ns = fc.integer({ min: 0, max: seqMax });
  const pf = fc.boolean();
  const isCommand = fc.boolean();

  const iArb = fc
    .record({ routing: routingArb, nr, ns, info: infoArb(), pf })
    .map(({ routing, nr, ns, info, pf }) =>
      iFrame({ ...routing, nr, ns, info, pollBit: pf, extended }),
    );

  // Supervisory frames (RR/RNR/REJ/SREJ): carry N(R) + P/F, command-or-response.
  const sFactory = fc.constantFrom(rr, rnr, rej, srej);
  const sArb = fc
    .record({ routing: routingArb, factory: sFactory, nr, isCommand, pf })
    .map(({ routing, factory, nr, isCommand, pf }) =>
      factory({ ...routing, nr, isCommand, pollFinal: pf, extended }),
    );

  // U frames — 1-octet control in both modulos; `extended` does not apply.
  const sabmArb = fc
    .record({ routing: routingArb, pf })
    .map(({ routing, pf }) => sabm({ ...routing, pollBit: pf }));
  const sabmeArb = fc
    .record({ routing: routingArb, pf })
    .map(({ routing, pf }) => sabme({ ...routing, pollBit: pf }));
  const discArb = fc
    .record({ routing: routingArb, pf })
    .map(({ routing, pf }) => disc({ ...routing, pollBit: pf }));
  const uaArb = fc
    .record({ routing: routingArb, pf })
    .map(({ routing, pf }) => ua({ ...routing, finalBit: pf }));
  const dmArb = fc
    .record({ routing: routingArb, pf })
    .map(({ routing, pf }) => dm({ ...routing, finalBit: pf }));
  const uiArb = fc
    .record({
      routing: routingArb,
      info: infoArb(),
      pid: fc.integer({ min: 0, max: 255 }),
      isCommand,
      pf,
    })
    .map(({ routing, info, pid, isCommand, pf }) =>
      ui({ ...routing, info, pid, isCommand, pollFinal: pf }),
    );

  // U frames are valid in both modulos; the `extended` flag only widens I/S.
  const uArb = fc.oneof(sabmArb, sabmeArb, discArb, uaArb, dmArb, uiArb);

  return fc.oneof(iArb, sArb, uArb);
}

export { PID_NO_LAYER_3 };
