/**
 * @packet-net/ax25 — browser-targeted TypeScript library for AX.25 v2.2
 * connected-mode sessions over Web Serial KISS modems.
 *
 * Quick start (see README for the long-form):
 *
 * ```ts
 * import {
 *   Ax25Stack,
 *   WebSerialKissTransport,
 *   Callsign,
 * } from "@packet-net/ax25";
 *
 * const port = await navigator.serial.requestPort();
 * const transport = new WebSerialKissTransport(port, { baudRate: 9600 });
 * const stack = new Ax25Stack(transport);
 * await stack.start();
 * const session = await stack.connect({ from: "M0LTE-2", to: "GB7CIP" });
 * session.onData((chunk) => console.log(new TextDecoder().decode(chunk)));
 * await session.write(new TextEncoder().encode("hello\r"));
 * // ...
 * await session.disconnect();
 * await stack.stop();
 * ```
 *
 * Scope summary — what IS and ISN'T implemented:
 *
 *   ✓ Frame codec for SABM, DISC, UA, DM, UI, RR, RNR, REJ, I (mod-8)
 *   ✓ 7-octet callsign codec with SSID + C/H + E bit handling
 *   ✓ KISS framing (FEND/FESC escape, port nibble)
 *   ✓ Web Serial transport (Chrome / Edge / Opera on a desktop with the
 *     `chrome://flags/#enable-experimental-web-platform-features` setting,
 *     or unflagged in supported browsers)
 *   ✓ SABM → UA → Connected, DISC → UA → Disconnected
 *   ✓ I-frame TX/RX with V(s)/V(r)/V(a) bookkeeping, k=1 window
 *   ✓ T1 retry (default 3 s), capped at N2 (default 10)
 *   ✓ Session state machine walks the generated SDL tables in
 *     [`ax25sdl`](../../../ts-spec/) — same transitions as the C# runtime
 *     reads from `src/Packet.Ax25.Sdl/*.g.cs`
 *
 *   ✗ mod-128 (SABME, extended sequence numbers)
 *   ✗ T1 dynamic adjustment (the `Select_T1_Value` subroutine is stubbed)
 *   ✗ FRMR generation/handling
 *   ✗ Multi-frame TX windowing (k=1 hard-coded; the SDL guard
 *     `V_s_eq_V_a_plus_k` reads ctx.k so widening is a single-line change)
 *   ✗ Full figc4.7 subroutine framework (the dispatcher inlines the
 *     subset the happy path needs; the rest route through a no-op
 *     registry, which means REJ/SREJ recovery and Enquiry_Response
 *     don't have real bodies yet)
 *   ✗ Digipeater paths (`via` throws "not implemented")
 *   ✗ TCP/AGW/audio transports — Web Serial only
 *   ✗ Inbound connection acceptance (no `onConnectRequest` API)
 */

export { Callsign } from "./callsign.js";
export {
  ADDRESS_ENCODED_LENGTH,
  type Ax25Address,
  readAddress,
  writeAddress,
} from "./address.js";
export {
  type Ax25Frame,
  type FrameFactoryOpts,
  type FrameKind,
  MAX_DIGIPEATERS,
  PID_NET_ROM,
  PID_NO_LAYER_3,
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
  requiredBytes,
  rej,
  rnr,
  rr,
  sabm,
  ua,
  ui,
} from "./frame.js";
export {
  FEND,
  FESC,
  KISS_CMD,
  type KissCommand,
  KissDecoder,
  type KissFrame,
  TFEND,
  TFESC,
  encodeKiss,
} from "./kiss.js";
export type { Ax25Transport } from "./transport.js";
export {
  WebSerialKissTransport,
  type WebSerialKissTransportOptions,
  type WebSerialLikePort,
} from "./webserial-transport.js";
export {
  Ax25Session,
  type Ax25SessionOptions,
  Ax25Stack,
} from "./session.js";
