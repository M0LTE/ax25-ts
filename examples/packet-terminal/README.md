# Packet Terminal

Live site: https://packet-term.m0lte.uk

A self-contained browser terminal app that uses `@packet-net/ax25` and
`xterm.js` to drive a USB KISS modem from the browser. This is significant since the upstream package, ax25sdl, is automatically generated from the SDL diagrams from the original AX.25 2.2 specification document. As such, this terminal should be technically fully spec-compliant, with spec bugs resolved with zero code changes.
Late-80s phosphor-CRT aesthetic, TNC2 command set.

<img width="1065" height="746" src="https://github.com/user-attachments/assets/1d934e8f-a4d3-4695-95a6-930364fcd13d" />

## Run it

Open `index.html` in **Chromium** or **Edge**. No build step. The page
imports `@packet-net/ax25` and `xterm.js` from [esm.sh](https://esm.sh).

Web Serial isn't supported in Firefox or Safari — the page itself still
loads (so you can read the help / see the layout), but clicking `ATTACH MODEM`
shows a "no web serial" notice.

## TNC2 commands

| Command                | Meaning                                                   |
| ---------------------- | --------------------------------------------------------- |
| `HELP`, `?`            | List commands.                                            |
| `MYCALL <call>`        | Set or show your callsign (e.g. `MYCALL M0LTE-1`).        |
| `CONNECT <call>`, `C`  | Open a link to a remote station.                          |
| `DISCONNECT`, `D`, `BYE` | Drop the link.                                          |
| `STATUS`, `ST`         | Show link state, mode, frame counters.                    |
| `ECHO ON | OFF`        | Local-echo toggle (default ON).                           |
| `CLEAR`, `CLS`         | Wipe the screen.                                          |
| `VERSION`, `V`         | Runtime stack identity.                                   |
| `MON ON/OFF`, `M`      | Turn on/off monitor mode                                  |

While connected, every keystroke is buffered and sent when you press enter. `Ctrl-C`
returns to command mode without disconnecting; type `D` to drop the
link cleanly.

## Architecture

```text
                    ┌─────────────────────────────────┐
                    │           index.html            │
                    │                                 │
   keystrokes ──►   │   xterm.js  ──►  command parser │
                    │                  │              │
                    │                  ▼              │
                    │            @packet-net/ax25     │
                    │                  │              │
   USB Serial ◄───  │       WebSerialKissTransport    │
                    │                                 │
                    └─────────────────────────────────┘
```

`Ax25Stack` is constructed with a `WebSerialKissTransport` wrapping the
`SerialPort` returned by `navigator.serial.requestPort()`. The TNC2
command parser maps text input to `stack.connect({from, to})` and
`session.write(bytes) / session.disconnect()` calls. Inbound bytes from
`session.onData(...)` are written straight to the xterm instance.

## Scope

Connected-mode only — no UI/UNPROTO send, no monitor mode, no
`via` digipeater paths, no mod-128. See `web/ax25/README.md` for the
full library scope table.

Proudly built with AI assistance.
