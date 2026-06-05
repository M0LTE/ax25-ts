# CLAUDE.md

Operating notes for Claude Code (and other agents) working in `m0lte/ax25-ts`.

## What this repo is

`@packet-net/ax25` — a browser-targeted TypeScript library for AX.25 v2.2 connected-mode sessions over Web Serial KISS modems. The downstream-facing companion to:

- [`m0lte/ax25sdl`](https://github.com/m0lte/ax25sdl) — canonical SDL transcriptions + codegen. Published as the `ax25sdl` npm package; we consume it.
- [`m0lte/packet.net`](https://github.com/m0lte/packet.net) — the .NET libraries + packet-radio node host. The C# side of the same protocol stack; the docker interop matrix lives there.

Extracted from `m0lte/packet.net` on 2026-05-17 (history-preserving via `git filter-repo`). Before the split, the library lived at `web/ax25/` in `m0lte/packet.net`.

## Read first

- [`README.md`](README.md) — quick-start, public API surface, and worked browser example.
- [`CHANGELOG.md`](CHANGELOG.md) — version history (carried over from the `web/ax25/` days).

## Hard rules

### Consume `ax25sdl` from npm, never hand-edit generated tables

The AX.25 SDL state-machine tables come from the [`ax25sdl`](https://www.npmjs.com/package/ax25sdl) npm package, built and published by [`m0lte/ax25sdl`](https://github.com/m0lte/ax25sdl). **Do not** vendor, regenerate, or modify those tables from this repo. If a change is needed in the spec data, raise it against `m0lte/ax25sdl`, publish a new version, and bump the `ax25sdl` dep in `package.json`.

### Integration tests live in packet.net's interop matrix

`tests/integration/*` dials the docker compose stack in [`m0lte/packet.net`](https://github.com/m0lte/packet.net) (LinBPQ + Xrouter + rax25 + netsim). Two transports, two tiers: the **net-sim** smokes (`linbpq-via-netsim.test.ts`, `netrom-nodes-ingest-via-netsim.test.ts`, …) dial the 127.0.0.1:8100 KISS-TCP listener over software-AFSK (the modem/channel tier — load-sensitive); the **AXUDP** tests (`linbpq-via-axudp.test.ts`, `netrom-nodes-ingest-via-axudp.test.ts`) dial LinBPQ's BPQAXIP/UDP listener on 127.0.0.1:8093 frame-perfectly (the Tier-2 protocol tier — deterministic, modem-less; mirrors the C# `*ViaAxudp` tests + packet.net docs/plan.md §7.0). That stack does not exist in this repo, so CI here runs only unit tests + typecheck + build. The integration step lives in `m0lte/packet.net`'s `interop.yml` job, which **clones this repo's `main`** and runs `npm ci && npm run build && npm run test:integration` against that stack — it builds from source and does *not* consume the published `@packet-net/ax25` npm package. (The AXUDP tests rely on packet.net's `docker/linbpq/bpq32.cfg` carrying a `B`-flagged `MAP` for the TS callsign — landed alongside.)

When you change `tests/integration/*`, the corresponding interop verification happens in `m0lte/packet.net` on its next interop run against your merged `main` — no publish required. (The published `@packet-net/ax25` npm artefact is for external/web consumers — the esm.sh pin, packet-term-web — not the interop matrix.)

### AXUDP is FCS-always — never add an FCS-less mode

`src/axudp-transport.ts` (`AxudpTransport`, the Node AX.25-over-UDP / BPQAXIP transport) and its `src/fcs.ts` CRC-16/X.25 codec **unconditionally carry the 2-octet AX.25 FCS** — appended on send, stripped + validated on receive, bad-FCS datagrams dropped. This is settled, not a choice: a citation survey of every real AXIP/AXUDP implementation (RFC 1226 + rfc1226-bis, ax25ipd, LinBPQ's BPQAXIP, XRouter, JNOS) found the FCS mandatory in all of them and FCS-less accepted by none. An FCS-less "opt-out" was an invented self-only format on the C# side ([`packet.net#304`](https://github.com/m0lte/packet.net/pull/304)/[#306](https://github.com/m0lte/packet.net/pull/306)) that interoperated with nothing and was removed — **do not reintroduce it here.** Stripping on receive is load-bearing, not cosmetic: `decodeFrame` rejects an S-frame carrying a trailing FCS tail, so an unstripped tail breaks every supervisory ack. The codec is byte-for-byte the C# `Packet.Core.Crc16Ccitt` and LinBPQ's `bpqaxip.c` `compute_crc` (good residue 0xF0B8); keep it that way so the FCS interoperates. `AxudpTransport` binds **all interfaces by default** — a real peer behind a NAT/bridge originates its replies to the gateway address, not loopback.

### Self-hosted runners only

Every workflow job MUST target `runs-on: [self-hosted, Linux, X64]`. **Do not** add jobs using `ubuntu-latest` or any other GitHub-hosted runner label. The same rule applies across `m0lte/packet.net`, `m0lte/ax25sdl`, and the rest of the sibling-repos set — no budget for hosted runner minutes.

## Common commands

```sh
# install
npm ci

# typecheck (library + examples)
npm run typecheck
npm run typecheck:examples

# build
npm run build

# unit tests (excludes tests/integration/**)
npm test

# integration tests — REQUIRES the docker stack from m0lte/packet.net
# to be running locally on 127.0.0.1:8100. Most contributors won't run
# these; the interop job in m0lte/packet.net is the canonical run.
npm run test:integration

# generate typedoc HTML
npm run docs
```

## Things to avoid

- Don't hand-edit anything under `node_modules/ax25sdl/` (the generated SDL tables we consume).
- Don't commit `dist/` (gitignored — `tsc` builds at consume time).
- Don't commit `node_modules/` (gitignored).
- Don't add `runs-on: ubuntu-latest` to any workflow.

## When in doubt

Ask Tom (M0LTE). AX.25 protocol questions usually defer to the SDL figures (which live in `m0lte/ax25sdl`); runtime behaviour questions defer to the C# reference implementation in `m0lte/packet.net`.
