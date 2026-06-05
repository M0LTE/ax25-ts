import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { Callsign } from "../src/callsign.js";
import { AxudpTransport } from "../src/axudp-transport.js";
import { appendFcs, computeFcs } from "../src/fcs.js";
import { encodeFrame, ui } from "../src/frame.js";

/**
 * Minimal Node `dgram.Socket`-shaped fake. Records sends, lets tests push
 * inbound datagrams via `simulateMessage`, and emits the lifecycle events the
 * transport listens for (`listening`, `error`). Mirrors the `MockSocket`
 * trick the TCP transport's unit tests use — exercise the send/receive/FCS
 * paths without binding a real UDP socket.
 *
 * The transport casts the factory's return as `dgram.Socket`; what matters at
 * runtime is the duck-typed shape: `on/once/off`, `bind`, `send`, `address`,
 * `close`.
 */
class MockUdpSocket extends EventEmitter {
  readonly sends: Array<{ datagram: Uint8Array; port: number; address: string }> = [];
  closed = false;
  private boundPort = 41000;

  bind(port?: number, _address?: string, callback?: () => void): this {
    // Mirror dgram: bind(0) picks an ephemeral port; a non-zero port is used
    // as-is. Emit `listening` asynchronously like the real socket.
    if (port && port !== 0) this.boundPort = port;
    queueMicrotask(() => {
      callback?.();
      this.emit("listening");
    });
    return this;
  }

  send(
    msg: Uint8Array,
    port: number,
    address: string,
    callback?: (error: Error | null, bytes?: number) => void,
  ): void {
    this.sends.push({ datagram: new Uint8Array(msg), port, address });
    queueMicrotask(() => callback?.(null, msg.length));
  }

  address(): { address: string; family: string; port: number } {
    return { address: "0.0.0.0", family: "IPv4", port: this.boundPort };
  }

  close(callback?: () => void): this {
    this.closed = true;
    queueMicrotask(() => callback?.());
    return this;
  }

  /** Test-side helper: push an inbound datagram into the transport. */
  simulateMessage(datagram: Uint8Array): void {
    this.emit("message", datagram, {
      address: "127.0.0.1",
      family: "IPv4",
      port: 9999,
      size: datagram.length,
    });
  }

  /** Test-side helper: fail the bind. */
  simulateError(err: Error): void {
    this.emit("error", err);
  }
}

/** A started transport over a freshly-bound MockUdpSocket. */
async function startedTransport(opts?: {
  localPort?: number;
  receivedFrames?: Uint8Array[];
}): Promise<{ transport: AxudpTransport; socket: MockUdpSocket }> {
  const socket = new MockUdpSocket();
  const transport = new AxudpTransport("127.0.0.1", 8093, {
    localPort: opts?.localPort,
    socketFactory: () => socket as unknown as import("node:dgram").Socket,
  });
  await transport.start((bytes) => {
    opts?.receivedFrames?.push(new Uint8Array(bytes));
  });
  return { transport, socket };
}

const sampleBody = (): Uint8Array =>
  encodeFrame(
    ui({
      destination: Callsign.parse("APRS"),
      source: Callsign.parse("G7XYZ-7"),
      info: new TextEncoder().encode("x"),
    }),
  );

describe("AxudpTransport.start", () => {
  it("resolves once the socket emits `listening` and reports the bound port", async () => {
    const { transport, socket } = await startedTransport({ localPort: 8190 });
    expect(socket.listenerCount("message")).toBe(1);
    expect(transport.boundLocalPort).toBe(8190);
    await transport.stop();
  });

  it("rejects when the socket emits `error` before binding", async () => {
    const socket = new MockUdpSocket();
    // Override bind so it never emits `listening`; the test drives `error`.
    socket.bind = function (this: MockUdpSocket): MockUdpSocket {
      return this;
    } as MockUdpSocket["bind"];
    const transport = new AxudpTransport("127.0.0.1", 8093, {
      socketFactory: () => socket as unknown as import("node:dgram").Socket,
    });
    const startPromise = transport.start(() => {});
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    socket.simulateError(new Error("EADDRINUSE"));
    await expect(startPromise).rejects.toThrow(/EADDRINUSE/);
    expect(socket.closed).toBe(true);
  });
});

describe("AxudpTransport.send", () => {
  it("appends the 2-octet FCS and sends one datagram to the configured remote", async () => {
    const { transport, socket } = await startedTransport();
    const body = sampleBody();
    await transport.send(body);

    expect(socket.sends.length).toBe(1);
    const sent = socket.sends[0]!;
    expect(sent.address).toBe("127.0.0.1");
    expect(sent.port).toBe(8093);
    // Datagram = body || FCS(body), low byte first — the BPQAXIP wire form.
    expect(sent.datagram.length).toBe(body.length + 2);
    expect(Array.from(sent.datagram.subarray(0, body.length))).toEqual(Array.from(body));
    const fcs = computeFcs(body);
    expect(sent.datagram[body.length]).toBe(fcs & 0xff);
    expect(sent.datagram[body.length + 1]).toBe((fcs >> 8) & 0xff);

    await transport.stop();
  });

  it("throws when send is called before start", async () => {
    const transport = new AxudpTransport("127.0.0.1", 8093);
    await expect(transport.send(new Uint8Array([1]))).rejects.toThrow(/not started/);
  });
});

describe("AxudpTransport — inbound datagrams", () => {
  it("strips + validates the FCS and bubbles the bare AX.25 body to `onFrame`", async () => {
    const received: Uint8Array[] = [];
    const { transport, socket } = await startedTransport({ receivedFrames: received });

    const body = sampleBody();
    socket.simulateMessage(appendFcs(body));

    expect(received.length).toBe(1);
    expect(Array.from(received[0]!)).toEqual(Array.from(body));
    await transport.stop();
  });

  it("drops a bad-FCS datagram (does not surface it), then delivers the next good one", async () => {
    const received: Uint8Array[] = [];
    const { transport, socket } = await startedTransport({ receivedFrames: received });

    // Corrupt-FCS datagram first — must be dropped, not surfaced (and must not
    // wedge the receive path).
    const corrupt = appendFcs(sampleBody());
    corrupt[corrupt.length - 1] ^= 0xff;
    socket.simulateMessage(corrupt);
    expect(received.length).toBe(0);

    // A good datagram afterwards is delivered, FCS stripped.
    const good = sampleBody();
    socket.simulateMessage(appendFcs(good));
    expect(received.length).toBe(1);
    expect(Array.from(received[0]!)).toEqual(Array.from(good));

    await transport.stop();
  });

  it("drops a datagram too short to carry a frame + FCS", async () => {
    const received: Uint8Array[] = [];
    const { transport, socket } = await startedTransport({ receivedFrames: received });
    socket.simulateMessage(new Uint8Array([0x01, 0x02, 0x03]));
    expect(received.length).toBe(0);
    await transport.stop();
  });
});

describe("AxudpTransport.stop", () => {
  it("closes the socket and resolves", async () => {
    const { transport, socket } = await startedTransport();
    await transport.stop();
    expect(socket.closed).toBe(true);
  });

  it("is idempotent — second stop is a no-op", async () => {
    const { transport } = await startedTransport();
    await transport.stop();
    await transport.stop(); // must not throw or hang
  });
});
