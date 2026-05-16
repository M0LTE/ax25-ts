import { KISS_CMD, KissDecoder, encodeKiss } from "./kiss.js";
import type { Ax25Transport } from "./transport.js";

/**
 * Minimal duck-typed shape of a Web Serial port — keeps tests passing
 * under Node where `SerialPort` isn't a global. In a browser, pass an
 * actual `SerialPort` obtained from `navigator.serial.requestPort()`.
 */
export interface WebSerialLikePort {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

export interface WebSerialKissTransportOptions {
  /** Serial baud rate. Default 9600 (typical for KISS modems). */
  baudRate?: number;
  /** Multi-drop KISS port number (0-15). Default 0. */
  kissPort?: number;
}

/**
 * KISS-over-Web-Serial transport. Wraps a `SerialPort` (or any
 * stream-pair object with the same shape) and exposes a `start / send /
 * stop` interface that surfaces AX.25 frame bytes to higher layers.
 *
 * The transport opens the port on `start`, attaches reader+writer streams,
 * runs a read loop on a background task, and closes everything on `stop`.
 */
export class WebSerialKissTransport implements Ax25Transport {
  private readonly port: WebSerialLikePort;
  private readonly baudRate: number;
  private readonly kissPort: number;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readonly decoder = new KissDecoder();
  private onFrame: ((bytes: Uint8Array) => void) | null = null;
  private readLoopPromise: Promise<void> | null = null;
  private running = false;

  constructor(port: WebSerialLikePort, opts: WebSerialKissTransportOptions = {}) {
    this.port = port;
    this.baudRate = opts.baudRate ?? 9600;
    this.kissPort = opts.kissPort ?? 0;
  }

  async start(onFrame: (axBytes: Uint8Array) => void): Promise<void> {
    this.onFrame = onFrame;
    if (this.running) return;
    await this.port.open({ baudRate: this.baudRate });
    if (!this.port.readable || !this.port.writable) {
      throw new Error("serial port opened with no readable/writable streams");
    }
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.running = true;
    this.readLoopPromise = this.runReadLoop();
  }

  async send(axBytes: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error("transport not started");
    const framed = encodeKiss(this.kissPort, KISS_CMD.Data, axBytes);
    await this.writer.write(framed);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch {
        // best-effort
      }
      try {
        this.reader.releaseLock();
      } catch {
        // best-effort
      }
      this.reader = null;
    }
    if (this.writer) {
      try {
        await this.writer.close();
      } catch {
        // best-effort — some implementations throw if peer hung up.
      }
      try {
        this.writer.releaseLock();
      } catch {
        // best-effort
      }
      this.writer = null;
    }
    if (this.readLoopPromise) {
      try {
        await this.readLoopPromise;
      } catch {
        // already logged in loop
      }
      this.readLoopPromise = null;
    }
    try {
      await this.port.close();
    } catch {
      // best-effort
    }
  }

  private async runReadLoop(): Promise<void> {
    if (!this.reader) return;
    try {
      while (this.running) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        const frames = this.decoder.push(value);
        for (const f of frames) {
          // We only surface Data frames with the matching port number.
          // Other KISS commands (TXDELAY echo, etc.) are silently dropped.
          if (f.command !== KISS_CMD.Data) continue;
          if (f.port !== this.kissPort) continue;
          if (this.onFrame) this.onFrame(f.payload);
        }
      }
    } catch {
      // Stream errored or was cancelled — just exit the loop.
    }
  }
}
