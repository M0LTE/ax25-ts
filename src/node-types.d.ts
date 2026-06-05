/**
 * Minimal ambient declarations for the Node-only modules `node:net`,
 * `node:dgram` and `node:events`. Used by {@link ./tcp-transport.ts} and
 * {@link ./axudp-transport.ts}.
 *
 * We deliberately do NOT depend on `@types/node` — the library is
 * browser-targeted and pulling in the full Node DOM-collision-prone
 * declarations would muddy the rest of the codebase. The shim covers
 * only the slice of the API the Node transports actually touch; the
 * trade-off is that those transports can't reach for other Node
 * features without expanding this file first.
 *
 * If/when the library gains a true Node-side surface (server, AGW
 * listener, …) it'll be cheaper to flip on `@types/node` properly than
 * to keep stretching this shim. For now the shim is the seam.
 */

declare module "node:events" {
  export class EventEmitter {
    on(event: string, listener: (...args: unknown[]) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
    off(event: string, listener: (...args: unknown[]) => void): this;
    removeListener(event: string, listener: (...args: unknown[]) => void): this;
    removeAllListeners(event?: string): this;
    emit(event: string, ...args: unknown[]): boolean;
  }
}

declare module "node:net" {
  import { EventEmitter } from "node:events";

  export class Socket extends EventEmitter {
    write(data: Uint8Array | string, callback?: (err?: Error) => void): boolean;
    end(callback?: () => void): this;
    destroy(error?: Error): this;
    setNoDelay(noDelay?: boolean): this;
    setTimeout(timeout: number, callback?: () => void): this;
    connect(port: number, host: string, connectListener?: () => void): this;
    readonly destroyed: boolean;
    readonly readyState: string;
  }

  export interface NetConnectOpts {
    host?: string;
    port?: number;
    timeout?: number;
  }

  export function createConnection(
    options: NetConnectOpts,
    connectionListener?: () => void,
  ): Socket;
  export function createConnection(
    port: number,
    host?: string,
    connectionListener?: () => void,
  ): Socket;
}

declare module "node:dgram" {
  import { EventEmitter } from "node:events";

  /** The sender metadata Node attaches to each inbound datagram. */
  export interface RemoteInfo {
    address: string;
    family: string;
    port: number;
    size: number;
  }

  /** The local address a bound socket reports. */
  export interface AddressInfo {
    address: string;
    family: string;
    port: number;
  }

  // `message` carries a Node Buffer, which is a `Uint8Array` subclass — we
  // type it as `Uint8Array` so the shim needn't declare the `Buffer` global.
  export class Socket extends EventEmitter {
    // Node overloads bind() heavily; the two shapes this codebase uses are
    // bind(port, address) (the transport) and bind(port, callback) (the
    // reachability probe in the integration test).
    bind(port: number, callback?: () => void): this;
    bind(port?: number, address?: string, callback?: () => void): this;
    send(
      msg: Uint8Array,
      port: number,
      address: string,
      callback?: (error: Error | null, bytes?: number) => void,
    ): void;
    address(): AddressInfo;
    close(callback?: () => void): this;
  }

  export function createSocket(type: "udp4" | "udp6"): Socket;
}
