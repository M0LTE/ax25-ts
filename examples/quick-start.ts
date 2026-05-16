/**
 * Quick-start example — connect to a remote callsign via a USB KISS modem
 * in a Chromium browser (Web Serial).
 *
 * What this shows:
 *   1. Acquiring a `SerialPort` via the Web Serial API.
 *   2. Building a `WebSerialKissTransport` from it.
 *   3. Constructing an `Ax25Stack` and starting it.
 *   4. Calling `stack.connect(...)` — resolves once SABM/UA completes.
 *   5. Registering `onData` / `onDisconnected` callbacks.
 *   6. Writing outbound bytes.
 *   7. Tearing the link down cleanly.
 *
 * Run target: NOT executable in Node (no `navigator.serial`). It compiles
 * and typechecks against the public API surface; it's intended to be
 * inlined into a real browser app under a button click handler.
 */
import {
  Ax25Stack,
  Callsign,
  WebSerialKissTransport,
  type WebSerialLikePort,
} from "../src/index.js";

declare const navigator: {
  serial: {
    requestPort(options?: object): Promise<WebSerialLikePort>;
  };
};

async function main(): Promise<void> {
  // Web Serial requires a user gesture — call this from a button onclick:
  const port = await navigator.serial.requestPort();

  const transport = new WebSerialKissTransport(port, { baudRate: 9600 });
  const stack = new Ax25Stack(transport);
  await stack.start();

  const session = await stack.connect({
    from: Callsign.parse("M0LTE-2"),
    to: "GB7CIP",
  });

  session.onData((chunk) => {
    console.log(new TextDecoder().decode(chunk));
  });
  session.onDisconnected(() => {
    console.log("link closed");
  });

  await session.write(new TextEncoder().encode("hello\r"));

  // Later, when the user clicks "disconnect":
  await session.disconnect();
  await stack.stop();
}

// `void main` keeps tsc happy without forcing top-level await in this file.
void main;
