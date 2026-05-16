# `@packet-net/ax25`

Browser-targeted TypeScript library for AX.25 v2.2 connected-mode sessions over KISS modems. Open a connection to a remote callsign, get back a bidirectional `Stream`-ish session with `onData(...)`, `write(...)`, and `disconnect()`. The library walks the generated AX.25 SDL state-machine tables verbatim — no prior amateur-radio-app-development experience required to use it.

## Install

```sh
npm install @packet-net/ax25
```

## Quick start (Web Serial)

A complete browser app — open a USB modem, connect to `GB7CIP`, send a line, receive replies, disconnect:

```ts
import {
  Ax25Stack,
  Callsign,
  WebSerialKissTransport,
} from "@packet-net/ax25";

// User-gesture-driven port picker (a button's onclick handler, typically):
const port = await navigator.serial.requestPort();

const transport = new WebSerialKissTransport(port, { baudRate: 9600 });
const stack = new Ax25Stack(transport);
await stack.start();

const session = await stack.connect({
  from: Callsign.parse("M0LTE-2"),
  to: "GB7CIP",
});

session.onData((chunk) => console.log(new TextDecoder().decode(chunk)));
session.onDisconnected(() => console.log("link closed"));

await session.write(new TextEncoder().encode("hello\r"));

// Later, when the user clicks "disconnect":
await session.disconnect();
await stack.stop();
```

The same code as a typechecking file lives at [`examples/quick-start.ts`](examples/quick-start.ts). Two more end-to-end examples (Node TCP, in-memory mock for unit tests) live alongside it — see [`examples/`](examples/).

## Transport seams

`Ax25Stack` accepts any `Ax25Transport` (a 3-method interface: `start` / `send` / `stop`). The library ships three concrete transports plus a documented "implement-your-own" seam:

| Transport | Where it lives | Environment | Status |
| --- | --- | --- | --- |
| `WebSerialKissTransport` | `@packet-net/ax25` main entry | Chromium browsers (Chrome / Edge / Opera / Brave) | Provided |
| `TcpKissTransport` | `@packet-net/ax25/tcp-transport` subpath | Node.js (uses `node:net`) | Provided |
| `MockTransport` | `tests/mock-transport.ts` (not in published bundle — copy into your project for testing) | Anywhere | Provided for tests |
| AGW (over TCP) | n/a | Node | Not yet implemented |
| AXUDP | n/a | Node | Not yet implemented |
| Audio (modem-in-browser) | n/a | Browser | Not yet implemented |

To roll your own, implement `Ax25Transport` and pass it to `new Ax25Stack(yourTransport)`.

## Scope — what's in v0.1, what's deliberately out

> The tables below are the consumer-facing view of *this runtime's* scope. For the **cross-runtime** view — which capabilities exist in C# but not TS (or vice versa), which transports each runtime ships, which SDL subroutines are wired where — see [`docs/runtime-capability-matrix.md`](../../docs/runtime-capability-matrix.md). The matrix is the canonical multi-runtime status doc; the tables here stay focused on `@packet-net/ax25` itself.

### In

- Frame codec for U/S/I frames (mod-8): SABM, UA, DISC, DM, UI, RR, RNR, REJ, I.
- 7-octet callsign codec with SSID + C/H + E-bit handling.
- KISS framing (FEND/FESC/TFEND/TFESC, multi-port nibble).
- Web Serial transport for the browser.
- Node TCP transport for KISS-over-TCP listeners (BPQ / Xrouter / direwolf / net-sim).
- Table-driven session machine that walks the generated SDL transitions in [`ax25sdl`](../../ts-spec/) — same architecture as the C# runtime in [`src/Packet.Ax25/Session/`](../../src/Packet.Ax25/Session/).
- SABM → UA → Connected, DISC → UA → Disconnected.
- I-frame TX/RX with V(s)/V(r)/V(a) bookkeeping, k=1 outstanding window, FIFO TX queue.
- T1 retry capped at N2 (default 10), SDL `RC_eq_N2` guard.
- Public API: `Ax25Stack`, `Ax25Session`, `Ax25Frame`, `Callsign`, KISS helpers, `Ax25Transport` interface.

### Out (deliberate — will land in later versions)

| Missing feature | Behaviour today | Tracked for |
| --- | --- | --- |
| mod-128 (SABME, extended sequence numbers) | SDL `version_2_2` / `mod_128` predicates return false; mod-128 branches route-around | post-v0.1 |
| REJ / SREJ recovery loops | Wire frames emit, but the `Invoke_Retransmission` / `N_r_Error_Recovery` subroutines are no-op stubs | post-v0.1 |
| FRMR generation / handling | Inbound FRMR silently dropped | post-v0.1 |
| figc4.7 subroutine walker | The dispatcher inlines `Establish_Data_Link` + `Check_I_Frame_Acknowledged`; everything else routes through no-op registry stubs | post-v0.1 |
| Multi-frame TX window (k>1) | Hard-coded k=1 | post-v0.1 |
| `via` digipeater paths | `stack.connect({ via: [...] })` throws | post-v0.1 |
| AGW client / server | Not implemented (Node-side; the [Packet.Agw .NET package](../../src/Packet.Agw/) has the working reference impl) | post-v0.1 |
| Audio modem transport (browser-side AFSK) | Not implemented | post-v0.1 |
| Inbound connection acceptance | A SABM to us with no matching outbound session is silently dropped — no `onConnectRequest` API yet | post-v0.1 |
| XID negotiation | Not implemented — defaults used (mod-8, no SREJ) | post-v0.1 |
| Dynamic T1 (`Select_T1_Value`) | Stub; caller-supplied `t1Ms` is honoured for the lifetime of the session | post-v0.1 |

## Documentation

- **API reference** — [`docs/web-ax25/api/`](../../docs/web-ax25/api/) (regenerated by `npm run docs`; see also the [docs index](../../docs/web-ax25/README.md)).
- **Worked examples** — [`examples/`](examples/) — three self-contained, typechecked examples (Web Serial, Node TCP, in-memory mock).
- **Distribution & publishing** — [`docs/web-ax25/publishing.md`](../../docs/web-ax25/publishing.md). Written for `.NET` / NuGet veterans new to npm.
- **Changelog** — [`CHANGELOG.md`](CHANGELOG.md).
- **C# reference implementation** — for spec-purity-minded readers, [`src/Packet.Ax25/Session/`](../../src/Packet.Ax25/Session/) is the fuller AX.25 v2.2 runtime, walking the same SDL transitions this library walks. It implements the figc4.7 subroutines and REJ/SREJ recovery this library currently stubs.

## Browser compatibility

Web Serial is supported in Chromium-based browsers (Chrome, Edge, Opera, Brave) on desktop OSes. Firefox and Safari don't expose it. The user must grant permission per port via `navigator.serial.requestPort()` from a user-gesture handler (button click, etc.).

For non-browser environments (Node.js, Bun, Deno) reach for the `TcpKissTransport` subpath import (`@packet-net/ax25/tcp-transport`) or implement your own transport against `Ax25Transport`.

## Source layout

```
src/
├── address.ts                 Ax25Address record + codec
├── callsign.ts                Callsign type
├── frame.ts                   Ax25Frame, factories, encode/decode, classify
├── kiss.ts                    KISS framing (FEND/FESC/TFEND/TFESC)
├── transport.ts               Ax25Transport interface
├── webserial-transport.ts     KISS over Web Serial port
├── tcp-transport.ts           KISS over TCP socket (Node-only)
├── session.ts                 Public Ax25Stack / Ax25Session — wraps the SDL driver
└── sdl/                       Table-walking session engine
    ├── events.ts                  Ax25Event variants (frame-receipt, timer, DL primitives)
    ├── timer-scheduler.ts         T1/T2/T3 arming + isRunning bindings
    ├── session-context.ts         Mutable per-session state (V(S)/V(A)/V(R), flags, queues)
    ├── guard-evaluator.ts         Parses `"a and not b or c"` against a bindings dict
    ├── session-bindings.ts        Builds the dict — predicate name → closure
    ├── action-dispatcher.ts       Switch over the ~140 SDL action verbs
    ├── subroutine-registry.ts     figc4.7 subroutine stub registry (gaps documented)
    └── session-driver.ts          PostEvent → find transition → execute → advance
```

## License

[MIT](LICENSE) — copyright Tom Fanning and Packet.NET contributors.
