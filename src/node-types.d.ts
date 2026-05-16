/**
 * Minimal ambient declarations for the Node-only modules `node:net` and
 * `node:events`. Used by {@link ./tcp-transport.ts}.
 *
 * We deliberately do NOT depend on `@types/node` — the library is
 * browser-targeted and pulling in the full Node DOM-collision-prone
 * declarations would muddy the rest of the codebase. The shim covers
 * only the slice of the API the TCP transport actually touches; the
 * trade-off is that `tcp-transport.ts` can't reach for other Node
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
