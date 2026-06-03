/**
 * Behavioural transition-coverage ledger. Runs a battery of representative
 * scenarios through the two-station harness with the **real** dispatcher and
 * records, via each driver's `onTransitionFired` hook (surfaced on the harness
 * as {@link TwoStationHarness.firedTransition}), which `(state, transition-id)`
 * pairs actually execute. Reports per-state coverage against the live `ax25sdl`
 * tables and asserts that a curated set of high-value transitions across every
 * state is behaviourally exercised, plus a floor on the total — so behavioural
 * coverage is measurable and can't silently regress.
 *
 * The TypeScript parity leg of packet.net's `TransitionCoverageTests`
 * (v2.2 arc V5a — m0lte/packet.net#274). Of the 250 tracked transitions (the
 * six data-link states plus the management_data_link Ready/Negotiating machine,
 * added to the ledger in V5a via the MDL driver's forwarded transition-fired
 * hook), this measures which the real runtime runs when driven through realistic
 * traffic. The battery runs both mod-8 and mod-128 (extended) scenarios —
 * bidirectional data incl. a 127→0 window-wrap, REJ/SREJ loss recovery, RNR
 * flow, T3 keepalive, the TimerRecovery receive columns by frame-injection, XID
 * negotiation, and segmentation over a mod-128 link. The miss-list (logged) maps
 * where behavioural coverage still has gaps — most remaining misses are
 * genuinely unreachable end-to-end (the never-produced error inputs, the
 * N(R)-out-of-window collision/re-establish branches, the responder-never-parks-
 * here AwaitingV22Connection branches), the rest future scenario work.
 *
 * This complements the structural smoke coverage (`sdl-driver.test.ts`) and the
 * scenario suites (happy-path / loss-recovery / mod128 / mdl / segmentation),
 * which assert correctness. Here the question is the orthogonal one: of the
 * tracked transitions, which does the real runtime actually run?
 *
 * Membership is queried through each rig's public
 * {@link TwoStationHarness.firedTransition} predicate, OR'd over every collected
 * rig — so the battery never reconstructs the harness's internal key format.
 */
import { describe, expect, it } from "vitest";
import {
  DataLinkAwaitingConnection,
  DataLinkAwaitingRelease,
  DataLinkAwaitingV22Connection,
  DataLinkConnected,
  DataLinkDisconnected,
  DataLinkTimerRecovery,
  ManagementDataLinkNegotiating,
  ManagementDataLinkReady,
  type StatePage,
} from "ax25sdl";
import {
  type Ax25Frame,
  classify,
  disc,
  dm,
  frmr,
  getNs,
  iFrame,
  rej,
  rnr,
  rr,
  sabm,
  sabme,
  srej,
  ua,
  ui,
  xid,
} from "../../src/frame.js";
import { encodeXid } from "../../src/xid.js";
import type { Endpoint } from "./two-station-harness.js";
import { TwoStationHarness } from "./two-station-harness.js";

/** A `(from, id) → fired?` predicate, OR'd over every collected rig. */
type FiredQuery = (from: string, id: string) => boolean;

// The tracked state→table set, mirroring the C# `Tables` array. The
// management_data_link Ready/Negotiating machine joins the ledger (V5a); its
// state names don't collide with the data-link states.
const TABLES: ReadonlyArray<readonly [string, StatePage]> = [
  ["Disconnected", DataLinkDisconnected],
  ["AwaitingConnection", DataLinkAwaitingConnection],
  ["AwaitingV22Connection", DataLinkAwaitingV22Connection],
  ["Connected", DataLinkConnected],
  ["AwaitingRelease", DataLinkAwaitingRelease],
  ["TimerRecovery", DataLinkTimerRecovery],
  ["Ready", ManagementDataLinkReady],
  ["Negotiating", ManagementDataLinkNegotiating],
];

// ─── Frame builders (addressed to the target, i.e. "from its peer") ──────────

const frmrTo = (t: Endpoint): Ax25Frame =>
  frmr({
    destination: t.context.local,
    source: t.context.remote,
    info: Uint8Array.from([0x00, 0x00, 0x00]),
  });

const dmTo = (t: Endpoint, finalBit = false): Ax25Frame =>
  dm({ destination: t.context.local, source: t.context.remote, finalBit });

const discTo = (t: Endpoint): Ax25Frame =>
  disc({ destination: t.context.local, source: t.context.remote });

const sabmTo = (t: Endpoint): Ax25Frame =>
  sabm({ destination: t.context.local, source: t.context.remote });

const sabmeTo = (t: Endpoint): Ax25Frame =>
  sabme({ destination: t.context.local, source: t.context.remote });

const uaTo = (t: Endpoint, finalBit: boolean): Ax25Frame =>
  ua({ destination: t.context.local, source: t.context.remote, finalBit });

const uiTo = (t: Endpoint, info: string, pollFinal = false): Ax25Frame =>
  ui({
    destination: t.context.local,
    source: t.context.remote,
    info: new TextEncoder().encode(info),
    pollFinal,
  });

// Extended (mod-128) supervisory / I-frame builders (2-octet control), used by
// the TimerRecovery injection block to hit specific figc4.5 receive branches.
const rrExt = (t: Endpoint, nr: number, isCommand: boolean, pf: boolean): Ax25Frame =>
  rr({ destination: t.context.local, source: t.context.remote, nr, isCommand, pollFinal: pf, extended: true });

const rnrExt = (t: Endpoint, nr: number, isCommand: boolean, pf: boolean): Ax25Frame =>
  rnr({ destination: t.context.local, source: t.context.remote, nr, isCommand, pollFinal: pf, extended: true });

const rejExt = (t: Endpoint, nr: number, isCommand: boolean, pf: boolean): Ax25Frame =>
  rej({ destination: t.context.local, source: t.context.remote, nr, isCommand, pollFinal: pf, extended: true });

const srejExt = (t: Endpoint, nr: number, isCommand: boolean, pf: boolean): Ax25Frame =>
  srej({ destination: t.context.local, source: t.context.remote, nr, isCommand, pollFinal: pf, extended: true });

const iExt = (t: Endpoint, nr: number, ns: number, payload: number, pf: boolean): Ax25Frame =>
  iFrame({
    destination: t.context.local,
    source: t.context.remote,
    nr,
    ns,
    info: Uint8Array.from([payload]),
    pollBit: pf,
    extended: true,
  });

// ─── Channel-policy predicates (mirror the C# inline drop lambdas) ───────────

const fromA = (h: TwoStationHarness, f: Ax25Frame): boolean =>
  f.source.callsign.toString() === h.a.context.local.toString();
const fromB = (h: TwoStationHarness, f: Ax25Frame): boolean =>
  f.source.callsign.toString() === h.b.context.local.toString();
const isI = (f: Ax25Frame): boolean => classify(f) === "I";
const isSabmOrSabme = (f: Ax25Frame): boolean =>
  classify(f) === "SABM" || classify(f) === "SABME";
const isSupervisoryAck = (f: Ax25Frame): boolean =>
  classify(f) === "RR" || classify(f) === "RNR";
const isXidFromA = (h: TwoStationHarness, f: Ax25Frame): boolean =>
  classify(f) === "XID" && fromA(h, f);

/**
 * Build a coverage harness — the oracle (per-step invariant check) is suspended
 * because the injection scenarios post frames outside the submitted/delivered
 * model; correctness is asserted by the dedicated conformance suites, this
 * battery measures only which transitions fire. Mirrors the C# `New(...)`.
 */
function New(opts: {
  srej?: boolean;
  k?: number;
  extended?: boolean;
  n2?: number;
  segmenter?: boolean;
  n1?: number;
} = {}): TwoStationHarness {
  const h = TwoStationHarness.build(opts);
  h.checkAfterEachStep = false;
  return h;
}

/**
 * Run the full battery and return a `(from, id) → fired?` predicate OR'd over
 * every rig. Mirrors the C# `RunBatteryAndCollectFired` (which returns a
 * HashSet; here membership rides on each rig's `firedTransition` to avoid
 * reconstructing the harness's internal key format).
 */
function runBatteryAndCollectFired(): FiredQuery {
  const rigs: TwoStationHarness[] = [];
  const collect = (h: TwoStationHarness): void => {
    rigs.push(h);
  };

  // 1. Connect (from A) + clean disconnect.
  {
    const h = New();
    h.connect();
    h.disconnect(h.a);
    collect(h);
  }

  // 2. Connect initiated by B.
  {
    const h = New();
    h.connectFrom(h.b);
    h.disconnect(h.b);
    collect(h);
  }

  // 3. Bidirectional data transfer + delayed-ack flush.
  {
    const h = New();
    h.connect();
    h.submit(h.a, 0xa0);
    h.submit(h.b, 0xb0);
    h.submit(h.a, 0xa1);
    h.submit(h.b, 0xb1);
    h.settle();
    h.flushAcks();
    collect(h);
  }

  // 4. Window-full transfer that wraps the modulus.
  {
    const h = New({ k: 4 });
    h.connect();
    for (let i = 0; i < 12; i++) h.submit(h.a, i);
    h.flushAcks();
    collect(h);
  }

  // 5. Single-drop REJ recovery (Connected → TimerRecovery → recover).
  {
    const h = New({ k: 4 });
    h.connect();
    let dropped = false;
    h.dropWhen((f) => {
      if (!dropped && fromA(h, f) && isI(f)) {
        dropped = true;
        return true;
      }
      return false;
    });
    for (let i = 0; i < 4; i++) h.submit(h.a, i);
    h.recoverUntilConverged(30);
    collect(h);
  }

  // 6. SREJ recovery under intermittent loss.
  {
    const h = New({ srej: true, k: 4 });
    h.connect();
    let budget = 2;
    h.dropWhen((f) => {
      if (budget > 0 && fromA(h, f) && isI(f)) {
        budget--;
        return true;
      }
      return false;
    });
    for (let i = 0; i < 6; i++) h.submit(h.a, i);
    h.recoverUntilConverged(40);
    collect(h);
  }

  // 7. RNR flow control (peer-receiver-busy → RNR → resume).
  {
    const h = New({ k: 4 });
    h.connect();
    h.submit(h.a, 0x01);
    h.setBusy(h.b);
    h.submit(h.a, 0x02);
    h.clearBusy(h.b);
    h.flushAcks();
    collect(h);
  }

  // 8. Sustained loss → N2 exhaustion → disconnect from TimerRecovery.
  {
    const h = New({ k: 4 });
    h.connect();
    h.dropWhen((f) => fromA(h, f) && isI(f));
    h.submit(h.a, 0x01);
    for (let r = 0; r < 20 && h.a.state !== "Disconnected"; r++) h.advanceT1();
    collect(h);
  }

  // 9. FRMR + DM received in Connected and TimerRecovery.
  {
    const h = New({ k: 4 });
    h.connect();
    h.injectFrameBytes(h.a, frmrTo(h.a)); // → re-establish
    h.injectFrameBytes(h.a, dmTo(h.a)); // → teardown
    collect(h);
  }
  {
    // Drive into TimerRecovery, then inject a REJ receive-column frame.
    const h = New({ k: 4 });
    h.connect();
    h.dropWhen((f) => fromA(h, f) && isI(f));
    h.submit(h.a, 0x00);
    h.advanceT1();
    h.dropWhen(undefined);
    h.injectFrameBytes(
      h.a,
      rej({ destination: h.a.context.local, source: h.a.context.remote, nr: 0, isCommand: false, pollFinal: true }),
    );
    collect(h);
  }
  {
    const h = New({ k: 4 });
    h.connect();
    h.dropWhen((f) => fromA(h, f) && isI(f));
    h.submit(h.a, 0x00);
    h.advanceT1();
    h.injectFrameBytes(h.a, frmrTo(h.a)); // FRMR in TimerRecovery
    collect(h);
  }

  // 10. mod-128 (extended) establishment — the figc4.6 AwaitingV22Connection
  // column. The ax25Spec44 redirect routes a v2.2-preferred connect here, so
  // this is the battery that lifts AwaitingV22Connection off 0/25.

  // 10a. Happy path: SABME → UA → Connected (mod-128), data, clean disconnect.
  {
    const h = New({ extended: true });
    h.connect();
    h.submit(h.a, 0xc0);
    h.flushAcks();
    h.disconnect(h.a);
    collect(h);
  }

  // 10b. Lost SABME → T1 retry RESENDS SABME (t13_t1_expiry_no), then converges.
  {
    const h = New({ extended: true });
    let dropped = 0;
    h.dropWhen((f) => {
      if (classify(f) === "SABME" && fromA(h, f) && dropped === 0) {
        dropped++;
        return true;
      }
      return false;
    });
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    h.advanceT1(); // t13_t1_expiry_no → resend SABME → UA → Connected
    collect(h);
  }

  // 10c. §975 FRMR fallback (t14_frmr_received): peer rejects SABME → set
  // version 2.0, re-establish, fall to AwaitingConnection.
  {
    const h = New({ extended: true });
    h.dropWhen((f) => isSabmOrSabme(f) && fromA(h, f));
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    if (h.a.state === "AwaitingV22Connection") h.injectFrameBytes(h.a, frmrTo(h.a));
    collect(h);
  }

  // 10d. Receive-column odds that STAY in AwaitingV22Connection: a redundant
  // DL-CONNECT (t02), DL-UNIT-DATA (t03), a layer-3-initiated DL-DATA (t04_yes —
  // a no-op buffer that does NOT queue, so it's safe), UI received (t10_no /
  // t10_yes), a UA with F=0 (t12_ua_received_no → DL-ERROR D), a SABME collision
  // (t15_sabme_received → UA), a DISC (t17_disc_received). All keep A parked, so
  // they share one rig (establishment frames swallowed so the peer never UAs us
  // out of the state).
  {
    const h = New({ extended: true });
    h.dropWhen((f) => isSabmOrSabme(f) && fromA(h, f));
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    if (h.a.state === "AwaitingV22Connection") {
      h.a.driver.postEvent({ name: "DL_CONNECT_request" }); // t02
      h.a.driver.postEvent({ name: "DL_UNIT_DATA_request", data: Uint8Array.from([0x01]) }); // t03
      h.a.driver.postEvent({ name: "DL_DATA_request", data: Uint8Array.from([0x02]), pid: 0xf0 }); // t04_yes (no queue)
      h.settle();
      h.injectFrameBytes(h.a, uiTo(h.a, "y")); // t10_ui_received_no
      h.injectFrameBytes(h.a, uiTo(h.a, "z", true)); // t10_ui_received_yes
      h.injectFrameBytes(h.a, uaTo(h.a, false)); // t12_ua_received_no → DL-ERROR D, stay
      h.injectFrameBytes(h.a, sabmeTo(h.a)); // t15_sabme_received → UA, stay
      h.injectFrameBytes(h.a, discTo(h.a)); // t17_disc_received → stay
    }
    collect(h);
  }

  // 10d-i. DM(F=1) tears the v2.2 connect down (t11_dm_received_yes).
  {
    const h = New({ extended: true });
    h.dropWhen((f) => classify(f) === "SABME" && fromA(h, f));
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    if (h.a.state === "AwaitingV22Connection") h.injectFrameBytes(h.a, dmTo(h.a, true));
    collect(h);
  }

  // 10d-ii. DM(F=0) drops to the mod-8 AwaitingConnection state (t11_dm_received_no).
  {
    const h = New({ extended: true });
    h.dropWhen((f) => classify(f) === "SABME" && fromA(h, f));
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    if (h.a.state === "AwaitingV22Connection") h.injectFrameBytes(h.a, dmTo(h.a, false));
    collect(h);
  }

  // 10d-iii. SABM(v2.0) received while awaiting v2.2 → UA, set version 2.0,
  // drop to AwaitingConnection (t16_sabm_received).
  {
    const h = New({ extended: true });
    h.dropWhen((f) => classify(f) === "SABME" && fromA(h, f));
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    if (h.a.state === "AwaitingV22Connection") h.injectFrameBytes(h.a, sabmTo(h.a));
    collect(h);
  }

  // 10e. N2 exhaustion while awaiting the v2.2 connection (t13_t1_expiry_yes).
  {
    const h = New({ extended: true, n2: 2 });
    h.dropWhen((f) => classify(f) === "SABME" && fromA(h, f));
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    for (let r = 0; r < 6 && h.a.state === "AwaitingV22Connection"; r++) h.advanceT1();
    collect(h);
  }

  // 11. Disconnected-state receive column: deliver assorted frames to a station
  // with no session up (figc4.1 receive handling — UI, DISC→DM, spurious UA).
  {
    const h = New();
    h.injectFrameBytes(h.a, uiTo(h.a, "x"));
    h.injectFrameBytes(h.a, discTo(h.a));
    h.injectFrameBytes(h.a, uaTo(h.a, true)); // spurious UA
    collect(h);
  }

  // 12. AwaitingConnection receive column: hold A there (drop B's UA), walk the
  // non-terminal receives, finish by abandoning on a DM(F=1).
  {
    const h = New();
    h.dropWhen((f) => fromB(h, f) && classify(f) === "UA");
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    if (h.a.state === "AwaitingConnection") {
      h.injectFrameBytes(h.a, dmTo(h.a, false)); // DM F=0 → stay
      h.injectFrameBytes(h.a, discTo(h.a)); // DISC → stay
      // NOTE: the C# case-12 mirror posts a DL_DATA_request here (figc4.3 t09 —
      // buffer-while-connecting). That path currently THROWS in the TS runtime
      // because `SdlSessionDriver.canTransmitIFrame()` is missing the C#
      // `CanTransmitIFrame` state gate (`CurrentState is not ("Connected" or
      // "TimerRecovery") → false`): without it the post-dispatch drain pops the
      // just-buffered frame in AwaitingConnection and routes
      // `I_frame_pops_off_queue` into the `push_frame_on_queue` verb, which has
      // no DL_DATA_request trigger to read and throws. A real, pre-existing TS↔C#
      // parity divergence (NOT in the mod-128 recovery path) — flagged for Tom,
      // intentionally left untouched here (test-only scope). The DL-DATA buffer
      // step (t09) is therefore omitted; the rest of the column stands.
      h.advanceT1(); // T1 → retransmit SABM
      h.injectFrameBytes(h.a, dmTo(h.a, true)); // DM F=1 → Disconnected
    }
    collect(h);
  }
  // 12b. AwaitingConnection T1 → N2 exhaustion (give up → Disconnected).
  {
    const h = New({ n2: 2 });
    h.dropWhen((f) => fromB(h, f) && classify(f) === "UA");
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    for (let r = 0; r < 6 && h.a.state === "AwaitingConnection"; r++) h.advanceT1();
    collect(h);
  }

  // 13. AwaitingRelease receive column: hold A there (drop B's UA to the DISC),
  // walk the non-terminal receives, finish on a UA(F=1).
  {
    const h = New();
    h.connect();
    h.dropWhen((f) => fromB(h, f) && classify(f) === "UA");
    h.a.driver.postEvent({ name: "DL_DISCONNECT_request" });
    h.settle();
    if (h.a.state === "AwaitingRelease") {
      h.injectFrameBytes(h.a, uaTo(h.a, false)); // UA F=0 → stay
      h.injectFrameBytes(h.a, discTo(h.a)); // DISC → stay
      h.injectFrameBytes(h.a, sabmTo(h.a)); // SABM → stay
      h.advanceT1(); // T1 → retransmit DISC
      h.injectFrameBytes(h.a, uaTo(h.a, true)); // UA F=1 → Disconnected
    }
    collect(h);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // v2.2 arc V5a — extended-mode (mod-128) behavioural coverage. Every block
  // below runs on an extended link, routed through AwaitingV22Connection by the
  // ax25Spec44 redirect, so the Connected / TimerRecovery N(S)/N(R)/N(R)-window
  // paths execute in the 7-bit sequence space. Logical transition ids are
  // mode-independent, so these lift coverage by reaching receive-column paths the
  // mod-8 battery never drives — and prove they hold at modulo-128.
  // ──────────────────────────────────────────────────────────────────────────

  // 14. mod-128 bidirectional data transfer + delayed-ack flush.
  {
    const h = New({ extended: true, k: 8 });
    h.connect();
    h.submit(h.a, 0xa0);
    h.submit(h.b, 0xb0);
    h.submit(h.a, 0xa1);
    h.submit(h.b, 0xb1);
    h.settle();
    h.flushAcks();
    collect(h);
  }

  // 15. mod-128 window-full transfer that WRAPS the 127→0 boundary. Seed both
  // ends near the top of the 7-bit ring and transfer a burst across the wrap.
  {
    const h = New({ extended: true, k: 8 });
    h.connect();
    const seed = 124;
    h.a.context.vs = h.a.context.va = h.a.context.vr = seed;
    h.b.context.vs = h.b.context.va = h.b.context.vr = seed;
    for (let i = 0; i < 8; i++) h.submit(h.a, 0x40 + i); // N(S)=124..127,0..3
    h.flushAcks();
    collect(h);
  }

  // 16. mod-128 single-drop REJ recovery.
  {
    const h = New({ extended: true, k: 8 });
    h.connect();
    let dropped = false;
    h.dropWhen((f) => {
      if (!dropped && fromA(h, f) && isI(f) && getNs(f) === 1) {
        dropped = true;
        return true;
      }
      return false;
    });
    for (let i = 0; i < 5; i++) h.submit(h.a, i);
    h.recoverUntilConverged(40);
    collect(h);
  }

  // 17. mod-128 SREJ recovery under intermittent loss (multi-frame).
  {
    const h = New({ extended: true, srej: true, k: 8, n2: 40 });
    h.connect();
    let dropsLeft = 3;
    let seq = 0;
    h.dropWhen((f) => {
      // Deterministic stand-in for the C# `rng.NextDouble() < 0.6`: drop a few
      // I-frames from A on a fixed pattern (coverage, not statistics).
      if (dropsLeft > 0 && fromA(h, f) && isI(f) && seq++ % 2 === 0) {
        dropsLeft--;
        return true;
      }
      return false;
    });
    for (let i = 0; i < 8; i++) h.submit(h.a, i);
    h.recoverUntilConverged(60);
    collect(h);
  }

  // 18. mod-128 bidirectional loss recovery: both directions carry data AND lose
  // frames, so a station receives peer I/supervisory frames WHILE itself
  // recovering — the TimerRecovery I-received and RR/RNR receive columns.
  {
    const h = New({ extended: true, srej: true, k: 8, n2: 40 });
    h.connect();
    let aDrops = 2;
    let bDrops = 2;
    h.dropWhen((f) => {
      if (!isI(f)) return false;
      if (aDrops > 0 && fromA(h, f) && getNs(f) === 1) {
        aDrops--;
        return true;
      }
      if (bDrops > 0 && fromB(h, f) && getNs(f) === 1) {
        bDrops--;
        return true;
      }
      return false;
    });
    for (let i = 0; i < 4; i++) {
      h.submit(h.a, 0xa0 + i);
      h.submit(h.b, 0xb0 + i);
    }
    h.recoverUntilConverged(60);
    collect(h);
  }

  // 18b. mod-128 TimerRecovery receive columns — fold the proven injection
  // technique into the ledger. Drive A into TimerRecovery with N unacked
  // extended I-frames (drop A's I-frames, expire T1), then inject a crafted
  // supervisory / I frame "from B" — reaching the figc4.5 RR/RNR/REJ/SREJ/I
  // receive branches in the 7-bit space.
  const inTimerRecovery128 = (outstanding: number, srejEnabled = false): TwoStationHarness => {
    const h = New({ extended: true, srej: srejEnabled, k: 8, n2: 40 });
    h.connect();
    h.dropWhen((f) => fromA(h, f) && isI(f));
    for (let i = 0; i < outstanding; i++) h.submit(h.a, i);
    h.advanceT1(); // unacked I-frame's T1 → poll → TimerRecovery
    h.dropWhen(undefined);
    return h;
  };
  // RR response, F=1, N(R)=V(s) → completes recovery to Connected.
  { const h = inTimerRecovery128(1); h.injectFrameBytes(h.a, rrExt(h.a, 1, false, true)); collect(h); }
  // RR command, P=1, in-window → A responds, stays recovering.
  { const h = inTimerRecovery128(2); h.injectFrameBytes(h.a, rrExt(h.a, 1, true, true)); collect(h); }
  // RR response, F=0, in-window → bare ack, stays.
  { const h = inTimerRecovery128(2); h.injectFrameBytes(h.a, rrExt(h.a, 1, false, false)); collect(h); }
  // RNR command, P=1, in-window → peer-busy + enquiry response, stays.
  { const h = inTimerRecovery128(2); h.injectFrameBytes(h.a, rnrExt(h.a, 1, true, true)); collect(h); }
  // RNR response, F=1, N(R)=V(s) → peer-busy, everything acked → Connected.
  { const h = inTimerRecovery128(1); h.injectFrameBytes(h.a, rnrExt(h.a, 1, false, true)); collect(h); }
  // REJ command, P=1, N(R)=V(s) → retransmit + complete.
  { const h = inTimerRecovery128(1); h.injectFrameBytes(h.a, rejExt(h.a, 1, true, true)); collect(h); }
  // REJ response, F=1, in-window, V(s)≠N(R) (partial) → stays recovering.
  { const h = inTimerRecovery128(2); h.injectFrameBytes(h.a, rejExt(h.a, 1, false, true)); collect(h); }
  // In-sequence I command (N(S)=V(R)), P=0 → deliver peer data while recovering.
  { const h = inTimerRecovery128(1); h.injectFrameBytes(h.a, iExt(h.a, 0, 0, 0xbb, false)); collect(h); }
  // In-sequence I command, P=1 → deliver + enquiry response.
  { const h = inTimerRecovery128(1); h.injectFrameBytes(h.a, iExt(h.a, 0, 0, 0xcc, true)); collect(h); }
  // Out-of-sequence I command (N(S)=V(R)+2, a gap) → REJ/SREJ the gap, stays.
  { const h = inTimerRecovery128(1, true); h.injectFrameBytes(h.a, iExt(h.a, 0, 2, 0xdd, false)); collect(h); }
  // SREJ response, in-window, F=1, V(s)=N(R) → selective retransmit + complete.
  { const h = inTimerRecovery128(1, true); h.injectFrameBytes(h.a, srejExt(h.a, 1, false, true)); collect(h); }
  // SREJ response, in-window, F=0 → selective retransmit, stays.
  { const h = inTimerRecovery128(2, true); h.injectFrameBytes(h.a, srejExt(h.a, 0, false, false)); collect(h); }
  // DISC received while recovering → teardown to Disconnected.
  { const h = inTimerRecovery128(1); h.injectFrameBytes(h.a, discTo(h.a)); collect(h); }
  // SABME collision while recovering (vs_eq_va false here) → resync to Connected.
  { const h = inTimerRecovery128(1); h.injectFrameBytes(h.a, sabmeTo(h.a)); collect(h); }
  // UI received while recovering (P=0 and P=1) → connectionless delivery, stays.
  { const h = inTimerRecovery128(1); h.injectFrameBytes(h.a, uiTo(h.a, "r")); collect(h); }
  { const h = inTimerRecovery128(1); h.injectFrameBytes(h.a, uiTo(h.a, "s", true)); collect(h); }
  // DL primitives while recovering: redundant connect (t07), unit-data (t04),
  // flow-off/on (t05/t06), catch-all upper (t26) + lower (t25), control-field
  // error (t08).
  {
    const h = inTimerRecovery128(1);
    h.a.driver.postEvent({ name: "DL_CONNECT_request" }); // t07
    h.a.driver.postEvent({ name: "DL_UNIT_DATA_request", data: Uint8Array.from([0x01]) }); // t04
    h.a.driver.postEvent({ name: "DL_FLOW_OFF_request" }); // t05
    h.a.driver.postEvent({ name: "DL_FLOW_ON_request" }); // t06
    h.a.driver.postEvent({ name: "all_other_primitives__from_upper_layer" }); // t26
    h.inject(h.a, { name: "all_other_primitives__from_lower_layer" }); // t25
    h.inject(h.a, { name: "control_field_error" }); // t08
    collect(h);
  }
  // N2 exhaustion from TimerRecovery with peer busy registered (the
  // RC_eq_N2 ∧ vs_eq_va ∧ peer_busy branch): mark peer busy, then starve.
  {
    const h = New({ extended: true, k: 8, n2: 2 });
    h.connect();
    h.injectFrameBytes(h.a, rnrExt(h.a, 0, true, true)); // peer busy
    h.dropWhen((f) => fromA(h, f)); // starve everything from A
    h.submit(h.a, 0x01);
    for (let r = 0; r < 8 && h.a.state !== "Disconnected"; r++) h.advanceT1();
    collect(h);
  }

  // 18c. More mod-128 TimerRecovery receive branches reachable by injection.
  // DM received while recovering → teardown.
  { const h = inTimerRecovery128(1); h.injectFrameBytes(h.a, dmTo(h.a, true)); collect(h); }
  // LM-SEIZE-confirm in TimerRecovery, both ACK-pending branches.
  { const h = inTimerRecovery128(1); h.a.context.acknowledgePending = true; h.inject(h.a, { name: "LM_SEIZE_confirm" }); collect(h); }
  { const h = inTimerRecovery128(1); h.a.context.acknowledgePending = false; h.inject(h.a, { name: "LM_SEIZE_confirm" }); collect(h); }
  // REJ command (P=1) variants: in-window-not-complete and a fresh out-of-window
  // N(R) — the t23 command columns.
  { const h = inTimerRecovery128(2); h.injectFrameBytes(h.a, rejExt(h.a, 1, true, true)); collect(h); }
  { const h = inTimerRecovery128(1); h.injectFrameBytes(h.a, rejExt(h.a, 1, true, false)); collect(h); }
  // SREJ command (P=1) → the t24 not-response columns.
  { const h = inTimerRecovery128(2, true); h.injectFrameBytes(h.a, srejExt(h.a, 0, true, true)); collect(h); }
  // RR command (P=1) with TWO outstanding, N(R)=0 (no ack).
  { const h = inTimerRecovery128(2); h.injectFrameBytes(h.a, rrExt(h.a, 0, true, true)); collect(h); }
  // RNR command (P=1), N(R)=0 — peer busy, no ack.
  { const h = inTimerRecovery128(2); h.injectFrameBytes(h.a, rnrExt(h.a, 0, true, true)); collect(h); }
  // Out-of-sequence I (no SREJ) → REJ go-back-N branch.
  { const h = inTimerRecovery128(1, false); h.injectFrameBytes(h.a, iExt(h.a, 0, 2, 0xee, false)); collect(h); }
  // Out-of-sequence I, P=1 → REJ + enquiry response.
  { const h = inTimerRecovery128(1, false); h.injectFrameBytes(h.a, iExt(h.a, 0, 2, 0xef, true)); collect(h); }

  // 18d. TimerRecovery entered IDLE (via T3 expiry with V(s)=V(a)) so the
  // vs_eq_va SABM/SABME-received branches are reachable, plus DL-DATA / flow
  // paths in the empty-window recovery state. Drop B's supervisory reply so A's
  // T3-poll gets no answer and STAYS in TimerRecovery with V(s)=V(a).
  const idleInTimerRecovery128 = (): TwoStationHarness => {
    const h = New({ extended: true, k: 8 });
    h.connect();
    h.dropWhen((f) => fromB(h, f) && isSupervisoryAck(f));
    h.inject(h.a, { name: "T3_expiry" }); // idle poll → TimerRecovery, V(s)=V(a)
    h.dropWhen(undefined);
    return h;
  };
  {
    const h = idleInTimerRecovery128();
    if (h.a.state === "TimerRecovery") {
      // t02 (DL-DATA → I-frame pops) is exercised by the data-carrying mod-128
      // rigs (cases 14-18); here, with V(s)=V(a) and the window open, posting it
      // would pop and send a fresh I-frame (TimerRecovery is a send-capable
      // state, so the C# `canTransmitIFrame` gate permits it). We drive the flow
      // primitives that stay put instead.
      h.a.driver.postEvent({ name: "DL_FLOW_OFF_request" }); // t05
      h.a.driver.postEvent({ name: "DL_FLOW_ON_request" }); // t06
      h.settle();
    }
    collect(h);
  }
  {
    const h = idleInTimerRecovery128();
    if (h.a.state === "TimerRecovery") h.injectFrameBytes(h.a, sabmTo(h.a)); // t13_sabm_received_yes
    collect(h);
  }
  {
    const h = idleInTimerRecovery128();
    if (h.a.state === "TimerRecovery") h.injectFrameBytes(h.a, sabmeTo(h.a)); // t14_sabme_received_yes
    collect(h);
  }

  // 18e. More mod-128 Connected receive branches.
  // FRMR received on an extended link → figc4.4 t16_frmr_received_yes
  // (version_2_2) → re-establish, routed to AwaitingV22Connection.
  { const h = New({ extended: true, k: 8 }); h.connect(); h.injectFrameBytes(h.a, frmrTo(h.a)); collect(h); }
  // In-sequence I command with P=1 while Connected (enquiry-response branch).
  { const h = New({ extended: true, k: 8 }); h.connect(); h.injectFrameBytes(h.a, iExt(h.a, 0, 0, 0x5a, true)); collect(h); }
  // LM-SEIZE-confirm in Connected with NO ack pending (t23_lm_seize_confirm_no).
  { const h = New({ extended: true, k: 8 }); h.connect(); h.a.context.acknowledgePending = false; h.inject(h.a, { name: "LM_SEIZE_confirm" }); collect(h); }
  // An over-N1 I-frame (info field too long) → info_field_length error branch
  // (t26_i_received_yes_no_yes, version_2_2).
  {
    const h = New({ extended: true, k: 8 });
    h.connect();
    const big = new Uint8Array(h.a.context.n1 + 8);
    h.injectFrameBytes(
      h.a,
      iFrame({ destination: h.a.context.local, source: h.a.context.remote, nr: 0, ns: 0, info: big, pollBit: false, extended: true }),
    );
    collect(h);
  }
  // An I-frame with N(R) out of the send window → t26_i_received_yes_yes_no_yes
  // (version_2_2 re-establish branch). N(R)=5 with V(a)=V(s)=0 is out of window.
  {
    const h = New({ extended: true, k: 8 });
    h.connect();
    h.injectFrameBytes(h.a, iExt(h.a, 5, 0, 0x33, false));
    collect(h);
  }

  // 19. mod-128 RNR flow control: B goes busy mid-transfer (RNR), A holds, B
  // resumes (RR).
  {
    const h = New({ extended: true, k: 8 });
    h.connect();
    h.submit(h.a, 0x01);
    h.setBusy(h.b);
    h.submit(h.a, 0x02);
    h.submit(h.a, 0x03);
    h.clearBusy(h.b);
    h.flushAcks();
    collect(h);
  }

  // 20. mod-128 T3 idle keepalive: a quiescent connected station's T3 expiry
  // polls the peer (figc4.4 t13 → TimerRecovery), then the RR(F=1) response
  // settles it back to Connected.
  {
    const h = New({ extended: true, k: 8 });
    h.connect();
    h.inject(h.a, { name: "T3_expiry" }); // t13_t3_expiry → poll → TimerRecovery
    h.advanceT1(); // let the poll/response cycle settle
    collect(h);
  }

  // 21. Connected receive-column odds reachable only by injection: a UI frame
  // (P=0 / P=1), and a SABME collision arriving on an established link.
  {
    const h = New({ extended: true, k: 8 });
    h.connect();
    h.injectFrameBytes(h.a, uiTo(h.a, "u")); // t18_ui_received_no
    h.injectFrameBytes(h.a, uiTo(h.a, "v", true)); // t18_ui_received_yes
    h.injectFrameBytes(h.a, sabmeTo(h.a)); // t15_sabme_received (vs_eq_va)
    collect(h);
  }
  // 21b. SABM collision on a connected link with frames outstanding
  // (not vs_eq_va), so the not-equal branch of SABM/SABME-received fires.
  {
    const h = New({ extended: true, k: 8 });
    h.connect();
    // Wedge one I-frame outstanding (drop B's acks) so V(s) != V(a).
    h.dropWhen((f) => fromB(h, f) && isSupervisoryAck(f));
    h.submit(h.a, 0x01);
    if (h.a.context.vs !== h.a.context.va) {
      h.dropWhen(undefined);
      h.injectFrameBytes(h.a, sabmTo(h.a)); // t14_sabm_received_no
    }
    collect(h);
  }

  // 21c. mod-8 Connected receive-column odds — the `not version_2_2` sibling
  // branches the extended rigs (21 / 18e) never reach. An over-N1 I-frame
  // (t26_i_received_yes_no_no, mod-8 info-too-long), and RR/RNR responses with
  // N(R) out of the send window (t21_rr_received_no_no / t22_rnr_received_no_no —
  // the not-in-window mod-8 branches). Mode-independent ids, exercised at mod-8.
  {
    const h = New({ k: 4 });
    h.connect();
    const big = new Uint8Array(h.a.context.n1 + 8);
    h.injectFrameBytes(
      h.a,
      iFrame({ destination: h.a.context.local, source: h.a.context.remote, nr: 0, ns: 0, info: big, pollBit: false }),
    ); // t26_i_received_yes_no_no
    h.injectFrameBytes(
      h.a,
      rr({ destination: h.a.context.local, source: h.a.context.remote, nr: 5, isCommand: false, pollFinal: false }),
    ); // t21_rr_received_no_no (N(R)=5 out of window)
    h.injectFrameBytes(
      h.a,
      rnr({ destination: h.a.context.local, source: h.a.context.remote, nr: 5, isCommand: false, pollFinal: false }),
    ); // t22_rnr_received_no_no
    collect(h);
  }

  // 22. AwaitingV22Connection — push past the establishment column via its
  // catch-all input columns + a control-field error that all keep it parked:
  // t06 (other upper-layer), t18 (other lower-layer), t07 (control-field error).
  {
    const h = New({ extended: true });
    h.dropWhen((f) => isSabmOrSabme(f) && fromA(h, f));
    h.a.driver.postEvent({ name: "DL_CONNECT_request" });
    h.settle();
    if (h.a.state === "AwaitingV22Connection") {
      h.a.driver.postEvent({ name: "all_other_primitives__from_upper_layer" }); // t06
      h.settle();
      h.inject(h.a, { name: "all_other_primitives__from_lower_layer" }); // t18
      h.inject(h.a, { name: "control_field_error" }); // t07
    }
    collect(h);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // MDL (management_data_link) machine — Ready / Negotiating. The MDL driver
  // runs its own SdlSessionDriver; the harness forwards its transition-fired
  // hook, so these register on the SAME ledger (Ready/Negotiating don't collide
  // with the data-link states). Drives every figc5.1/5.2 path the prose-bootstrap
  // encodes.
  // ──────────────────────────────────────────────────────────────────────────

  // 23. Happy-path XID negotiation between two v2.2 stations: the figc4.6 UA path
  // raises MDL-NEGOTIATE Request → XID command/response exchange → both confirm.
  // Ready t01 (negotiate) + Negotiating t01_yes (F=1 success).
  {
    const h = New({ extended: true, srej: true, k: 8 });
    h.connect();
    collect(h);
  }

  // 24. MDL error B — an unexpected XID response arriving in Ready (no command
  // outstanding). Ready t02_xid_response_received.
  {
    const h = New({ extended: true, srej: true, k: 8 });
    const info = encodeXid({ windowSizeRx: 4 });
    h.a.mdl.onXidReceived(
      xid({ destination: h.a.context.local, source: h.a.context.remote, info, isCommand: false, pollFinal: true }),
    );
    h.settle();
    collect(h);
  }

  // 25. MDL error D — an XID response without F=1 while Negotiating (stays
  // Negotiating, TM201 still running). Negotiating t01_xid_response_received_no.
  {
    const h = New({ extended: true, srej: true, k: 8 });
    h.dropWhen((f) => isXidFromA(h, f));
    h.startNegotiation(h.a);
    if (h.a.mdlState === "Negotiating") {
      const info = encodeXid({ windowSizeRx: 4 });
      h.a.mdl.onXidReceived(
        xid({ destination: h.a.context.local, source: h.a.context.remote, info, isCommand: false, pollFinal: false }),
      );
      h.settle();
    }
    collect(h);
  }

  // 26. MDL v2.0 fallback — a pre-v2.2 peer FRMRs the XID command (figc5.2
  // t02_frmr_received → full §1436 v2.0 defaults, confirm, → Ready).
  {
    const h = New({ extended: true, srej: true, k: 8 });
    h.dropWhen((f) => isXidFromA(h, f));
    h.startNegotiation(h.a);
    if (h.a.mdlState === "Negotiating") {
      h.a.mdl.onFrmrReceived(
        frmr({ destination: h.a.context.local, source: h.a.context.remote, info: new Uint8Array(0) }),
      );
      h.settle();
    }
    collect(h);
  }

  // 27. MDL TM201 retry + NM201 exhaustion (error C): drop every XID command so
  // no reply comes; TM201 retries (t03_tm201_expiry_no) then gives up at
  // RC==NM201 (t03_tm201_expiry_yes → MDL-ERROR C, → Ready).
  {
    const h = New({ extended: true, srej: true, k: 8, n2: 2 });
    h.dropWhen((f) => isXidFromA(h, f));
    h.startNegotiation(h.a);
    for (let r = 0; r < 5 && h.a.mdlState === "Negotiating"; r++) h.advanceTm201();
    collect(h);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Segmentation over a mod-128 link (V4b shim through the wired path).
  // ──────────────────────────────────────────────────────────────────────────

  // 28. Multi-segment payload over mod-128 with a mid-series drop + selective
  // (SREJ) recovery — the V4 headline path, folded into the ledger so the
  // segment I-frame send/receive + SREJ recovery register.
  {
    const h = New({ extended: true, srej: true, k: 16, n2: 40, segmenter: true, n1: 64 });
    h.connect();
    const payload = Uint8Array.from({ length: 300 }, (_, i) => (i * 5 + 2) & 0xff); // 5 segments
    let dropped = false;
    h.dropWhen((f) => {
      if (!dropped && fromA(h, f) && isI(f) && getNs(f) === 2) {
        dropped = true;
        return true;
      }
      return false;
    });
    h.submitLarge(h.a, payload);
    for (let r = 0; r < 40 && h.b.delivered.length === 0; r++) h.advanceT1();
    collect(h);
  }

  // The OR'd membership predicate over every rig.
  return (from, id) => rigs.some((h) => h.firedTransition(from, id));
}

describe("v2.2 arc V5a — behavioural transition-coverage ledger", () => {
  it("the scenario battery meets the curated floor and reports per-state coverage", () => {
    const fired = runBatteryAndCollectFired();

    // ── Report (per-state hit/total + the misses) ──────────────────
    let total = 0;
    let hit = 0;
    const lines: string[] = [];
    for (const [state, page] of TABLES) {
      const ids = page.transitions.map((t) => t.id);
      const covered = ids.filter((id) => fired(state, id));
      total += ids.length;
      hit += covered.length;
      lines.push(`${state.padEnd(22)} ${String(covered.length).padStart(3)}/${String(ids.length).padEnd(3)} behavioural`);
      const misses = ids.filter((id) => !fired(state, id));
      if (misses.length > 0) lines.push(`    miss: ${misses.join(", ")}`);
    }
    lines.push(`\nTOTAL ${hit}/${total} transitions behaviourally exercised by the battery`);
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));

    // ── Assert: each reachable state is behaviourally exercised (a curated,
    // robust must-hit — confirmed-fired ids the battery is built to drive).
    // AwaitingV22Connection is driven extensively since V5a (now 20/25 — the
    // residual 5 misses are the never-produced error inputs t08/t09 and the
    // not-layer-3-initiated branches t04_no/t05; the responder never parks here,
    // it goes straight Disconnected→Connected on SABME). The MDL
    // (management_data_link) machine is now on the ledger too (Ready /
    // Negotiating, both fully exercised). Mirrors the C# must-hit set. ──
    const mustHit: ReadonlyArray<readonly [string, string]> = [
      ["Disconnected", "t03_dl_connect_request"], // A initiates a connect
      ["Disconnected", "t13_sabm_received_yes"], // B accepts an incoming SABM
      ["AwaitingConnection", "t04_ua_received_yes_yes"], // connect completes
      ["AwaitingV22Connection", "t12_ua_received_yes_yes"], // mod-128 connect completes (figc4.6)
      ["AwaitingV22Connection", "t13_t1_expiry_no"], // lost SABME retried as SABME
      ["AwaitingV22Connection", "t14_frmr_received"], // §975 v2.0 fallback
      ["AwaitingV22Connection", "t11_dm_received_yes"], // §975 DM teardown
      ["AwaitingV22Connection", "t07_control_field_error"], // V5a: malformed frame while v2.2-pending
      ["AwaitingV22Connection", "t06_all_other_primitives__from_upper_layer"], // V5a: catch-all upper
      ["AwaitingV22Connection", "t18_all_other_primitives__from_lower_layer"], // V5a: catch-all lower
      ["Connected", "t02_dl_data_request"], // upper layer sends data
      ["Connected", "t21_rr_received_yes"], // an RR acks
      ["Connected", "t13_t3_expiry"], // V5a: idle keepalive poll
      ["Connected", "t16_frmr_received_yes"], // V5a: extended-link FRMR → re-establish (v2.2 branch)
      ["Connected", "t18_ui_received_yes"], // V5a: connectionless UI on an established link
      ["Connected", "t26_i_received_yes_no_yes"], // V5a: over-N1 I-frame (info too long, v2.2 branch)
      ["AwaitingRelease", "t03_ua_received_yes"], // disconnect completes
      ["TimerRecovery", "t15_frmr_received"], // FRMR during recovery
      ["TimerRecovery", "t18_rr_received_yes_yes_yes"], // V5a: poll/final RR completes mod-128 recovery
      ["TimerRecovery", "t24_srej_received_yes_yes_yes_yes"], // V5a: SREJ selective recovery (7-bit)
      ["TimerRecovery", "t12_dm_received"], // V5a: DM teardown while recovering
      ["TimerRecovery", "t20_lm_seize_confirm_yes"], // V5a: LM-SEIZE-confirm with ack pending
      ["TimerRecovery", "t14_sabme_received_no"], // V5a: SABME collision while recovering
      // MDL (management_data_link) — XID negotiation FSM, on the ledger via V5a.
      ["Ready", "t01_mdl_negotiate_request"], // XID command sent on a v2.2 connect
      ["Negotiating", "t01_xid_response_received_yes"], // negotiation completes (F=1)
      ["Negotiating", "t02_frmr_received"], // pre-v2.2 peer FRMRs → v2.0 fallback
      ["Negotiating", "t03_tm201_expiry_yes"], // NM201 retry limit → MDL-ERROR C
    ];
    const missingMustHit = mustHit.filter(([state, id]) => !fired(state, id));
    expect(
      missingMustHit,
      `the battery should behaviourally exercise every curated must-hit transition; missing: ${missingMustHit
        .map(([s, i]) => `${s}/${i}`)
        .join(", ")}`,
    ).toEqual([]);

    // ── Assert: a floor on total behavioural coverage (regression guard) ──
    // Mirrors the C# floor of 122/250: V5a's extended-mode data/loss/recovery +
    // the MDL machine + segmentation lift the battery well above the V2-era
    // baseline. If this drops, a scenario regressed or a path stopped being
    // reached.
    expect(
      hit,
      `the scenario battery should behaviourally exercise a substantial share of the ${total} transitions; ` +
        "if this drops, a scenario regressed or a path stopped being reached",
    ).toBeGreaterThanOrEqual(122);
  });
});
