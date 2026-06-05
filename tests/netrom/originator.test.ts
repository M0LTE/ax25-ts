/**
 * Tests for NET/ROM NODES origination — {@link NetRomOriginator}, the TX half of
 * the node-aware slice. Mirrors the C# `NetRomService` origination path
 * (`BroadcastNodes` + the NODESINTERVAL tick) and the deterministic two-node
 * `NodesExchangeTests`.
 *
 * The cross-check oracle throughout is the *production* parser
 * ({@link parseNodesBroadcast}) + a fresh {@link NetRomRoutingTable}: an
 * originated broadcast is asserted not against a hand-rolled byte expectation but
 * by parsing it back and re-ingesting it, so origination ↔ ingest is proven an
 * inverse pair (no encoder/decoder tautology).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Callsign } from "../../src/callsign.js";
import { classify, decodeFrame, PID_NET_ROM } from "../../src/frame.js";
import { Ax25Listener } from "../../src/listener.js";
import {
  NETROM_ROUTING_DEFAULTS,
  NODES_DESTINATION,
  NODES_ENTRY_ENCODED_LENGTH,
  NODES_MAX_ENTRIES_PER_FRAME,
  NETROM_PARSE_STRICT,
  NetRomOriginator,
  type NetRomRoutingOptions,
  NetRomRoutingTable,
  type NetRomUiSender,
  parseNodesBroadcast,
} from "../../src/netrom/index.js";
import { buildNodesInfo, type NodesEntrySpec } from "../netrom-builder.js";
import { LoopbackTransport } from "../listener-test-support.js";

const ANode = new Callsign("GB7AAA", 0); // the originating node
const BNode = new Callsign("GB7BBB", 0); // a second node that hears A
const DistantSot = new Callsign("GB7SOT", 0); // a destination A learned
const ViaHub = new Callsign("GB7HUB", 0); // A's best neighbour to SOT

const FIXED_NOW = Date.UTC(2026, 5, 4, 12, 0, 0);

function newTable(
  options: NetRomRoutingOptions = NETROM_ROUTING_DEFAULTS,
): { table: NetRomRoutingTable; tick: (ms: number) => void } {
  let now = FIXED_NOW;
  const table = new NetRomRoutingTable(options, () => now);
  return { table, tick: (ms: number) => (now += ms) };
}

function broadcast(senderAlias: string, entries: NodesEntrySpec[] = []) {
  const bc = parseNodesBroadcast(buildNodesInfo(senderAlias, entries));
  expect(bc).not.toBeNull();
  return bc!;
}

/** A UI-sender that records every (dest, info, pid) it is asked to send. */
class RecordingUiSender implements NetRomUiSender {
  readonly sent: Array<{ dest: Callsign; info: Uint8Array; pid: number }> = [];
  failNext = false;

  // eslint-disable-next-line @typescript-eslint/require-await
  async sendUi(dest: Callsign, info: Uint8Array, pid = 0xf0): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("transport down");
    }
    this.sent.push({ dest, info: new Uint8Array(info), pid });
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("NetRomOriginator — disabled by default (no ambient TX)", () => {
  it("is off unless enabled, and broadcasting / scheduling are no-ops when off", async () => {
    const { table } = newTable();
    const sender = new RecordingUiSender();
    const orig = new NetRomOriginator(table, { alias: "AAANOD" }); // enabled omitted

    expect(orig.enabled).toBe(false);

    orig.attachPort("p1", sender);
    expect(orig.attachedPorts).toHaveLength(0); // attach is a no-op while disabled

    await orig.broadcastNodes();
    expect(sender.sent).toHaveLength(0); // nothing transmitted

    expect(orig.start(1000)).toBe(false); // refuses to arm the scheduler
    expect(orig.isScheduled).toBe(false);

    orig.dispose();
  });
});

describe("NetRomOriginator — broadcastNodes frame bytes", () => {
  it("emits one UI frame (dest NODES, PID 0xCF) advertising the table's routes", async () => {
    const { table } = newTable();
    // A hears HUB advertise SOT at 255 → A has a real route to SOT via HUB, plus
    // an assumed direct route to HUB itself.
    table.ingest(ViaHub, ANode, "p1", broadcast("HUB", [
      { dest: DistantSot, destAlias: "SOT", neighbour: ViaHub, quality: 255 },
    ]));

    const sender = new RecordingUiSender();
    const orig = new NetRomOriginator(table, { enabled: true, alias: "AAANOD" });
    orig.attachPort("p1", sender);

    await orig.broadcastNodes();

    expect(sender.sent).toHaveLength(1);
    const frame = sender.sent[0]!;
    expect(frame.pid).toBe(PID_NET_ROM);
    expect(frame.dest.base).toBe(NODES_DESTINATION);
    expect(frame.dest.ssid).toBe(0);

    // The bytes parse back (strictly) to A's advertisement — HUB (direct) + SOT.
    const parsed = parseNodesBroadcast(frame.info, NETROM_PARSE_STRICT);
    expect(parsed).not.toBeNull();
    expect(parsed!.senderAlias).toBe("AAANOD");
    const dests = parsed!.entries.map((e) => e.destination.toString());
    expect(dests).toContain(DistantSot.toString());
    expect(dests).toContain(ViaHub.toString());
    // SOT's advertised quality is A's combined quality (decayed below 255).
    const sot = parsed!.entries.find((e) => e.destination.equals(DistantSot))!;
    expect(sot.bestQuality).toBeLessThan(255);
    expect(sot.bestQuality).toBeGreaterThan(0);
    expect(sot.bestNeighbour.equals(ViaHub)).toBe(true);

    orig.dispose();
  });

  it("emits a header-only frame (alias, no entries) when the table is empty", async () => {
    const { table } = newTable();
    const sender = new RecordingUiSender();
    const orig = new NetRomOriginator(table, { enabled: true, alias: "AAANOD" });
    orig.attachPort("p1", sender);

    await orig.broadcastNodes();

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.info.length).toBe(7); // 0xFF + 6-byte alias, no entries
    const parsed = parseNodesBroadcast(sender.sent[0]!.info);
    expect(parsed!.senderAlias).toBe("AAANOD");
    expect(parsed!.entries).toHaveLength(0);

    orig.dispose();
  });

  it("chunks a >11-destination table into multiple UI frames (11/frame)", async () => {
    const { table } = newTable();
    // Seed 24 distinct destinations, all via HUB. A single NODES frame caps at 11
    // entries (the wire format), so a real multi-destination table is *heard*
    // across several frames — seed it the same way (3 frames of ≤ 11).
    const specs: NodesEntrySpec[] = Array.from({ length: 24 }, (_, i) => ({
      dest: new Callsign(`GB7N${String(i).padStart(2, "0")}`),
      destAlias: `N${String(i).padStart(2, "0")}`,
      neighbour: ViaHub,
      quality: 250 - i,
    }));
    for (let i = 0; i < specs.length; i += NODES_MAX_ENTRIES_PER_FRAME) {
      const chunk = specs.slice(i, i + NODES_MAX_ENTRIES_PER_FRAME);
      table.ingest(ViaHub, ANode, "p1", broadcast("HUB", chunk));
    }

    const sender = new RecordingUiSender();
    const orig = new NetRomOriginator(table, { enabled: true, alias: "AAANOD" });
    orig.attachPort("p1", sender);

    await orig.broadcastNodes();

    // 24 advertised destinations + the assumed direct route to HUB = 25 entries
    // → 11 + 11 + 3 = 3 frames out.
    expect(sender.sent).toHaveLength(3);
    let total = 0;
    for (const f of sender.sent) {
      const parsed = parseNodesBroadcast(f.info, NETROM_PARSE_STRICT);
      expect(parsed).not.toBeNull();
      expect(parsed!.entries.length).toBeLessThanOrEqual(NODES_MAX_ENTRIES_PER_FRAME);
      total += parsed!.entries.length;
    }
    expect(total).toBe(25);
    // Boundary: the first two frames are full 11-entry frames.
    expect(sender.sent[0]!.info.length).toBe(7 + 11 * NODES_ENTRY_ENCODED_LENGTH);

    orig.dispose();
  });

  it("goes out on every attached port", async () => {
    const { table } = newTable();
    const a = new RecordingUiSender();
    const b = new RecordingUiSender();
    const orig = new NetRomOriginator(table, { enabled: true, alias: "AAANOD" });
    orig.attachPort("p1", a);
    orig.attachPort("p2", b);
    expect(orig.attachedPorts).toEqual(["p1", "p2"]);

    await orig.broadcastNodes();
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);

    // detach drops one port from the rotation.
    orig.detachPort("p1");
    await orig.broadcastNodes();
    expect(a.sent).toHaveLength(1); // unchanged
    expect(b.sent).toHaveLength(2);

    orig.dispose();
  });

  it("isolates a failing port's send from the others", async () => {
    const errors: unknown[] = [];
    const { table } = newTable();
    const good = new RecordingUiSender();
    const bad = new RecordingUiSender();
    bad.failNext = true;
    const orig = new NetRomOriginator(table, {
      enabled: true,
      alias: "AAANOD",
      onSendError: (e) => errors.push(e),
    });
    orig.attachPort("good", good);
    orig.attachPort("bad", bad);

    await expect(orig.broadcastNodes()).resolves.toBeUndefined();
    expect(good.sent).toHaveLength(1); // the healthy port still got the broadcast
    expect(errors).toHaveLength(1); // the failure was reported, not thrown

    orig.dispose();
  });
});

describe("NetRomOriginator — the OBSMIN advertise-gate", () => {
  it("stops advertising a faded route before it is purged", async () => {
    // OBSINIT 6, OBSMIN 4: after two sweeps a route sits at obs 4 (still
    // advertised); after a third it is at 3 — kept + usable, but no longer
    // advertised. Mirrors C# OBSMIN_gate_stops_advertising_a_faded_route.
    const opts: NetRomRoutingOptions = {
      ...NETROM_ROUTING_DEFAULTS,
      obsoleteInitial: 6,
      obsoleteMinimum: 4,
    };
    const { table } = newTable(opts);
    const sender = new RecordingUiSender();
    const orig = new NetRomOriginator(table, { enabled: true, alias: "AAANOD" });
    orig.attachPort("p1", sender);

    table.ingest(ViaHub, ANode, "p1", broadcast("HUB", [
      { dest: DistantSot, destAlias: "SOT", neighbour: ViaHub, quality: 255 },
    ]));

    const advertisesSot = async (): Promise<boolean> => {
      sender.sent.length = 0;
      await orig.broadcastNodes();
      // Lenient parse: once every route fades, the advertisement is a valid
      // header-only frame (zero entries), which the strict parser would reject.
      return sender.sent.some((f) => {
        const p = parseNodesBroadcast(f.info);
        return p!.entries.some((e) => e.destination.equals(DistantSot));
      });
    };

    expect(await advertisesSot()).toBe(true); // fresh: obs 6 ≥ 4
    table.sweep(); // 6 → 5
    table.sweep(); // 5 → 4 (still ≥ 4)
    expect(await advertisesSot()).toBe(true);
    table.sweep(); // 4 → 3 (< OBSMIN 4)
    expect(await advertisesSot()).toBe(false);

    // Still resolvable for routing (kept, just not advertised).
    expect(
      table.snapshot().destinations.some((d) => d.destination.equals(DistantSot)),
    ).toBe(true);

    orig.dispose();
  });

  it("an obsoleteMinimum override of 0 advertises every kept route", async () => {
    const opts: NetRomRoutingOptions = {
      ...NETROM_ROUTING_DEFAULTS,
      obsoleteInitial: 6,
      obsoleteMinimum: 4,
    };
    const { table } = newTable(opts);
    const sender = new RecordingUiSender();
    // Override OBSMIN to 0 on the originator → advertise regardless of decay.
    const orig = new NetRomOriginator(table, {
      enabled: true,
      alias: "AAANOD",
      obsoleteMinimum: 0,
    });
    orig.attachPort("p1", sender);

    table.ingest(ViaHub, ANode, "p1", broadcast("HUB", [
      { dest: DistantSot, destAlias: "SOT", neighbour: ViaHub, quality: 255 },
    ]));
    table.sweep(); // 6 → 5
    table.sweep(); // 5 → 4
    table.sweep(); // 4 → 3 — below the table's OBSMIN 4, but the originator gate is 0

    await orig.broadcastNodes();
    const advertised = sender.sent.some((f) => {
      const p = parseNodesBroadcast(f.info, NETROM_PARSE_STRICT);
      return p!.entries.some((e) => e.destination.equals(DistantSot));
    });
    expect(advertised).toBe(true);

    orig.dispose();
  });
});

describe("NetRomOriginator — origination ↔ ingest round-trip (the inverse oracle)", () => {
  it("node B learns node A and its routes from A's originated broadcast", async () => {
    // Mirrors the C# NodesExchangeTests two-node round-trip.
    const { table: tableA } = newTable();
    // A's table knows SOT via HUB (heard from HUB at 255).
    tableA.ingest(ViaHub, ANode, "p1", broadcast("HUB", [
      { dest: DistantSot, destAlias: "SOT", neighbour: ViaHub, quality: 255 },
    ]));

    // A originates; capture the frames.
    const sender = new RecordingUiSender();
    const origA = new NetRomOriginator(tableA, { enabled: true, alias: "AAANOD" });
    origA.attachPort("p1", sender);
    await origA.broadcastNodes();
    expect(sender.sent.length).toBeGreaterThan(0);

    // B hears A's broadcast (A is the UI-frame source / originator) and ingests.
    const { table: tableB } = newTable();
    for (const f of sender.sent) {
      const parsed = parseNodesBroadcast(f.info, NETROM_PARSE_STRICT);
      expect(parsed).not.toBeNull();
      tableB.ingest(ANode, BNode, "p1", parsed!);
    }

    const snapB = tableB.snapshot();
    // B learned A as a directly-heard neighbour (+ an assumed direct route).
    expect(snapB.neighbours).toHaveLength(1);
    expect(snapB.neighbours[0]!.neighbour.equals(ANode)).toBe(true);
    expect(snapB.destinations.some((d) => d.destination.equals(ANode))).toBe(true);

    // B learned SOT via A, at a quality strictly decayed over the extra hop.
    const sot = snapB.destinations.find((d) => d.destination.equals(DistantSot));
    expect(sot).toBeDefined();
    expect(sot!.bestRoute!.neighbour.equals(ANode)).toBe(true); // B forwards to A
    expect(sot!.alias).toBe("SOT");
    const advertisedByA = parseNodesBroadcast(sender.sent[0]!.info, NETROM_PARSE_STRICT)!
      .entries.find((e) => e.destination.equals(DistantSot))!.bestQuality;
    expect(sot!.bestRoute!.quality).toBeLessThan(advertisedByA);

    origA.dispose();
  });

  it("end-to-end through real listeners: A's sendUi → B's frame tap ingests", async () => {
    // The production pipeline end to end: a real Ax25Listener carries A's
    // originated UI frame on the wire; a second listener's frame tap + the parser
    // re-learns it. The two transports are wired so A's outbound bytes are
    // injected into B's inbound pump (a tiny one-way RF link).
    const aTransport = new LoopbackTransport();
    const bTransport = new LoopbackTransport();
    const listenerA = new Ax25Listener(aTransport, { myCall: ANode });
    const listenerB = new Ax25Listener(bTransport, { myCall: BNode });

    const { table: tableA } = newTable();
    tableA.ingest(ViaHub, ANode, "p1", broadcast("HUB", [
      { dest: DistantSot, destAlias: "SOT", neighbour: ViaHub, quality: 255 },
    ]));
    const { table: tableB } = newTable();

    // B re-ingests every NODES frame it sees on its tap (the real ingest gate —
    // the same predicate NetRomService.onFrameTraced applies).
    listenerB.onFrameTraced((e) => {
      if (e.direction !== "rx") return;
      if (classify(e.frame) !== "UI" || e.frame.pid !== PID_NET_ROM) return;
      if (e.frame.destination.callsign.base !== NODES_DESTINATION) return;
      const parsed = parseNodesBroadcast(e.frame.info);
      if (parsed) tableB.ingest(e.frame.source.callsign, BNode, "p1", parsed);
    });

    await listenerA.start();
    await listenerB.start();

    const origA = new NetRomOriginator(tableA, { enabled: true, alias: "AAANOD" });
    origA.attachPort("p1", listenerA);
    await origA.broadcastNodes();

    // Deliver everything A put on the wire into B's inbound pump.
    for (const bytes of aTransport.sentFrames.snapshot()) {
      bTransport.injectInboundBytes(bytes);
    }

    const snapB = tableB.snapshot();
    expect(snapB.neighbours.some((n) => n.neighbour.equals(ANode))).toBe(true);
    expect(snapB.destinations.some((d) => d.destination.equals(DistantSot))).toBe(true);

    origA.dispose();
    await listenerA.dispose();
    await listenerB.dispose();
  });
});

describe("NetRomOriginator — the periodic NODESINTERVAL scheduler", () => {
  it("emits on each driven interval and not before", async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    const { table } = newTable();
    const sender = new RecordingUiSender();
    const orig = new NetRomOriginator(table, { enabled: true, alias: "AAANOD" });
    orig.attachPort("p1", sender);

    expect(orig.start(1000)).toBe(true);
    expect(orig.isScheduled).toBe(true);

    // Nothing fires immediately — the first broadcast is one interval away.
    expect(sender.sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(999);
    expect(sender.sent).toHaveLength(0); // not yet

    await vi.advanceTimersByTimeAsync(1); // now at 1000ms
    expect(sender.sent).toHaveLength(1); // first tick fired

    await vi.advanceTimersByTimeAsync(2000); // two more intervals
    expect(sender.sent).toHaveLength(3);

    orig.stop();
    expect(orig.isScheduled).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sender.sent).toHaveLength(3); // stopped — no further ticks

    orig.dispose();
  });

  it("start is idempotent (a second start does not arm a second timer)", async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    const { table } = newTable();
    const sender = new RecordingUiSender();
    const orig = new NetRomOriginator(table, { enabled: true, alias: "AAANOD" });
    orig.attachPort("p1", sender);

    expect(orig.start(1000)).toBe(true);
    expect(orig.start(1000)).toBe(false); // already armed

    await vi.advanceTimersByTimeAsync(1000);
    expect(sender.sent).toHaveLength(1); // exactly one tick, not two

    orig.dispose();
  });

  it("dispose stops the scheduler", async () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    const { table } = newTable();
    const sender = new RecordingUiSender();
    const orig = new NetRomOriginator(table, { enabled: true, alias: "AAANOD" });
    orig.attachPort("p1", sender);
    orig.start(1000);

    orig.dispose();
    expect(orig.isScheduled).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sender.sent).toHaveLength(0);
  });

  it("rejects a non-positive interval", () => {
    const { table } = newTable();
    const orig = new NetRomOriginator(table, { enabled: true, alias: "AAANOD" });
    expect(() => orig.start(0)).toThrow(/positive/);
    expect(() => orig.start(-5)).toThrow(/positive/);
    orig.dispose();
  });
});

describe("NetRomOriginator — alias resolution", () => {
  it("falls back to the node callsign base when no alias is configured", async () => {
    const { table } = newTable();
    const sender = new RecordingUiSender();
    const orig = new NetRomOriginator(table, { enabled: true, nodeCall: "GB7AAA-2" });
    expect(orig.senderAlias).toBe("GB7AAA");
    orig.attachPort("p1", sender);

    await orig.broadcastNodes();
    const parsed = parseNodesBroadcast(sender.sent[0]!.info);
    expect(parsed!.senderAlias).toBe("GB7AAA");

    orig.dispose();
  });

  it("prefers an explicit alias over the node callsign", () => {
    const { table } = newTable();
    const orig = new NetRomOriginator(table, {
      enabled: true,
      alias: "RDGBPQ",
      nodeCall: "GB7AAA",
    });
    expect(orig.senderAlias).toBe("RDGBPQ");
    orig.dispose();
  });
});

// A tiny sanity check that the originated frame really is what a NODES-aware
// receiver gates on (UI / PID 0xCF / dest NODES) — guarding against a
// classification regression in the build path.
describe("NetRomOriginator — wire-shape sanity", () => {
  it("the originated bytes classify as a UI NODES broadcast", async () => {
    const transport = new LoopbackTransport();
    const listener = new Ax25Listener(transport, { myCall: ANode });
    await listener.start();
    const { table } = newTable();
    const orig = new NetRomOriginator(table, { enabled: true, alias: "AAANOD" });
    orig.attachPort("p1", listener);

    await orig.broadcastNodes();

    const frame = decodeFrame(transport.sentFrames.get(0));
    expect(classify(frame)).toBe("UI");
    expect(frame.pid).toBe(PID_NET_ROM);
    expect(frame.destination.callsign.base).toBe(NODES_DESTINATION);
    expect(frame.source.callsign.equals(ANode)).toBe(true);

    orig.dispose();
    await listener.dispose();
  });
});
