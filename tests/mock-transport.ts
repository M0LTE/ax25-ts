import type { Ax25Transport } from "../src/transport.js";

/**
 * In-memory test transport. Two ends are linked with {@link pair}: each
 * `send` on side A causes an `onFrame` callback on side B and vice versa.
 *
 * Frames are delivered via `queueMicrotask` so the round-trip matches the
 * "process this in the next tick" semantics of a real async transport.
 */
export class MockTransport implements Ax25Transport {
  private listener: ((bytes: Uint8Array) => void) | null = null;
  private peer: MockTransport | null = null;
  private running = false;
  /** If set, every outbound frame is also pushed to this array (for assertions). */
  readonly sent: Uint8Array[] = [];

  async start(onFrame: (axBytes: Uint8Array) => void): Promise<void> {
    this.listener = onFrame;
    this.running = true;
  }

  async send(axBytes: Uint8Array): Promise<void> {
    if (!this.running) throw new Error("transport stopped");
    // Copy bytes to avoid aliasing.
    const copy = new Uint8Array(axBytes);
    this.sent.push(copy);
    const peer = this.peer;
    if (peer && peer.running && peer.listener) {
      const target = peer.listener;
      queueMicrotask(() => target(copy));
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.listener = null;
  }

  /** @internal — called by pair(). */
  _setPeer(peer: MockTransport): void {
    this.peer = peer;
  }
}

/**
 * Construct a connected pair of {@link MockTransport}s — bytes sent on
 * `a` arrive on `b` and vice versa.
 */
export function pair(): { a: MockTransport; b: MockTransport } {
  const a = new MockTransport();
  const b = new MockTransport();
  a._setPeer(b);
  b._setPeer(a);
  return { a, b };
}
