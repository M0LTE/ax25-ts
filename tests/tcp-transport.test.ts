import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { FEND, KISS_CMD, encodeKiss } from "../src/kiss.js";
import { TcpKissTransport } from "../src/tcp-transport.js";

/**
 * Minimal Node `net.Socket`-shaped fake. Records writes, lets tests push
 * inbound bytes via `simulateData`, and emits the lifecycle events the
 * transport listens for. Mirrors the paired-pipe trick the C# interop
 * tests use to exercise the KISS bridge without a real socket.
 *
 * The transport casts the socket factory's return as `Socket`; what
 * matters at runtime is duck-typed shape: `on/once/off`, `write`,
 * `end`, `destroy`, plus the `destroyed` flag for stop()-idempotency.
 */
class MockSocket extends EventEmitter {
  readonly writes: Uint8Array[] = [];
  destroyed = false;
  endCalled = false;
  destroyCalled = false;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  write(data: Uint8Array | string, callback?: (err?: Error) => void): boolean {
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    this.writes.push(bytes);
    queueMicrotask(() => callback?.());
    return true;
  }

  end(callback?: () => void): this {
    this.endCalled = true;
    queueMicrotask(() => {
      callback?.();
      // Real sockets emit `close` after the FIN exchange completes —
      // we simulate that immediately so the transport's stop() doesn't
      // burn 200ms per test waiting for the destroy() grace timer.
      this.destroyed = true;
      this.emit("close");
    });
    return this;
  }

  destroy(): this {
    this.destroyCalled = true;
    this.destroyed = true;
    queueMicrotask(() => this.emit("close"));
    return this;
  }

  /** Test-side helper: push received bytes into the transport. */
  simulateData(bytes: Uint8Array): void {
    this.emit("data", bytes);
  }

  /** Test-side helper: complete the connect handshake. */
  simulateConnect(): void {
    this.emit("connect");
  }

  /** Test-side helper: fail the connect handshake. */
  simulateError(err: Error): void {
    this.emit("error", err);
  }
}

/**
 * Boilerplate for "transport that's already started against a freshly
 * connected MockSocket." Every test except the connect-error / timeout
 * ones uses this.
 */
async function startedTransport(opts?: {
  kissPort?: number;
  receivedFrames?: Uint8Array[];
}): Promise<{ transport: TcpKissTransport; socket: MockSocket }> {
  const socket = new MockSocket();
  const transport = new TcpKissTransport("127.0.0.1", 65535, {
    kissPort: opts?.kissPort,
    // Bypass `net.createConnection` — return our mock and let the test
    // drive the lifecycle by hand. The transport casts to `Socket`.
    socketFactory: () => socket as unknown as import("node:net").Socket,
  });
  const startPromise = transport.start((bytes) => {
    opts?.receivedFrames?.push(new Uint8Array(bytes));
  });
  // Let `start` attach its listeners before we emit connect.
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  socket.simulateConnect();
  await startPromise;
  return { transport, socket };
}

describe("TcpKissTransport.start", () => {
  it("resolves once the socket emits `connect`", async () => {
    const { transport, socket } = await startedTransport();
    expect(socket.listenerCount("data")).toBe(1);
    await transport.stop();
  });

  it("rejects when the socket emits `error` before connect", async () => {
    const socket = new MockSocket();
    const transport = new TcpKissTransport("127.0.0.1", 1, {
      socketFactory: () => socket as unknown as import("node:net").Socket,
    });
    const startPromise = transport.start(() => {});
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    socket.simulateError(new Error("ECONNREFUSED"));
    await expect(startPromise).rejects.toThrow(/ECONNREFUSED/);
    expect(socket.destroyCalled).toBe(true);
  });

  it("rejects with a timeout error when connect doesn't complete in budget", async () => {
    vi.useFakeTimers();
    try {
      const socket = new MockSocket();
      const transport = new TcpKissTransport("127.0.0.1", 1, {
        connectTimeoutMs: 250,
        socketFactory: () => socket as unknown as import("node:net").Socket,
      });
      const startPromise = transport.start(() => {});
      // Advance past the timeout without ever emitting connect.
      vi.advanceTimersByTime(300);
      await expect(startPromise).rejects.toThrow(/timed out after 250ms/);
      expect(socket.destroyCalled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TcpKissTransport.send", () => {
  it("KISS-encodes the AX.25 payload and writes it to the socket", async () => {
    const { transport, socket } = await startedTransport();
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    await transport.send(payload);

    expect(socket.writes.length).toBe(1);
    const wire = socket.writes[0]!;
    expect(wire[0]).toBe(FEND);
    expect(wire[wire.length - 1]).toBe(FEND);
    // cmd byte for port=0, Data=0 → 0x00; then the payload (no FEND/FESC
    // collisions in this fixture) → de ad be ef; then FEND.
    expect(Array.from(wire.slice(1, -1))).toEqual([0x00, 0xde, 0xad, 0xbe, 0xef]);

    await transport.stop();
  });

  it("honours a non-zero KISS port number", async () => {
    const { transport, socket } = await startedTransport({ kissPort: 3 });
    await transport.send(new Uint8Array([0x01]));
    // cmd byte = (3 << 4) | Data(0) = 0x30
    expect(socket.writes[0]![1]).toBe(0x30);
    await transport.stop();
  });

  it("throws when send is called before start", async () => {
    const transport = new TcpKissTransport("127.0.0.1", 1);
    await expect(transport.send(new Uint8Array([1]))).rejects.toThrow(/not started/);
  });
});

describe("TcpKissTransport — inbound bytes", () => {
  it("decodes a KISS frame and bubbles the AX.25 bytes to `onFrame`", async () => {
    const received: Uint8Array[] = [];
    const { transport, socket } = await startedTransport({ receivedFrames: received });

    const ax = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const wire = encodeKiss(0, KISS_CMD.Data, ax);
    socket.simulateData(wire);

    expect(received.length).toBe(1);
    expect(Array.from(received[0]!)).toEqual([0xaa, 0xbb, 0xcc]);
    await transport.stop();
  });

  it("re-assembles a KISS frame split across multiple `data` events", async () => {
    const received: Uint8Array[] = [];
    const { transport, socket } = await startedTransport({ receivedFrames: received });

    const ax = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
    const wire = encodeKiss(0, KISS_CMD.Data, ax);
    // Push the frame as three chunks. The decoder is stateful so this
    // should still yield exactly one payload.
    socket.simulateData(wire.slice(0, 2));
    socket.simulateData(wire.slice(2, 4));
    socket.simulateData(wire.slice(4));

    expect(received.length).toBe(1);
    expect(Array.from(received[0]!)).toEqual([0x11, 0x22, 0x33, 0x44]);
    await transport.stop();
  });

  it("drops frames on a different KISS port", async () => {
    const received: Uint8Array[] = [];
    const { transport, socket } = await startedTransport({
      kissPort: 0,
      receivedFrames: received,
    });
    // Inbound frame on port=4 — transport is bound to port=0, so drop.
    const wire = encodeKiss(4, KISS_CMD.Data, new Uint8Array([0xff]));
    socket.simulateData(wire);
    expect(received.length).toBe(0);
    await transport.stop();
  });

  it("drops non-Data KISS commands (TXDELAY, SetHardware, etc.)", async () => {
    const received: Uint8Array[] = [];
    const { transport, socket } = await startedTransport({ receivedFrames: received });
    const wire = encodeKiss(0, KISS_CMD.TxDelay, new Uint8Array([100]));
    socket.simulateData(wire);
    expect(received.length).toBe(0);
    await transport.stop();
  });
});

describe("TcpKissTransport.stop", () => {
  it("calls `end` on the socket and resolves cleanly", async () => {
    const { transport, socket } = await startedTransport();
    await transport.stop();
    expect(socket.endCalled).toBe(true);
  });

  it("is idempotent — second stop is a no-op", async () => {
    const { transport } = await startedTransport();
    await transport.stop();
    await transport.stop(); // should not throw or hang
  });
});

