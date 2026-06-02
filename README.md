# `@packet-net/ax25`

Browser-targeted TypeScript library for AX.25 v2.2 connected-mode sessions over KISS modems. Open a connection to a remote callsign, get back a bidirectional `Stream`-ish session with `onData(...)`, `write(...)`, and `disconnect()`. The library walks the generated AX.25 SDL state-machine tables verbatim — no prior amateur-radio-app-development experience required to use it.

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

The same code as a typechecking file lives at [`examples/quick-start.ts`](examples/quick-start.ts). Two more end-to-end examples (Node TCP, in-memory mock for unit tests) live alongside it in [`examples/`](examples/).

## Listening for inbound connections

`Ax25Stack` is outbound-only. For node-style usage (BBS, gateway, automatic forwarder, TUI), reach for `Ax25Listener` — it owns one transport, address-filters inbound frames against your callsign, builds (or reuses) a session on the first SABM from each peer, and surfaces `sessionAccepted` so application code can wire per-session handlers.

```ts
import {
  Ax25Listener,
  Callsign,
} from "@packet-net/ax25";
import { TcpKissTransport } from "@packet-net/ax25/tcp-transport";

const transport = new TcpKissTransport("127.0.0.1", 8100, { kissPort: 0 });
const listener = new Ax25Listener(transport, {
  myCall: Callsign.parse("M0LTE-1"),
});

listener.onSessionAccepted((session) => {
  console.log("inbound from", session.context.remote.toString());

  // Once the session is Connected, the SDL accepts DL_DATA_request:
  session.postEvent({
    name: "DL_DATA_request",
    data: new TextEncoder().encode("Hello!\r"),
    pid: 0xf0,
  });

  // Surface inbound I-frames / disconnects:
  session.onDataLinkSignal((sig) => {
    if (sig.type === "DL_DATA_indication") {
      process.stdout.write(new TextDecoder().decode(sig.data));
    }
    if (sig.type === "DL_DISCONNECT_indication" || sig.type === "DL_DISCONNECT_confirm") {
      console.log("peer disconnected");
    }
  });
});

await listener.start();
```

Per-peer sessions are cached, surviving disconnect — sequence-variable history and SRT/T1V smoothing carry over to the next connect from the same callsign. The cache evicts LRU past `maxCachedPeers` (default 64). Full worked example at [`examples/inbound-listener.ts`](examples/inbound-listener.ts).

## Transports

`Ax25Stack` accepts any `Ax25Transport` (a 3-method interface: `start` / `send` / `stop`). The library ships three concrete transports plus a documented "implement-your-own" seam:

| Transport | Where | Environment | Status |
| --- | --- | --- | --- |
| `WebSerialKissTransport` | main entry | Chromium browsers (Chrome / Edge / Opera / Brave) | ✓ |
| `TcpKissTransport` | `/tcp-transport` subpath | Node.js | ✓ |
| `MockTransport` | `tests/mock-transport.ts` | Anywhere (test-only) | ✓ |
| AGW (over TCP) | — | Node | not implemented |
| AXUDP | — | Node | not implemented |
| Audio (browser AFSK) | — | Browser | not implemented |

To roll your own, implement `Ax25Transport` and pass it to `new Ax25Stack(yourTransport)`.

## Scope — what's in, what's out

### In

- Frame codec for U/S/I frames in **both modulos**: SABM, SABME, UA, DISC, DM, UI, RR, RNR, REJ, SREJ, I. The extended (mod-128) 2-octet control field on I and S frames is wired — 7-bit N(S)/N(R) + mode-aware P/F (Fig 4.1b), with the receive path threading the session's negotiated modulo (v2.2 arc V1, parity with [`m0lte/packet.net#266`](https://github.com/m0lte/packet.net/pull/266)). U frames stay 1 octet in both modes.
- 7-octet callsign codec with SSID + C/H + E-bit handling.
- KISS framing (FEND/FESC/TFEND/TFESC, multi-port nibble).
- Web Serial transport for the browser, Node TCP for KISS-over-TCP listeners (BPQ / Xrouter / direwolf / net-sim).
- Table-driven session machine walking the SDL transitions from [`ax25sdl`](https://www.npmjs.com/package/ax25sdl) — same architecture as the C# reference runtime in [`m0lte/packet.net`'s `Packet.Ax25`](https://github.com/m0lte/packet.net/tree/main/src/Packet.Ax25/Session).
- SABM → UA → Connected, DISC → UA → Disconnected, I-frame TX/RX with V(s)/V(r)/V(a) bookkeeping, T1 retry capped at N2.
- **Inbound listener** — `Ax25Listener` accepts inbound SABM, fires `sessionAccepted`, caches per-peer sessions with LRU eviction, mirrors AX.25 §C.2 path reversal on responses.
- **figc4.7 subroutine walker** — `Enquiry_Response` / `Select_T1` / `Check_I_Frame_Acknowledged` etc. execute their SDL paths through the dispatcher. With LM-SEIZE granted immediately (contention-free single session), the figc4.4 delayed-ack RR flushes, so connected-mode data transfer **converges** (V(s) → V(a), windows reopen).
- **Loss recovery (REJ + SREJ)** — timeout-driven go-back-N (`Transmit_Enquiry` → `Invoke_Retransmission`) and single-frame selective reject over a **real SREJ frame on the wire**, with the SREJ recovery quirks (`ax25Spec40` window guard, `ax25Spec41` Karn SRT guard, `ax25Spec42` SREJ-targets-the-gap). The generative loss-recovery conformance suite drives single-drop and bidirectional-burst loss across both modes and asserts convergence (windows empty + complete in-order delivery).

### Out (deliberate — planned for later)

| Feature | Today | Tracked for |
| --- | --- | --- |
| mod-128 connected-mode *negotiation* | The extended frame codec is wired (v2.2 arc V1 — encode/parse 7-bit N(S)/N(R), mode-aware P/F, receive path threads the modulo; an extended link set up with `ctx.isExtended` transfers windowed data and converges). What's left: the driver doesn't yet originate mod-128 on its own — it doesn't flip `isExtended` from an inbound SABME. | v2.2 arc V4 (cf. packet.net#239) |
| FRMR generation / handling | Inbound FRMR silently dropped | post-v0.1 |
| Multi-frame TX window (k>1) | Hard-coded k=1 | post-v0.1 |
| `via` digipeater paths | `stack.connect({ via: [...] })` throws | post-v0.1 |
| AGW client / server | Not implemented (the [`Packet.Agw`](https://github.com/m0lte/packet.net/tree/main/src/Packet.Agw) .NET package has the working reference impl) | post-v0.1 |
| Audio modem transport (browser-side AFSK) | Not implemented | post-v0.1 |
| XID negotiation | Not implemented — defaults used (mod-8); SREJ is supported when `srejEnabled` is set on the session context | post-v0.1 |

## Browser compatibility

Web Serial is supported in Chromium browsers (Chrome / Edge / Opera / Brave) on desktop OSes. Firefox and Safari don't expose it. The user must grant permission per port via `navigator.serial.requestPort()` from a user-gesture handler (button click, etc.).

For non-browser environments (Node.js / Bun / Deno) use the `TcpKissTransport` subpath or implement your own transport.

## Source layout

```
src/
├── address.ts                 Ax25Address record + codec
├── callsign.ts                Callsign type
├── frame.ts                   Ax25Frame, factories, encode/decode, classify
├── kiss.ts                    KISS framing
├── transport.ts               Ax25Transport interface
├── webserial-transport.ts     KISS over Web Serial
├── tcp-transport.ts           KISS over TCP (Node-only)
├── session.ts                 Public Ax25Stack / Ax25Session — outbound facade
├── listener.ts                Ax25Listener — inbound-accepting node coordinator
└── sdl/                       Table-walking session engine
    ├── events.ts                  Ax25Event variants
    ├── timer-scheduler.ts         T1/T2/T3 arming
    ├── session-context.ts         Mutable per-session state
    ├── guard-evaluator.ts         Parses `"a and not b or c"` guards
    ├── session-bindings.ts        Predicate name → closure
    ├── action-dispatcher.ts       Switch over ~140 SDL action verbs
    ├── subroutine-registry.ts     figc4.7 subroutine table walker
    ├── sdl-loop-executor.ts       shared SDL loop expansion (driver + walker)
    └── session-driver.ts          PostEvent → find transition → execute → advance
```

## Provenance

Extracted from `m0lte/packet.net` on 2026-05-17 (history preserved via `git filter-repo --path web/ax25/ --path-rename web/ax25/:` — 13 commits spanning the library's full life). Before the split, the library lived at `web/ax25/` in that monorepo.

The cross-runtime integration test (`tests/integration/linbpq-via-netsim.test.ts`) runs in [`m0lte/packet.net`'s `interop.yml`](https://github.com/m0lte/packet.net/blob/main/.github/workflows/interop.yml) — that workflow clones this repo and dials the docker stack standing up there (LinBPQ + Xrouter + rax25 + netsim). The docker stack lives in `m0lte/packet.net` and isn't replicated here.

## Sibling repos

| Repo | What it is |
| --- | --- |
| **`m0lte/ax25-ts`** *(here)* | `@packet-net/ax25` browser TS library |
| [`m0lte/ax25sdl`](https://github.com/m0lte/ax25sdl) | SDL transcriptions + codegen — publishes the [`ax25sdl`](https://www.npmjs.com/package/ax25sdl) npm package this library consumes |
| [`m0lte/packet.net`](https://github.com/m0lte/packet.net) | .NET libraries + node host + docker interop matrix (which exercises this library's integration suite) |
| [`m0lte/packet-term-tui`](https://github.com/m0lte/packet-term-tui) | C# Terminal.Gui TUI (the .NET counterpart of [`packet-term-web`](https://github.com/m0lte/packet-term-web)) |
| [`m0lte/packet-term-web`](https://github.com/m0lte/packet-term-web) | Browser TNC2 emulator at https://packet-term.m0lte.uk — consumes this library |

## License

[MIT](LICENSE) — copyright Tom Fanning and Packet.NET contributors.
