/**
 * Tier 2 (frame-perfect, modem-less) NET/ROM NODES-**origination** interop
 * against the live LinBPQ docker container over **AXUDP** (BPQAXIP-over-UDP).
 *
 * The mirror image of {@link ./netrom-nodes-ingest-via-axudp.test.ts}: where the
 * ingest test proves the TS netrom module *hears* real BPQ's NODES and learns a
 * route, this proves the TS node *originates* its own NODES over the wire and
 * **BPQ learns it** — the L3-origination (TX) half of the node-aware slice. It is
 * the AXUDP analog of the C# `NetRomL4CircuitViaAxudp`'s L3(b) leg
 * (`WaitForBpqToLearnUsAsync` → `QueryNodesAndRoutesAsync`), reduced to just the
 * origination assertion (no L4 circuit).
 *
 * The production pipeline under test: a real {@link Ax25Listener} over an
 * {@link AxudpTransport} → {@link NetRomOriginator} (the TX half) building NODES
 * frames from a {@link NetRomRoutingTable} and emitting them via the listener's
 * {@link Ax25Listener.sendUi} unproto path. Unlike the ingest test (which had to
 * hand-roll a warming frame because the module was read-only), origination is now
 * a first-class library capability, so the originator's own `broadcastNodes()` IS
 * the warm-up — exactly the mechanism this test exercises.
 *
 * **Getting BPQ to deliver/learn over a point-to-point AXIP port** (the same
 * enabling findings as the ingest test, source-verified in `bpqaxip.c` + proven
 * on the wire — see that test's header for the full write-up):
 *
 *   1. **A `B`-flagged static MAP** for our callsign on BPQ's AXIP port
 *      (`docker/linbpq/bpq32.cfg`: `MAP PNTSAX-1 172.30.0.1 UDP 8196 B` +
 *      `BROADCAST NODES`). The `B` (broadcast-recipient) flag is what makes BPQ
 *      treat us as a NET/ROM peer; `AUTOADDQUIET` learns our reply route from our
 *      own NODES UI frame's source callsign. (We reuse the ingest test's existing
 *      `PNTSAX-1` / 8196 `B`-flagged fixture — the same callsign/alias/port — per
 *      the slice brief; the two tests are serialised in interop.yml's NET/ROM
 *      phase against the shared daemon, so they don't contend.)
 *   2. **The warm-up quirk works *for* us here.** BPQ only delivers/accepts a
 *      peer's NODES once it has HEARD that peer's NODES on the port. The TS node
 *      emitting ≥ 1 NODES (which is precisely what origination does) is what warms
 *      BPQ into setting up the reciprocal relationship and learning our route —
 *      so a test that asserts BPQ learned us *is* the warm-up.
 *   3. **Bind all interfaces (NOT loopback).** BPQ, inside the docker bridge,
 *      addresses us at the bridge gateway `172.30.0.1`; replies arrive on the
 *      host's bridge interface, not `127.0.0.1`.
 *
 * **We advertise a destination, not just ourselves.** The originator's table is
 * seeded with a learned destination (by ingesting a synthetic upstream NODES) so
 * the originated broadcast carries a real destination entry, not just the
 * header — but the assertion BPQ exposes most reliably over telnet is that our
 * own node/route appears in its `NODES` / `ROUTES` tables (BPQ learns the
 * *originator* of any NODES it accepts; exactly the C# `WaitForBpqToLearnUs`
 * assertion). So we assert on our callsign appearing in BPQ's routing tables —
 * genuine cross-implementation evidence that a real NET/ROM node accepted and
 * learned from the TS node's on-the-wire NODES broadcast over AXUDP.
 *
 * **CI note.** ax25-ts's own CI is unit-only and does NOT run this file
 * (`test:integration` is excluded from `npm test`). The AXUDP interop is run by
 * **packet.net's `interop.yml`**, which clones ax25-ts `main` and runs
 * `test:integration` against its docker stack — so this test is exercised only
 * after this PR merges to ax25-ts main. The describe block self-skips when BPQ's
 * telnet port (8010) is unreachable, so it is a no-op anywhere the stack is down.
 *
 * Bring the stack up first:
 *
 *   docker compose -f docker/compose.interop.yml up -d --wait
 *
 * Then run:
 *
 *   npm run test:integration
 */
import { Socket, createConnection } from "node:net";
import { describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import { Ax25Listener } from "../../src/listener.js";
import { AxudpTransport } from "../../src/axudp-transport.js";
import { writeAddress } from "../../src/address.js";
import {
  NETROM_ALIAS_LENGTH,
  NETROM_SHIFTED_LENGTH,
  NetRomOriginator,
  NetRomRoutingTable,
  parseNodesBroadcast,
} from "../../src/netrom/index.js";

const HOST = "127.0.0.1";
const BPQ_AXUDP_PORT = 8093; // BPQAXIP/UDP listener (published)
const BPQ_TELNET_PORT = 8010; // LinBPQ node prompt

const OUR_CALL = "PNTSAX-1"; // matches `MAP PNTSAX-1 … 8196 B` in bpq32.cfg
const OUR_ALIAS = "PNTSA";
const PDN_LOCAL_PORT = 8196; // the static-MAP target port

// A destination the TS node advertises it can reach (via an upstream hub it
// "heard"). BPQ may or may not surface this distant node, but learning it proves
// nothing extra over learning us — so the headline assertion is on OUR_CALL.
const DISTANT_DEST = "GB7SOT";
const DISTANT_ALIAS = "SOT";
const UPSTREAM_HUB = "GB7HUB";

// The configured sysop password text (docker/linbpq/bpq32.cfg PASSWORD=). BPQ
// uppercases it, so the challenge solves against this exact string.
const BPQ_PASSWORD_TEXT = "WONTLISTEN";

// A reliable UDP tunnel — no channel loss — so budgets are tight but bounded.
const BPQ_LEARNS_US_BUDGET_MS = 45_000;
const BROADCAST_EVERY_MS = 2_000;
const QUERY_EVERY_MS = 2_000;

/** Probe BPQ's telnet port — if it answers, the docker stack is up. */
async function bpqTelnetReachable(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let socket: Socket | null = null;
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        // best-effort
      }
      resolve(ok);
    };
    try {
      socket = createConnection({ host: HOST, port: BPQ_TELNET_PORT });
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      setTimeout(() => finish(false), 250);
    } catch {
      finish(false);
    }
  });
}

const stackReachable = await bpqTelnetReachable();

describe.skipIf(!stackReachable)(
  "netrom: NODES origination against LinBPQ over AXUDP (Tier 2, frame-perfect)",
  () => {
    it(
      "originates a NODES broadcast over the BPQAXIP/UDP tunnel and LinBPQ learns it",
      async () => {
        // Bind all interfaces (NOT loopback) — BPQ replies via 172.30.0.1.
        const transport = new AxudpTransport(HOST, BPQ_AXUDP_PORT, {
          localPort: PDN_LOCAL_PORT,
        });
        const listener = new Ax25Listener(transport, { myCall: OUR_CALL });

        // Seed a routing table with a learned destination so the originated NODES
        // carries a real destination entry (advertise GB7SOT via GB7HUB), then
        // originate from it. The table is fed a synthetic upstream broadcast the
        // same way real ingest would learn it.
        const table = new NetRomRoutingTable();
        const upstream = parseNodesBroadcast(
          buildNodesInfo(UPSTREAM_HUB, [
            {
              dest: DISTANT_DEST,
              destAlias: DISTANT_ALIAS,
              neighbour: UPSTREAM_HUB,
              quality: 200,
            },
          ]),
        );
        expect(upstream).not.toBeNull();
        table.ingest(
          Callsign.parse(UPSTREAM_HUB),
          Callsign.parse(OUR_CALL),
          "axudp",
          upstream!,
        );

        const originator = new NetRomOriginator(table, {
          enabled: true,
          alias: OUR_ALIAS,
        });
        originator.attachPort("axudp", listener);

        // Originate on a steady cadence (BPQ's obsolescence/AUTOADD would
        // otherwise decay our route). This is the warm-up AND the thing under
        // test. Embedder-driven, per the library's no-ambient-timers design.
        let broadcasting = true;
        const broadcastLoop = (async () => {
          while (broadcasting) {
            try {
              await originator.broadcastNodes();
            } catch {
              // best-effort — a transient send error must not sink the test
            }
            await delay(BROADCAST_EVERY_MS);
          }
        })();

        try {
          await listener.start();

          const bpqLearnedUs = await waitForBpqToLearnUs();

          expect(
            bpqLearnedUs,
            "LinBPQ must learn the TS node (PNTSAX-1) as a NET/ROM node/route from its originated NODES over AXUDP — checked via BPQ's NODES/ROUTES sysop tables; the `B`-flagged MAP authorises delivery and the TS node's own NODES (origination) warms BPQ into learning the reply route",
          ).toBe(true);
        } finally {
          broadcasting = false;
          await broadcastLoop.catch(() => {
            // best-effort
          });
          originator.dispose();
          await listener.stop().catch(() => {
            // best-effort — already-stopped, etc.
          });
        }
      },
      BPQ_LEARNS_US_BUDGET_MS + 30_000,
    );
  },
);

/**
 * Build a NET/ROM NODES-broadcast information field: the 0xFF signature, the
 * sender's 6-char alias, then one 21-octet destination entry. Used only to *seed*
 * the originator's routing table with a learned destination (the inverse of the
 * production parser); the production {@link NetRomOriginator} builds the actual
 * on-the-wire frame. Identical layout to the ingest test's helper.
 */
function buildNodesInfo(
  senderAlias: string,
  entries: Array<{
    dest: string;
    destAlias: string;
    neighbour: string;
    quality: number;
  }>,
): Uint8Array {
  const alias = (s: string): Uint8Array => {
    const b = new Uint8Array(NETROM_ALIAS_LENGTH).fill(0x20);
    for (let i = 0; i < Math.min(NETROM_ALIAS_LENGTH, s.length); i++) {
      b[i] = s.charCodeAt(i);
    }
    return b;
  };
  const shifted = (call: string): Uint8Array => {
    const b = new Uint8Array(NETROM_SHIFTED_LENGTH);
    writeAddress(b, 0, {
      callsign: Callsign.parse(call),
      crhBit: false,
      extensionBit: true,
    });
    return b;
  };
  const entryLen =
    NETROM_SHIFTED_LENGTH + NETROM_ALIAS_LENGTH + NETROM_SHIFTED_LENGTH + 1;
  const info = new Uint8Array(1 + NETROM_ALIAS_LENGTH + entries.length * entryLen);
  let o = 0;
  info[o++] = 0xff; // signature
  info.set(alias(senderAlias), o);
  o += NETROM_ALIAS_LENGTH;
  for (const e of entries) {
    info.set(shifted(e.dest), o);
    o += NETROM_SHIFTED_LENGTH;
    info.set(alias(e.destAlias), o);
    o += NETROM_ALIAS_LENGTH;
    info.set(shifted(e.neighbour), o);
    o += NETROM_SHIFTED_LENGTH;
    info[o++] = e.quality & 0xff;
  }
  return info;
}

/**
 * Poll BPQ's `NODES` / `ROUTES` sysop tables (bounded) until our callsign base
 * appears in either — i.e. LinBPQ has learned the TS node from its originated
 * NODES. Mirrors the C# `NetRomL4CircuitViaAxudp.WaitForBpqToLearnUsAsync`.
 */
async function waitForBpqToLearnUs(): Promise<boolean> {
  const deadline = Date.now() + BPQ_LEARNS_US_BUDGET_MS;
  const ourBase = Callsign.parse(OUR_CALL).base.toUpperCase();
  let nextQuery = 0; // query immediately on entry

  while (Date.now() < deadline) {
    if (Date.now() >= nextQuery) {
      try {
        const { nodes, routes } = await bpqQueryNodesAndRoutes(
          HOST,
          BPQ_TELNET_PORT,
          BPQ_PASSWORD_TEXT,
        );
        if (
          routes.toUpperCase().includes(ourBase) ||
          nodes.toUpperCase().includes(ourBase)
        ) {
          // eslint-disable-next-line no-console
          console.log(
            `BPQ learned us. NODES=[${collapse(nodes)}] ROUTES=[${collapse(routes)}]`,
          );
          return true;
        }
      } catch (err) {
        // A transient telnet hiccup must not sink the test — log and retry.
        // eslint-disable-next-line no-console
        console.log(
          `BPQ NODES/ROUTES query failed (will retry): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      nextQuery = Date.now() + QUERY_EVERY_MS;
    }
    await delay(250);
  }
  return false;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Minimal IAC-aware telnet driver for LinBPQ's node prompt ──────────────
// Direct port of the ingest test's driver (itself the C# `BpqTelnet`): log in as
// a non-sysop user → `PASSWORD` (bare) → five 1-based positions → answer
// `PASSWORD <chars-at-those-positions>` → `Ok`, then query `NODES` + `ROUTES`.

const IAC = 255,
  DONT = 254,
  DO = 253,
  WONT = 252,
  WILL = 251;

async function bpqQueryNodesAndRoutes(
  host: string,
  port: number,
  passwordText: string,
): Promise<{ nodes: string; routes: string }> {
  const conn = await openTelnet(host, port);
  try {
    await conn.readUntil("user", 8_000);
    await conn.sendLine("netop");
    await conn.readUntil("password", 8_000);
    await conn.sendLine("netop");
    await conn.readUntil("Telnet Server", 8_000);

    await conn.sendLine("PASSWORD");
    const challenge = await conn.readLineAfterPrompt(6_000);
    const positions = parsePositions(challenge);
    const answer = solveChallenge(positions, passwordText);
    // eslint-disable-next-line no-console
    console.log(`BPQ PASSWORD challenge ${positions.join(" ")} -> answer ${answer}`);

    await conn.sendLine("PASSWORD " + answer);
    const authResp = await conn.readLineAfterPrompt(6_000);
    if (!authResp.includes("Ok")) {
      throw new Error(`BPQ rejected the PASSWORD challenge answer: ${authResp.trim()}`);
    }

    await conn.sendLine("NODES");
    const nodes = await conn.readFor(3_000);
    await conn.sendLine("ROUTES");
    const routes = await conn.readFor(3_000);
    return { nodes, routes };
  } finally {
    conn.close();
  }
}

function parsePositions(challenge: string): number[] {
  const nums = (challenge.match(/\d+/g) ?? []).map((s) => Number.parseInt(s, 10));
  if (nums.length < 5) {
    throw new Error(`Could not parse 5 challenge positions from: ${challenge.trim()}`);
  }
  return nums.slice(-5);
}

function solveChallenge(positions: number[], passwordText: string): string {
  let answer = "";
  for (const p of positions) {
    const idx = Math.min(Math.max(p - 1, 0), passwordText.length - 1);
    answer += passwordText[idx];
  }
  return answer;
}

interface TelnetConn {
  sendLine(line: string): Promise<void>;
  readUntil(needle: string, budgetMs: number): Promise<string>;
  readLineAfterPrompt(budgetMs: number): Promise<string>;
  readFor(budgetMs: number): Promise<string>;
  close(): void;
}

async function openTelnet(host: string, port: number): Promise<TelnetConn> {
  const socket: Socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection({ host, port });
    const onErr = (e: Error): void => {
      s.off("connect", onOk);
      reject(e);
    };
    const onOk = (): void => {
      s.off("error", onErr);
      resolve(s);
    };
    s.once("connect", onOk);
    s.once("error", onErr);
  });

  let decoded = "";
  socket.on("data", (chunk: Buffer) => {
    decoded += appendStripIac(socket, chunk);
  });
  socket.on("error", () => {
    // swallowed — reads time out and surface as their own errors
  });

  const readMatching = async (
    stop: (buf: string) => boolean,
    budgetMs: number,
  ): Promise<string> => {
    const deadline = Date.now() + budgetMs;
    const startLen = decoded.length;
    while (Date.now() < deadline) {
      const slice = decoded.slice(startLen);
      if (stop(slice)) return slice;
      await delay(50);
    }
    return decoded.slice(startLen);
  };

  return {
    async sendLine(line: string): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        socket.write(Buffer.from(line + "\r", "ascii"), (err) =>
          err ? reject(err) : resolve(),
        );
      });
    },
    readUntil(needle: string, budgetMs: number): Promise<string> {
      return readMatching((buf) => needle.length > 0 && buf.includes(needle), budgetMs);
    },
    readLineAfterPrompt(budgetMs: number): Promise<string> {
      return readMatching((buf) => buf.includes("\n"), budgetMs);
    },
    // Read for a fixed window (a table dump has no single sentinel line).
    readFor(budgetMs: number): Promise<string> {
      return readMatching(() => false, budgetMs);
    },
    close(): void {
      try {
        socket.destroy();
      } catch {
        // best-effort
      }
    },
  };
}

function appendStripIac(socket: Socket, buf: Buffer): string {
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== IAC) {
      out += String.fromCharCode(buf[i]!);
      continue;
    }
    if (i + 2 >= buf.length) break;
    const verb = buf[i + 1]!;
    const opt = buf[i + 2]!;
    i += 2;
    const reply = verb === DO ? WONT : verb === WILL ? DONT : 0;
    if (reply !== 0) {
      try {
        socket.write(Buffer.from([IAC, reply, opt]));
      } catch {
        // best-effort
      }
    }
  }
  return out;
}
