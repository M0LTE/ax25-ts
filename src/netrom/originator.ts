import { Callsign } from "../callsign.js";
import { PID_NET_ROM } from "../frame.js";
import type { Ax25Listener } from "../listener.js";
import { buildNodesBroadcast } from "./nodes-broadcast-builder.js";
import { NODES_DESTINATION } from "./nodes-broadcast.js";
import type { NetRomRoutingTable } from "./routing-table.js";

/** The subset of {@link Ax25Listener} the originator needs: the UI-send path. */
export type NetRomUiSender = Pick<Ax25Listener, "sendUi">;

/**
 * Construction options for {@link NetRomOriginator}. Every field is optional.
 *
 * Mirrors the origination-relevant fields of the C# `NetRomConfig` +
 * `NetRomService` origination path.
 */
export interface NetRomOriginatorOptions {
  /**
   * Whether origination is enabled (the C# `netRom.broadcast` opt-in). Default
   * `false` — **a library must not transmit unless asked**. When `false`,
   * {@link NetRomOriginator.broadcastNodes} is a no-op and
   * {@link NetRomOriginator.start} refuses to arm the scheduler. The embedder
   * flips this on to advertise the node and its routes.
   */
  enabled?: boolean;
  /**
   * The broadcasting node's NET/ROM alias / mnemonic (the header alias every
   * NODES frame carries; the receiver pairs it with the UI-frame source callsign
   * to learn us). Defaults to `""`; if left empty and {@link nodeCall} is given,
   * the node callsign's base is used (mirroring the C# `ResolveAlias` fallback to
   * `nodeCall.Base`).
   */
  alias?: string;
  /**
   * The node's own callsign — used only as the alias fallback (see
   * {@link alias}). The per-frame source callsign is the *listener's* `myCall`
   * (the originator never overrides it), so this is purely for the alias.
   */
  nodeCall?: Callsign | string;
  /**
   * The OBSMIN advertise-gate passed to
   * {@link NetRomRoutingTable.buildAdvertisement}: a learned route whose
   * obsolescence has decayed below this is kept + usable but no longer
   * re-advertised. Defaults to the routing table's configured
   * {@link NetRomRoutingOptions.obsoleteMinimum} (canonical 4). Pass `0` to
   * re-advertise every kept route.
   */
  obsoleteMinimum?: number;
  /**
   * Optional sink for per-port send failures. Each port's UI send is wrapped so
   * one failing transport can't stop the broadcast reaching the others, and so a
   * scheduled tick can never throw out of the timer. Defaults to a no-op.
   */
  onSendError?: (err: unknown) => void;
}

/** The literal `NODES` AX.25 destination every broadcast is addressed to. */
const NODES_DEST = new Callsign(NODES_DESTINATION, 0);

/**
 * The NET/ROM NODES **origination** (TX) half — the counterpart to the
 * read-only {@link NetRomService} ingest tap. It advertises *this* node and the
 * learned destinations worth re-advertising by building NODES broadcast frames
 * from a {@link NetRomRoutingTable} (via {@link buildNodesBroadcast}, OBSMIN-gated
 * by {@link NetRomRoutingTable.buildAdvertisement}) and emitting each as a UI
 * frame (PID 0xCF, AX.25 destination the literal text callsign `NODES`) out
 * every attached port's {@link Ax25Listener.sendUi} path.
 *
 * **Opt-in, embedder-driven.** Origination is off until
 * {@link NetRomOriginatorOptions.enabled} is set — a library must not put
 * traffic on the air unless asked (mirrors the C# `netRom.broadcast` opt-in).
 * The periodic re-broadcast scheduler (the NODESINTERVAL timer) is likewise
 * opt-in and *embedder-driven*: call {@link start} with the interval to arm a
 * `setInterval`, or just call {@link broadcastNodes} from your own scheduler —
 * consistent with how TS-2's circuit `tick()` and the ingest service's `sweep()`
 * are embedder-driven (the library owns no ambient timers, which keeps it
 * trivially testable). OFF by default; nothing is transmitted until you ask.
 *
 * The node announces *itself* simply by being the UI-frame source plus the
 * header alias — the receiver creates a neighbour entry (and an assumed direct
 * route) for us from that, exactly as our own ingest does for a heard neighbour
 * (canonical heuristics 3 + 4). So a header-only broadcast (empty table) is
 * still a useful "I'm here" announcement; learned destinations are added on top,
 * gated by OBSMIN.
 *
 * Construction stays strict / canonical — {@link buildNodesBroadcast} never
 * emits a frame that violates the canonical format (the outbound path is always
 * spec-faithful, per CLAUDE.md), even though the parser tolerates real-world
 * divergences inbound.
 *
 * Mirrors the origination portion of `Packet.Node.Core.NetRom.NetRomService`
 * (`BroadcastNodes` + the NODESINTERVAL tick) on the C# side. The C# service
 * fuses ingest + origination + the L4 circuit layer into one type and owns its
 * own `TimeProvider` sweep timer; the TS split keeps the read-only ingest
 * ({@link NetRomService}) and the TX origination (this class) as separate
 * objects over a shared {@link NetRomRoutingTable}, and leaves the interval to
 * the embedder.
 */
export class NetRomOriginator {
  private readonly table: NetRomRoutingTable;
  private readonly enabledFlag: boolean;
  private readonly alias: string;
  private readonly obsoleteMinimum: number | undefined;
  private readonly onSendError: (err: unknown) => void;
  private readonly listeners = new Map<string, NetRomUiSender>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  /**
   * @param table The routing table to advertise from (typically the same table
   *   the ingest {@link NetRomService} learns into, so we re-advertise what we
   *   hear). Its `buildAdvertisement` is the OBSMIN-gated source of entries.
   * @param options Origination options. Off by default — set
   *   {@link NetRomOriginatorOptions.enabled} to transmit.
   */
  constructor(table: NetRomRoutingTable, options: NetRomOriginatorOptions = {}) {
    this.table = table;
    this.enabledFlag = options.enabled ?? false;
    this.obsoleteMinimum = options.obsoleteMinimum;
    this.onSendError = options.onSendError ?? (() => {});

    let alias = options.alias ?? "";
    if (alias === "" && options.nodeCall !== undefined) {
      const call =
        typeof options.nodeCall === "string"
          ? Callsign.parse(options.nodeCall)
          : options.nodeCall;
      alias = call.base;
    }
    this.alias = alias;
  }

  /** True if origination is enabled on this originator. */
  get enabled(): boolean {
    return this.enabledFlag;
  }

  /** The alias every originated NODES broadcast carries in its header. */
  get senderAlias(): string {
    return this.alias;
  }

  /** Port ids currently attached (a broadcast goes out each). */
  get attachedPorts(): readonly string[] {
    return [...this.listeners.keys()];
  }

  /** True while the periodic scheduler is armed (see {@link start}). */
  get isScheduled(): boolean {
    return this.timer !== null;
  }

  /**
   * Make a port available for origination — its {@link Ax25Listener.sendUi} is
   * how broadcasts reach the air. No-op if origination is disabled, the
   * originator is disposed, or the port is already attached.
   *
   * @param portId The port id (matches the ingest service's port id; used for
   *   detach + error reporting).
   * @param listener The port's AX.25 listener (its `sendUi` carries the frame).
   */
  attachPort(portId: string, listener: NetRomUiSender): void {
    if (!this.enabledFlag || this.disposed) {
      return;
    }
    if (this.listeners.has(portId)) {
      return; // already attached — leave the first
    }
    this.listeners.set(portId, listener);
  }

  /** Stop originating on a port. No-op if the port was not attached. */
  detachPort(portId: string): void {
    this.listeners.delete(portId);
  }

  /**
   * Originate our NODES broadcast on every attached port *now*: the header alias
   * + a destination entry per advertisable route (OBSMIN-gated via
   * {@link NetRomRoutingTable.buildAdvertisement}), framed by
   * {@link buildNodesBroadcast} (chunked 11 entries/frame) and emitted as UI
   * frames (dest `NODES`, PID 0xCF, source the listener's own callsign). A no-op
   * when origination is disabled or the originator is disposed.
   *
   * Each port's send is isolated so one failing transport can't stop the others;
   * a failure is routed to {@link NetRomOriginatorOptions.onSendError}. Returns
   * once every send has been dispatched (each `sendUi` resolves when its
   * transport accepts the bytes). Exposed so a test (or an embedder's own
   * scheduler) can drive a broadcast deterministically without the interval
   * timer.
   *
   * Mirrors the C# `NetRomService.BroadcastNodes`.
   */
  async broadcastNodes(): Promise<void> {
    if (!this.enabledFlag || this.disposed) {
      return;
    }
    const entries = this.table.buildAdvertisement(this.obsoleteMinimum);
    const frames = buildNodesBroadcast(this.alias, entries);

    const sends: Promise<void>[] = [];
    for (const listener of this.listeners.values()) {
      for (const info of frames) {
        sends.push(this.sendSafe(listener, info));
      }
    }
    await Promise.all(sends);
  }

  /**
   * Arm the periodic NODESINTERVAL scheduler: re-broadcast every `intervalMs`.
   * The first broadcast fires after one interval (not immediately — call
   * {@link broadcastNodes} yourself first if you want an immediate announce).
   * OFF by default — origination only ever schedules when *you* call this, so
   * the library starts no ambient timers. No-op (returns `false`) if origination
   * is disabled, the originator is disposed, or a scheduler is already armed.
   *
   * The timer is `unref`'d where the runtime supports it (Node) so a pending
   * re-broadcast never holds the event loop open on its own.
   *
   * @param intervalMs The re-broadcast interval in milliseconds (must be > 0).
   * @returns `true` if the scheduler was armed, `false` otherwise.
   */
  start(intervalMs: number): boolean {
    if (!this.enabledFlag || this.disposed || this.timer !== null) {
      return false;
    }
    if (!(intervalMs > 0)) {
      throw new Error(`NODESINTERVAL must be a positive number of ms (got ${intervalMs})`);
    }
    this.timer = setInterval(() => {
      // The tick is fire-and-forget: broadcastNodes isolates per-port send
      // failures already, but guard the whole thing so a rejected promise can
      // never become an unhandled rejection out of the timer.
      void this.broadcastNodes().catch((err) => this.onSendError(err));
    }, intervalMs);
    // Don't let the re-broadcast timer keep the process alive on its own.
    (this.timer as { unref?: () => void }).unref?.();
    return true;
  }

  /** Disarm the periodic scheduler (if armed). Idempotent. Safe to re-`start`. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Stop the scheduler and detach every port. Idempotent. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stop();
    this.listeners.clear();
  }

  // ─── Internals ────────────────────────────────────────────────────

  private async sendSafe(
    listener: NetRomUiSender,
    info: Uint8Array,
  ): Promise<void> {
    try {
      await listener.sendUi(NODES_DEST, info, PID_NET_ROM);
    } catch (err) {
      this.onSendError(err);
    }
  }
}
