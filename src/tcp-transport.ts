/**
 * Node-only KISS-over-TCP transport.
 *
 * Same shape as {@link ./webserial-transport.ts WebSerialKissTransport} but
 * speaks to a remote KISS-TCP listener (BPQ, Xrouter, direwolf's `kissnet`,
 * net-sim, etc.) over a TCP socket.
 *
 * **Not re-exported from `index.ts` on purpose.** The library is targeted
 * at browsers; pulling Node imports into the main entrypoint would force
 * bundlers to deal with `node:net` polyfills. Node callers reach for this
 * via the subpath export:
 *
 * ```ts
 * import { TcpKissTransport } from "@packet-net/ax25/tcp-transport";
 * ```
 *
 * The Web Serial transport remains the only transport reachable from the
 * main entrypoint.
 */
import { createConnection, type Socket } from "node:net";
import { KISS_CMD, KissDecoder, encodeKiss } from "./kiss.js";
import type { Ax25Transport } from "./transport.js";

export interface TcpKissTransportOptions {
  /** Multi-drop KISS port number (0-15). Default 0. */
  kissPort?: number;
  /** Optional connect timeout in ms. Default 5000. */
  connectTimeoutMs?: number;
  /**
   * Socket factory hook (test seam). When provided, `start()` calls this
   * instead of `net.createConnection`. Production callers leave it
   * undefined; the unit tests pass a `MockSocket` to exercise the
   * read/write/close paths without dialing real TCP.
   */
  socketFactory?: (host: string, port: number) => Socket;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

/**
 * KISS-over-TCP transport for Node. Open a socket on `start`, push inbound
 * bytes through a `KissDecoder` and surface AX.25 frame payloads via the
 * `onFrame` callback; `send` KISS-encodes outbound frames and writes
 * them; `stop` closes the socket cleanly.
 */
export class TcpKissTransport implements Ax25Transport {
  private readonly host: string;
  private readonly port: number;
  private readonly kissPort: number;
  private readonly connectTimeoutMs: number;
  private readonly socketFactory: (host: string, port: number) => Socket;
  private readonly decoder = new KissDecoder();
  private socket: Socket | null = null;
  private onFrame: ((bytes: Uint8Array) => void) | null = null;
  private running = false;

  constructor(host: string, port: number, opts: TcpKissTransportOptions = {}) {
    this.host = host;
    this.port = port;
    this.kissPort = opts.kissPort ?? 0;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.socketFactory =
      opts.socketFactory ?? ((h, p) => createConnection({ host: h, port: p }));
  }

  async start(onFrame: (axBytes: Uint8Array) => void): Promise<void> {
    this.onFrame = onFrame;
    if (this.running) return;

    const socket = this.socketFactory(this.host, this.port);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onConnect = () => {
        if (settled) return;
        settled = true;
        socket.off("error", onError);
        clearTimeout(timer);
        resolve();
      };
      const onError = (err: unknown) => {
        if (settled) return;
        settled = true;
        socket.off("connect", onConnect);
        clearTimeout(timer);
        const e =
          err instanceof Error ? err : new Error(`socket error: ${String(err)}`);
        try {
          socket.destroy();
        } catch {
          // best-effort
        }
        reject(e);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.off("connect", onConnect);
        socket.off("error", onError);
        try {
          socket.destroy();
        } catch {
          // best-effort
        }
        reject(
          new Error(
            `TcpKissTransport: connect to ${this.host}:${this.port} timed out after ${this.connectTimeoutMs}ms`,
          ),
        );
      }, this.connectTimeoutMs);
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });

    socket.on("data", (chunk: unknown) => this.handleChunk(chunk));
    // Once-connected `error` should not surface as an unhandled exception.
    // The session driver will see the link die via `close` and force-tear
    // down its session; surfacing the error to console is enough for ops.
    socket.on("error", () => {
      // swallowed — see comment above
    });
    socket.on("close", () => {
      this.running = false;
    });

    this.running = true;
  }

  async send(axBytes: Uint8Array): Promise<void> {
    if (!this.running || !this.socket) {
      throw new Error("TcpKissTransport: not started");
    }
    const framed = encodeKiss(this.kissPort, KISS_CMD.Data, axBytes);
    await new Promise<void>((resolve, reject) => {
      this.socket!.write(framed, (err?: Error) => {
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
    if (socket.destroyed) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      socket.once("close", done);
      try {
        socket.end(() => {
          // `end()` half-closes; the peer's FIN drives `close`. If the
          // peer doesn't FIN promptly, destroy after a short grace to
          // avoid hanging stop().
          setTimeout(() => {
            try {
              socket.destroy();
            } catch {
              // best-effort
            }
            done();
          }, 200);
        });
      } catch {
        try {
          socket.destroy();
        } catch {
          // best-effort
        }
        done();
      }
    });
  }

  private handleChunk(chunk: unknown): void {
    // Node's `data` event fires with a Buffer (a Uint8Array subclass).
    // We accept anything Uint8Array-shaped so the test-harness can push
    // plain Uint8Arrays without instantiating a Buffer.
    if (!isByteArrayLike(chunk)) return;
    const bytes =
      chunk instanceof Uint8Array
        ? chunk
        : new Uint8Array(chunk as ArrayLike<number>);
    const frames = this.decoder.push(bytes);
    for (const f of frames) {
      if (f.command !== KISS_CMD.Data) continue;
      if (f.port !== this.kissPort) continue;
      if (this.onFrame) this.onFrame(f.payload);
    }
  }
}

function isByteArrayLike(x: unknown): x is ArrayLike<number> {
  return (
    x !== null && typeof x === "object" && typeof (x as { length?: unknown }).length === "number"
  );
}
