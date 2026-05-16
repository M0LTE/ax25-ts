/**
 * Transport-layer abstraction: send and receive raw AX.25 frame bytes
 * (no KISS framing — that's the transport's job).
 *
 * Concrete implementations:
 *   - {@link WebSerialKissTransport} — KISS over Web Serial (browser).
 *   - `TcpKissTransport` (Node-only, via `@packet-net/ax25/tcp-transport` subpath import).
 *   - `MockTransport` (tests/mock-transport.ts) — paired in-memory mock for tests.
 *
 * Future implementations (out of scope for v0.1):
 *   - AgwTransport
 *   - AxudpTransport
 */
export interface Ax25Transport {
  /**
   * Start the transport and subscribe to inbound AX.25 frames. The
   * callback receives KISS-stripped AX.25 frame bytes (no FCS, no FEND).
   * Idempotent: calling `start` while running re-binds the callback.
   */
  start(onFrame: (axBytes: Uint8Array) => void): Promise<void>;

  /** Send one AX.25 frame to the modem. */
  send(axBytes: Uint8Array): Promise<void>;

  /** Stop the transport and release resources. */
  stop(): Promise<void>;
}
