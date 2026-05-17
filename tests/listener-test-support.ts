/**
 * Test helpers for `Ax25Listener` unit tests. The {@link LoopbackTransport}
 * is the TS equivalent of the C# `LoopbackModem` — in-memory transport
 * with explicit inbound-injection + an observable list of outbound
 * frames.
 *
 * Kept in `tests/` (not `src/`) so consumers don't accidentally pull it
 * into production builds. New listener tests should import from this file
 * rather than re-rolling fixtures.
 */
import {
  type Ax25Frame,
  decodeFrame,
  encodeFrame,
} from "../src/frame.js";
import type { Ax25Transport } from "../src/transport.js";

/**
 * Block until `condition` returns `true`, polling every 20 ms. Throws
 * if the budget elapses. Mirrors `ListenerTestSupport.WaitFor` from C#.
 */
export async function waitFor(
  condition: () => boolean,
  budgetMs: number,
  reason?: string,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `condition did not become true within ${budgetMs}ms${reason ? ` — ${reason}` : ""}`,
  );
}

/**
 * Tiny observable list — append + wait-for-count helper. Used by the
 * loopback transport's `sentFrames` so tests can block deterministically
 * on the outbound queue without polling sleeps littered through
 * assertions.
 */
export class ObservableList<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<{
    target: number;
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  push(item: T): void {
    this.items.push(item);
    // Settle any waiters whose target has been reached.
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]!;
      if (this.items.length >= w.target) {
        clearTimeout(w.timer);
        this.waiters.splice(i, 1);
        w.resolve();
      }
    }
  }

  get count(): number {
    return this.items.length;
  }

  get(i: number): T {
    return this.items[i]!;
  }

  snapshot(): T[] {
    return this.items.slice();
  }

  async waitForCount(target: number, budgetMs: number): Promise<void> {
    if (this.items.length >= target) return;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(
          new Error(
            `only ${this.items.length}/${target} items after ${budgetMs}ms`,
          ),
        );
      }, budgetMs);
      this.waiters.push({ target, resolve, reject, timer });
    });
  }
}

/**
 * In-memory transport with explicit inbound injection. Mirrors the C#
 * `LoopbackModem` — what the listener calls `send` on appends to
 * `sentFrames`; what tests call `injectInbound` on shows up at the
 * listener's `onFrame` callback as decoded AX.25 bytes.
 */
export class LoopbackTransport implements Ax25Transport {
  private onFrame: ((bytes: Uint8Array) => void) | null = null;
  private startedFlag = false;
  /** Outbound AX.25 frames the listener has sent. */
  readonly sentFrames = new ObservableList<Uint8Array>();
  /** If true, outbound frames are counted but not appended to sentFrames. */
  dropOutbound = false;
  private outboundCountField = 0;

  async start(onFrame: (bytes: Uint8Array) => void): Promise<void> {
    this.onFrame = onFrame;
    this.startedFlag = true;
  }

  async send(bytes: Uint8Array): Promise<void> {
    this.outboundCountField++;
    if (this.dropOutbound) return;
    this.sentFrames.push(new Uint8Array(bytes));
  }

  async stop(): Promise<void> {
    this.startedFlag = false;
    this.onFrame = null;
  }

  /** Total send attempts regardless of `dropOutbound`. */
  get outboundCount(): number {
    return this.outboundCountField;
  }

  /** Inject a frame as if it had been received from the wire. */
  injectInbound(frame: Ax25Frame): void {
    if (!this.startedFlag || !this.onFrame) {
      throw new Error("transport not started");
    }
    const bytes = encodeFrame(frame);
    // Deliver synchronously — tests want deterministic ordering.
    this.onFrame(bytes);
  }

  /** Inject already-encoded AX.25 bytes (e.g. for malformed-frame tests). */
  injectInboundBytes(bytes: Uint8Array): void {
    if (!this.startedFlag || !this.onFrame) {
      throw new Error("transport not started");
    }
    this.onFrame(bytes);
  }

  /** Decode the n'th sent frame for assertions. */
  decodedSent(i: number): Ax25Frame {
    return decodeFrame(this.sentFrames.get(i));
  }
}

/** Add a budget to a promise — reject with TimeoutError if budget elapses. */
export async function withTimeout<T>(
  p: Promise<T>,
  budgetMs: number,
  label?: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label ?? "promise"} did not complete within ${budgetMs}ms`,
          ),
        ),
      budgetMs,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
