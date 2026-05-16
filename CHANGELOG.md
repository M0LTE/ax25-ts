# Changelog

All notable changes to `@packet-net/ax25` will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Subject lines stay short by convention; bodies wrap to the GitHub viewer's viewport.

## [0.1.1] — 2026-05-16

Documentation fix. No code changes — `0.1.1` ships only to scrub a stale pre-publish notice that leaked into `0.1.0`'s `README.md` (a `> [!NOTE]` callout claiming the package was not yet on npm, which is wrong now that `0.1.0` has shipped). Republishing flushes the notice off the npmjs.com package page.

### Changed

- README: removed the pre-publish "not yet on npm" callout. `0.1.0`'s README on npmjs.com still shows it; consumers should pull `^0.1.1`.

## [0.1.0] — 2026-05-16

First public release. Covers AX.25 v2.2 connected-mode happy-path interop with LinBPQ, Xrouter, rax25, and direwolf-style KISS-TCP listeners. Published to npmjs.com from the self-hosted CI runner.

### Added

- **Frame codec** for U-frames (SABM, UA, DISC, DM, UI), S-frames (RR, RNR, REJ), and I-frames. Mod-8 only.
- **`Callsign`** value type — 0-6-char base + 0-15 SSID. `Callsign.parse("M0LTE-7")` round-trips.
- **`Ax25Address`** record + codec — 7-octet on-the-wire callsign with SSID + C/H + E-bit handling.
- **KISS framing** — `KissDecoder` (stateful FEND/FESC/TFEND/TFESC decoder) and `encodeKiss(...)`. Multi-port nibble supported.
- **`Ax25Transport`** — 3-method interface (`start` / `send` / `stop`) — the seam future transports plug into.
- **`WebSerialKissTransport`** — KISS over a `SerialPort` for Chromium browsers.
- **`TcpKissTransport`** — KISS over a TCP socket for Node.js. Reachable via the `@packet-net/ax25/tcp-transport` subpath import so browser bundlers don't pull in `node:net`.
- **`Ax25Stack`** + **`Ax25Session`** — public connected-mode API. `connect({ from, to })` returns a `Promise<Ax25Session>` once SABM/UA completes; the session exposes `onData(cb)`, `onDisconnected(cb)`, `write(bytes)`, and `disconnect()`.
- **Table-driven session machine** — the driver in `src/sdl/session-driver.ts` imports `DataLinkDisconnected`, `DataLinkAwaitingConnection`, `DataLinkAwaitingConnection22`, `DataLinkConnected`, and `DataLinkAwaitingRelease` transitions from the [`ax25sdl`](../../ts-spec/) package, evaluates guards via `src/sdl/guard-evaluator.ts`, executes action chains via `src/sdl/action-dispatcher.ts`, and advances state. Same architecture as the C# runtime in `src/Packet.Ax25/Session/`.
- **T1 retry** on SABM, DISC, and outstanding I-frame, capped at N2 (default 10) via the SDL `RC_eq_N2` guard.
- **First live interop** — integration test against LinBPQ over net-sim (`tests/integration/linbpq-via-netsim.test.ts`) — SABM/UA → I-frame round-trip → DISC/UA, full wire-log evidence captured in [`docs/plan.md`](../../docs/plan.md) amendment log.

### Changed

- Renamed package from `@packet-net/ax25-ts` to `@packet-net/ax25`. Pre-publish rename; no released versions of the `-ts` name exist on npm.

### Known limitations

- **k=1 single-outstanding-I-frame window** — throughput will be SRT-bound on real links.
- **REJ/SREJ recovery loops** — wire frames emit, but the recovery subroutines are no-op stubs (figc4.7 paths not yet walked).
- **Dynamic T1V** — `Select_T1_Value` is a stub; caller-supplied `t1Ms` is honoured statically.
- **No FRMR generation / handling** — inbound FRMR silently dropped.
- **No mod-128 (SABME)** — the SDL `version_2_2` predicate returns false.
- **`via` digipeater paths** — frame factories and codec round-trip them, but `stack.connect({ via: [...] })` throws.
- **No AGW / AXUDP / audio transports** — Web Serial + TCP only.
- **No inbound connection acceptance** — SABM addressed to us with no matching outbound session is silently dropped.

See [README.md § Scope](README.md#scope--whats-in-v01-whats-deliberately-out) for the full out-of-scope table.

[0.1.0]: https://github.com/M0LTE/packet.net/releases/tag/v0.1.0
