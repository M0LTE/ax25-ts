/**
 * Node.js example — same connect-write-read-disconnect shape as
 * `quick-start.ts`, but the transport is `TcpKissTransport` dialling a
 * remote KISS-over-TCP listener.
 *
 * The defaults (`127.0.0.1:8100`) match the `a` node of our local
 * net-sim from `docker/compose.interop.yml`. Bring the stack up with:
 *
 *     docker compose -f docker/compose.interop.yml up -d --wait
 *
 * Then run this example with `tsx examples/node-tcp.ts` after building
 * the library (`npm run build`).
 *
 * Imports go via the subpath:
 *     `@packet-net/ax25/tcp-transport`
 *
 * The main `@packet-net/ax25` entry stays browser-clean — no
 * `node:net` imports — so a bundler targeting the browser won't pull in
 * any Node-specific code unless you deep-import this subpath.
 */
import { Ax25Stack, Callsign } from "../src/index.js";
import { TcpKissTransport } from "../src/tcp-transport.js";

async function main(): Promise<void> {
  const transport = new TcpKissTransport("127.0.0.1", 8100, {
    kissPort: 0,
    connectTimeoutMs: 5000,
  });
  const stack = new Ax25Stack(transport);
  await stack.start();

  let session;
  try {
    session = await stack.connect({
      from: Callsign.parse("M0LTE-2"),
      to: Callsign.parse("GB7CIP"),
    });
  } catch (err) {
    console.error("connect failed:", err);
    await stack.stop();
    return;
  }

  session.onData((chunk) => {
    // Node's `console.log` is line-buffered; for a more terminal-y
    // experience use `process.stdout.write` (requires @types/node).
    console.log(new TextDecoder().decode(chunk));
  });
  session.onDisconnected(() => {
    console.log("\n[link closed]");
  });

  // Send a single line. The library queues bytes and emits the I-frame
  // once it's in Connected state (which it is by the time `connect`
  // resolved).
  await session.write(new TextEncoder().encode("?\r"));

  // Give the peer a few seconds to respond before tearing the link
  // down — production callers would drive disconnect off a user
  // gesture or a higher-level protocol state, not a sleep.
  await new Promise((resolve) => setTimeout(resolve, 5000));

  await session.disconnect();
  await stack.stop();
}

void main;
