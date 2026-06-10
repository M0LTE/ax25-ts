/**
 * Paired strict-rejects / lenient-accepts coverage for the {@link Ax25ParseOptions}
 * flags added for parity with packet.net lib-v0.7.0:
 *
 *   - `allowCommandFrameAsResponse` (packet.net#142): strict rejects a
 *     response-direction SABM/SABME/DISC at decode; lenient (the default)
 *     accepts it for AX.25 v1.x interop.
 *   - `allowEmptyCallsignBase`: strict rejects an all-space callsign slot;
 *     lenient accepts it (BPQ `>IS` ID beacons put them on the air).
 *   - the peer presets (BPQ/XROUTER/DIREWOLF) mirror the C# preset aliases.
 *
 * TS port of the C# `Ax25FrameOptionsTests` strict/lenient pairs.
 */
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import {
  BPQ_PARSE,
  DIREWOLF_PARSE,
  LENIENT_PARSE,
  STRICT_PARSE,
  XROUTER_PARSE,
  classify,
  decodeFrame,
  encodeFrame,
  isResponse,
  pollFinal,
  sabm,
  test as testFrame,
  ui,
} from "../src/frame.js";

const Local = Callsign.parse("M0LTE");
const Peer = Callsign.parse("G7XYZ-7");

/** A SABM whose address C-bits mark it a *response* — the v1.x-flavoured
 * connect (#142). Same bit-twiddle as the C# tests: build a normal (command)
 * SABM, clear the destination C-bit, set the source C-bit. */
function responseSabmBytes(): Uint8Array {
  const bytes = encodeFrame(sabm({ destination: Local, source: Peer }));
  bytes[6]! &= 0x7f; // destination SSID octet: clear C-bit
  bytes[13]! |= 0x80; // source SSID octet: set C-bit → response shape
  return bytes;
}

describe("allowCommandFrameAsResponse (#142 parity)", () => {
  it("strict rejects a response-direction SABM at decode; lenient accepts the same bytes", () => {
    const bytes = responseSabmBytes();

    expect(() => decodeFrame(bytes, false, STRICT_PARSE)).toThrow(
      /allowCommandFrameAsResponse/,
    );

    const lenient = decodeFrame(bytes, false, LENIENT_PARSE);
    expect(classify(lenient)).toBe("SABM");
    expect(isResponse(lenient)).toBe(true);

    // The default parse is the lenient one (v1.x interop preserved).
    expect(classify(decodeFrame(bytes))).toBe("SABM");
  });

  it("strict still accepts a spec-valid (command) SABM", () => {
    const bytes = encodeFrame(sabm({ destination: Local, source: Peer }));
    expect(classify(decodeFrame(bytes, false, STRICT_PARSE))).toBe("SABM");
  });
});

describe("allowEmptyCallsignBase", () => {
  it("strict rejects an all-space callsign slot; lenient accepts it", () => {
    // A BPQ-style ID beacon: UI frame whose destination base is empty
    // (all-space on the wire). The TS Callsign permits an empty base when
    // constructed directly (wire-shape), so the factory can build it.
    const bytes = encodeFrame(
      ui({
        destination: new Callsign("", 0),
        source: Peer,
        info: Uint8Array.from([0x49, 0x44]),
        isCommand: true,
      }),
    );

    expect(() => decodeFrame(bytes, false, STRICT_PARSE)).toThrow(
      /allowEmptyCallsignBase/,
    );

    const lenient = decodeFrame(bytes, false, LENIENT_PARSE);
    expect(lenient.destination.callsign.base).toBe("");
    expect(classify(decodeFrame(bytes))).toBe("UI"); // the default stays lenient
  });
});

describe("peer presets", () => {
  it("mirror the C# preset aliases (BPQ/Direwolf lenient-shaped, Xrouter strict-shaped)", () => {
    expect(BPQ_PARSE).toEqual(LENIENT_PARSE);
    expect(DIREWOLF_PARSE).toEqual(LENIENT_PARSE);
    expect(XROUTER_PARSE).toEqual(STRICT_PARSE);
  });
});

describe("TEST frame (§4.3.3.8)", () => {
  it("round-trips through the factory, classifies as TEST, and carries P/F + info", () => {
    const info = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    const cmd = testFrame({
      destination: Peer,
      source: Local,
      info,
      isCommand: true,
    });
    const decoded = decodeFrame(encodeFrame(cmd));
    expect(classify(decoded)).toBe("TEST");
    expect(pollFinal(decoded)).toBe(true); // factory defaults P set on a command
    expect(Array.from(decoded.info)).toEqual(Array.from(info));

    const resp = testFrame({
      destination: Local,
      source: Peer,
      info,
      isCommand: false,
      pollFinal: false,
    });
    const decodedResp = decodeFrame(encodeFrame(resp));
    expect(classify(decodedResp)).toBe("TEST");
    expect(isResponse(decodedResp)).toBe(true);
    expect(pollFinal(decodedResp)).toBe(false);
  });
});
