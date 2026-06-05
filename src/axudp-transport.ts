/**
 * Node-only AXUDP transport — AX.25 frames over UDP (BPQAXIP / RFC-1226).
 *
 * The UDP analog of {@link ./tcp-transport.ts TcpKissTransport}: same
 * {@link Ax25Transport} seam (so the {@link ./listener.ts Ax25Listener} + the
 * netrom module run over it exactly as over KISS-TCP), but the wire is a UDP
 * datagram to a real AXIP/AXUDP peer (LinBPQ's BPQAXIP, XRouter, ax25ipd,
 * JNOS) rather than a KISS-TCP stream.
 *
 * **AXUDP is not KISS.** There is no SLIP framing, no command byte, no CSMA. A
 * datagram's payload *is* the AX.25 frame body (the same KISS-form octets the
 * listener produces — no flag, no bit-stuffing) followed by the **2-octet
 * AX.25 FCS** (CRC-16/X.25, low byte first):
 *
 *   - `send`: append the FCS, write one datagram to the configured remote.
 *   - inbound `message`: strip + validate the FCS, surface the bare AX.25 body
 *     via `onFrame`; **drop** any datagram too short to carry an FCS or whose
 *     FCS doesn't check (exactly as a real peer drops a bad-CRC datagram).
 *
 * **The FCS is unconditional — there is no FCS-less mode.** A citation survey
 * of every real AXIP/AXUDP implementation (RFC 1226 + rfc1226-bis, ax25ipd,
 * LinBPQ's BPQAXIP, XRouter, JNOS) found the FCS mandatory in all of them and
 * FCS-less accepted by none — so an AXUDP port talks to a real peer out of the
 * box, and stripping it on receive is mandatory not cosmetic: the AX.25 parser
 * rejects an S-frame (RR/RNR/REJ ack) carrying a trailing FCS tail, so an
 * unstripped tail would silently drop every supervisory frame and break
 * connected mode. (A pdn-only FCS-less form once existed in the C# side; it
 * interoperated with nothing and was removed — packet.net #304/#306.)
 *
 * Point-to-point: unlike a shared RF channel, every outbound frame goes to the
 * one configured `remote`. A frame addressed to a third station is still sent
 * to the configured peer (whose AX.25 layer then ignores it by address) — same
 * as pointing a serial KISS link at one modem.
 *
 * **Not re-exported from `index.ts`** — same rationale as the TCP transport:
 * the library is browser-targeted and `node:dgram` has no browser polyfill.
 * Node callers reach for this via the subpath export:
 *
 * ```ts
 * import { AxudpTransport } from "@packet-net/ax25/axudp-transport";
 * ```
 */
import { createSocket, type Socket } from "node:dgram";
import { appendFcs, stripFcs } from "./fcs.js";
import type { Ax25Transport } from "./transport.js";

export interface AxudpTransportOptions {
  /**
   * Local UDP port to bind for receive. `0` (the default) picks any free
   * ephemeral port. A real peer that *originates* connects to us (e.g. BPQ
   * dialling a statically-MAP'd callsign) needs us on a known fixed port, so
   * pass an explicit value there.
   */
  localPort?: number;
  /**
   * Local address to bind. Defaults to all interfaces. Pass `127.0.0.1` to
   * bind loopback only (e.g. the interop docker stack).
   */
  localAddress?: string;
  /** Optional bind timeout in ms. Default 5000. */
  bindTimeoutMs?: number;
  /**
   * Socket factory hook (test seam). When provided, `start()` calls this
   * instead of `dgram.createSocket`. Production callers leave it undefined;
   * the unit tests pass a paired in-memory fake to exercise the
   * send/receive/FCS paths without real UDP.
   */
  socketFactory?: () => Socket;
}

const DEFAULT_BIND_TIMEOUT_MS = 5000;

/**
 * AXUDP transport for Node. Binds a UDP socket on `start`, sends every
 * outbound AX.25 frame (FCS appended) as a datagram to the configured
 * `host:port`, and surfaces inbound datagrams (FCS stripped + validated) via
 * the `onFrame` callback; `stop` closes the socket.
 */
export class AxudpTransport implements Ax25Transport {
  private readonly host: string;
  private readonly port: number;
  private readonly localPort: number;
  private readonly localAddress: string | undefined;
  private readonly bindTimeoutMs: number;
  private readonly socketFactory: () => Socket;
  private socket: Socket | null = null;
  private onFrame: ((axBytes: Uint8Array) => void) | null = null;
  private running = false;
  private boundPort = 0;

  constructor(host: string, port: number, opts: AxudpTransportOptions = {}) {
    this.host = host;
    this.port = port;
    this.localPort = opts.localPort ?? 0;
    this.localAddress = opts.localAddress;
    this.bindTimeoutMs = opts.bindTimeoutMs ?? DEFAULT_BIND_TIMEOUT_MS;
    this.socketFactory = opts.socketFactory ?? (() => createSocket("udp4"));
  }

  /**
   * The local UDP port the socket is actually bound to. `0` until `start()`
   * resolves; after that it is the real port (an ephemeral pick when
   * `localPort` was 0). Useful for tests / logging.
   */
  get boundLocalPort(): number {
    return this.boundPort;
  }

  async start(onFrame: (axBytes: Uint8Array) => void): Promise<void> {
    this.onFrame = onFrame;
    if (this.running) return;

    const socket = this.socketFactory();
    this.socket = socket;

    // The shim types EventEmitter listener args as `unknown`; the `message`
    // event's first arg is the datagram payload (a Buffer = Uint8Array).
    socket.on("message", (msg: unknown) => this.handleDatagram(msg));

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onError = (err: unknown) => {
        if (settled) return;
        settled = true;
        socket.off("listening", onListening);
        clearTimeout(timer);
        const e = err instanceof Error ? err : new Error(`socket error: ${String(err)}`);
        try {
          socket.close();
        } catch {
          // best-effort
        }
        reject(e);
      };
      const onListening = () => {
        if (settled) return;
        settled = true;
        socket.off("error", onError);
        clearTimeout(timer);
        try {
          this.boundPort = socket.address().port;
        } catch {
          // address() can throw if the socket raced closed; leave boundPort 0.
        }
        resolve();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.off("listening", onListening);
        socket.off("error", onError);
        try {
          socket.close();
        } catch {
          // best-effort
        }
        reject(
          new Error(
            `AxudpTransport: bind to ${this.localAddress ?? "0.0.0.0"}:${this.localPort} timed out after ${this.bindTimeoutMs}ms`,
          ),
        );
      }, this.bindTimeoutMs);
      socket.once("listening", onListening);
      socket.once("error", onError);
      socket.bind(this.localPort, this.localAddress);
    });

    // Once bound, a socket `error` (e.g. ICMP port-unreachable surfaced as
    // ECONNREFUSED on a connected-less send) should not crash the process.
    // The session driver sees the link die via its own timers; logging is
    // enough for ops — same posture as the TCP transport's post-connect error
    // swallow.
    socket.on("error", () => {
      // swallowed — see comment above
    });

    this.running = true;
  }

  async send(axBytes: Uint8Array): Promise<void> {
    if (!this.running || !this.socket) {
      throw new Error("AxudpTransport: not started");
    }
    // The listener hands us the AX.25 frame body (KISS form, no FCS) — that is
    // the AXUDP datagram payload. Append the 2-octet FCS (low byte first);
    // AXUDP always carries it.
    const datagram = appendFcs(axBytes);
    await new Promise<void>((resolve, reject) => {
      this.socket!.send(datagram, this.port, this.host, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        socket.close(done);
      } catch {
        // Already closed / never bound — nothing to wait for.
        done();
      }
    });
  }

  private handleDatagram(msg: unknown): void {
    // The datagram payload is the AX.25 frame body + 2-octet FCS. Strip +
    // validate the FCS; drop the datagram if it's too short or the FCS is bad
    // (exactly as a real AXIP/AXUDP peer drops a bad-CRC datagram).
    if (!isByteArrayLike(msg)) return;
    const bytes = msg instanceof Uint8Array ? msg : new Uint8Array(msg);
    const body = stripFcs(bytes);
    if (body === null) return; // too short, or FCS mismatch — drop
    if (this.onFrame) this.onFrame(body);
  }
}

function isByteArrayLike(x: unknown): x is ArrayLike<number> {
  return (
    x !== null && typeof x === "object" && typeof (x as { length?: unknown }).length === "number"
  );
}
