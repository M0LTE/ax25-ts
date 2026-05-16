/**
 * Mock-transport example — unit-testing your code that consumes
 * `@packet-net/ax25` without dialling a real radio.
 *
 * The pattern: spin up a paired in-memory transport — bytes sent on
 * side A arrive as `onFrame` callbacks on side B and vice versa. Wire
 * the `Ax25Stack` (your system-under-test) to side A; drive a hand-
 * scripted peer on side B that replies UA to a SABM, sends an I-frame
 * banner, etc.
 *
 * MockTransport is NOT exported from the published package — the
 * library doesn't ship it. Copy `web/ax25/tests/mock-transport.ts`
 * into your own test tree (or vendor it) when you want to wire this
 * pattern into your own project.
 *
 * This example assumes you've copied (or aliased) `mock-transport.ts`
 * into a sibling location.
 */
import { Callsign } from "../src/callsign.js";
import {
  classify,
  decodeFrame,
  encodeFrame,
  pollFinal,
  ua,
  iFrame,
} from "../src/frame.js";
import { Ax25Stack } from "../src/session.js";
import { MockTransport, pair } from "../tests/mock-transport.js";

async function main(): Promise<void> {
  // 1. Paired in-memory transport. `a` will back the SUT's Ax25Stack;
  //    `b` is the scripted peer.
  const { a, b } = pair();
  const stack = new Ax25Stack(a);
  await stack.start();

  // 2. Wire a hand-rolled peer on side `b`. We accumulate decoded
  //    inbound frames so we can drive the right replies.
  const inboundOnPeer: Array<ReturnType<typeof decodeFrame>> = [];
  await b.start((bytes) => {
    inboundOnPeer.push(decodeFrame(bytes));
  });

  // 3. Kick off the connect — this fires SABM out of `a` and waits for UA.
  const local = Callsign.parse("M0LTE-2");
  const remote = Callsign.parse("G7XYZ-1");
  const connectPromise = stack.connect({ from: local, to: remote });

  // 4. Let the microtask queue flush so the SABM arrives at the peer.
  await flush();

  // 5. Assert the peer saw a SABM and reply UA.
  if (classify(inboundOnPeer[0]!) !== "SABM") {
    throw new Error("expected SABM");
  }
  const peerSend = (frame: typeof inboundOnPeer[number]) =>
    b.send(encodeFrame(frame));
  await peerSend(
    ua({
      destination: local,
      source: remote,
      finalBit: pollFinal(inboundOnPeer[0]!),
    }),
  );

  // 6. The connect promise resolves once UA lands.
  const session = await connectPromise;
  console.log("connected:", session.from.toString(), "→", session.to.toString());

  // 7. Wire a data listener and have the peer push a synthetic I-frame.
  const receivedFromPeer: Uint8Array[] = [];
  session.onData((chunk) => receivedFromPeer.push(chunk));

  await peerSend(
    iFrame({
      destination: local,
      source: remote,
      ns: 0,
      nr: 0,
      pollBit: false,
      pid: 0xf0,
      info: new TextEncoder().encode("welcome to the mock peer\r"),
    }),
  );
  await flush();

  console.log("received from peer:", new TextDecoder().decode(receivedFromPeer[0]!));

  // 8. Clean up — disconnect closes the session and removes it from the
  //    stack's session map. stop() releases the transport.
  await session.disconnect();
  await stack.stop();
}

// Two flushes is usually enough — MockTransport delivers via
// `queueMicrotask`, so awaiting a single `setTimeout(0)` macrotask
// gives the microtask queue a chance to drain.
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

void main;
// Silence unused-import warnings — these are part of the example's
// teaching surface even when not referenced in the linear narrative
// above.
void MockTransport;
