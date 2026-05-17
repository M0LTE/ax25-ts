/**
 * Inbound-listener example — `Ax25Listener` accepts incoming SABMs via a
 * paired in-memory transport. Models the same shape as
 * `with-mock-transport.ts` but in reverse: the system-under-test (SUT)
 * is the LISTENER, and the scripted peer is the one that dials in.
 *
 * Pattern:
 *   1. Paired in-memory transports — bytes sent on side A arrive on B
 *      and vice versa.
 *   2. Wire `Ax25Listener` to side A.
 *   3. Drive a hand-rolled peer on side B that sends SABM and reacts to
 *      the listener's UA.
 *   4. Observe `sessionAccepted` on the listener; round-trip an I-frame.
 *
 * Run with `tsx examples/inbound-listener.ts` after `npm install`.
 */
import { Callsign } from "../src/callsign.js";
import {
  classify,
  decodeFrame,
  encodeFrame,
  iFrame,
  pollFinal,
  sabm,
  ua,
  type Ax25Frame,
} from "../src/frame.js";
import { Ax25Listener } from "../src/listener.js";
import { MockTransport, pair } from "../tests/mock-transport.js";

async function main(): Promise<void> {
  // 1. Paired transports. `a` backs the listener (SUT); `b` is the
  //    scripted peer dialling in.
  const { a, b } = pair();

  const listenerCall = Callsign.parse("M0LTE-1");
  const peerCall = Callsign.parse("G7XYZ-2");

  const listener = new Ax25Listener(a, { myCall: listenerCall });

  // 2. Subscribe to listener events.
  listener.onSessionAccepted((session) => {
    console.log(
      "[listener] sessionAccepted from",
      session.context.remote.toString(),
    );

    // Send a welcome I-frame once the session is Connected. The SDL
    // accepts DL_DATA_request events on a Connected session; the
    // dispatcher's I_command verb emits the I-frame onto the wire.
    session.postEvent({
      name: "DL_DATA_request",
      data: new TextEncoder().encode("welcome to the listener\r"),
      pid: 0xf0,
    });

    // Surface inbound I-frames + disconnects so we can see what the
    // peer sends us.
    session.onDataLinkSignal((sig) => {
      if (sig.type === "DL_DATA_indication") {
        console.log(
          "[listener] inbound I-frame:",
          new TextDecoder().decode(sig.data),
        );
      }
      if (
        sig.type === "DL_DISCONNECT_indication" ||
        sig.type === "DL_DISCONNECT_confirm"
      ) {
        console.log("[listener] session disconnected");
      }
    });
  });

  listener.onFrameTraced((e) => {
    console.log(
      `[listener] ${e.direction.toUpperCase()} ${classify(e.frame)} from ${e.frame.source.callsign.toString()} → ${e.frame.destination.callsign.toString()}`,
    );
  });

  await listener.start();
  console.log("[listener] started, myCall =", listener.myCall.toString());

  // 3. Hand-rolled peer on side `b`. Accumulate decoded inbound frames so
  //    we can drive the right replies.
  const inboundOnPeer: Ax25Frame[] = [];
  await b.start((bytes) => {
    inboundOnPeer.push(decodeFrame(bytes));
  });

  // 4. Send SABM to dial into the listener.
  console.log("[peer] sending SABM");
  await b.send(encodeFrame(sabm({ destination: listenerCall, source: peerCall })));

  // 5. Wait for the UA the listener should emit. We block on the peer's
  //    inbound queue rather than racing on a microtask flush.
  await waitFor(() => inboundOnPeer.some((f) => classify(f) === "UA"), 1000);
  const uaFrame = inboundOnPeer.find((f) => classify(f) === "UA")!;
  console.log("[peer] received UA (P/F =", pollFinal(uaFrame), ")");

  // 6. Wait for the listener's welcome I-frame to land.
  await waitFor(() => inboundOnPeer.some((f) => classify(f) === "I"), 1000);
  const welcome = inboundOnPeer.find((f) => classify(f) === "I")!;
  console.log("[peer] received I-frame:", new TextDecoder().decode(welcome.info));

  // 7. Peer replies with its own I-frame to round-trip.
  console.log("[peer] sending I-frame reply");
  await b.send(
    encodeFrame(
      iFrame({
        destination: listenerCall,
        source: peerCall,
        nr: 1, // ack the welcome (N(S)=0 → next expected N(R)=1)
        ns: 0, // first I-frame from peer
        info: new TextEncoder().encode("ack from peer\r"),
        pid: 0xf0,
      }),
    ),
  );

  // Brief settle so the listener's processing of the peer's I-frame
  // emits its trace + DL_DATA_indication.
  await new Promise((resolve) => setTimeout(resolve, 100));

  // 8. Clean teardown. In a real node, you'd respond to a peer-initiated
  //    DISC; here we drive UA-then-disconnect via the listener directly.
  console.log("[demo] tearing down listener");
  await listener.dispose();
}

async function waitFor(
  condition: () => boolean,
  budgetMs: number,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`condition not met within ${budgetMs}ms`);
}

main().catch((err) => {
  console.error("example failed:", err);
});
// Silence unused-import warnings — these are part of the example's
// teaching surface even when not referenced directly above.
void MockTransport;
void ua;
