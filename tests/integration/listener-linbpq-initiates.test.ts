/**
 * Listener-side interop against LinBPQ — we listen on net-sim node `a`
 * (KISS-TCP 8100) under callsign `TSTEST`; BPQ initiates an outbound
 * `C 3 TSTEST` via its node-prompt telnet listener on 127.0.0.1:8010; the
 * resulting SABM travels through net-sim's AFSK1200 channel to our
 * listener; our listener fires `sessionAccepted`; we send a welcome
 * I-frame; we initiate disconnect; we tear down.
 *
 * Inverse of `linbpq-via-netsim.test.ts` — that test has us initiate
 * against BPQ. This one has BPQ initiate against us. Validates that
 * `Ax25Listener` is interoperable as the inbound-accept side of a real
 * third-party AX.25 stack.
 *
 * The describe block self-skips if `127.0.0.1:8100` isn't reachable.
 */
import { Socket, createConnection } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Callsign } from "../../src/callsign.js";
import {
  Ax25Listener,
  type Ax25ListenerSession,
} from "../../src/listener.js";
import type { DataLinkSignal } from "../../src/sdl/action-dispatcher.js";
import { TcpKissTransport } from "../../src/tcp-transport.js";

const HOST = "127.0.0.1";
const OUR_KISS_PORT = 8100;
const BPQ_TELNET_PORT = 8010;
// Use SSID 2 to dodge collision with the C# LinbpqListenerScenarios test
// (which uses PNTEST-0). TSTEST-2 names a distinct station.
const OUR_CALL = Callsign.parse("TSTEST-2");

async function netsimReachable(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let socket: Socket | null = null;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        /* best-effort */
      }
      resolve(ok);
    };
    try {
      socket = createConnection({ host: HOST, port: OUR_KISS_PORT });
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      setTimeout(() => finish(false), 200);
    } catch {
      finish(false);
    }
  });
}

const stackReachable = await netsimReachable();

describe.skipIf(!stackReachable)(
  "Ax25Listener accepts LinBPQ-initiated SABM across net-sim",
  () => {
    let listener: Ax25Listener | null = null;
    let transport: TcpKissTransport | null = null;

    beforeEach(() => {
      transport = new TcpKissTransport(HOST, OUR_KISS_PORT, { kissPort: 0 });
      listener = new Ax25Listener(transport, { myCall: OUR_CALL });
    });

    afterEach(async () => {
      try {
        await listener?.dispose();
      } catch {
        /* best-effort */
      }
      listener = null;
      transport = null;
    });

    // TODO(#153): skip pending investigation. Same flake family as the
    // skipped `IFrame_RoundTrip_Against_Linbpq_Node_Prompt` in
    // linbpq-via-netsim.test.ts. The multi-stage flow (BPQ telnet login
    // → outbound `C 3 <callsign>` → wait for our listener to accept SABM)
    // sometimes completes in ~6s and sometimes hangs through the 180s
    // budget. Bumping the budget further doesn't help — when it hangs,
    // it stays hung. Almost certainly the same BPQ-side state behaviour
    // that #153 tracks.
    it.skip(
      "BPQ_Initiates_C_Command_Listener_Accepts",
      async () => {
        const acceptedPromise = new Promise<Ax25ListenerSession>((resolve) => {
          listener!.onSessionAccepted((session) => {
            resolve(session);
          });
        });

        await listener!.start();
        // Settle for 1.5s so any net-sim AFSK1200 chatter from previous
        // tests has drained and BPQ has flushed its inbound buffer
        // before we tell it to dial. (The shared AFSK1200 channel means
        // BPQ hears every peer interaction on the bus; a fresh test
        // benefits from waiting for the channel to go quiet.)
        await new Promise((r) => setTimeout(r, 1500));

        // Drive BPQ via its node-prompt telnet listener.
        await driveBpqConnect(OUR_CALL);

        const session = await acceptedPromise;
        await waitUntil(() => session.state === "Connected", 10_000);
        expect(session.state).toBe("Connected");

        // Send a welcome I-frame so BPQ has something to acknowledge.
        session.postEvent({
          name: "DL_DATA_request",
          data: new TextEncoder().encode("Packet.NET TS listener says hi\r"),
          pid: 0xf0,
        });

        // Watch for either DL_DISCONNECT_confirm (we initiated) or
        // DL_DISCONNECT_indication (BPQ initiated). Either is success.
        const disconnected = new Promise<void>((resolve) => {
          session.onDataLinkSignal((sig: DataLinkSignal) => {
            if (
              sig.type === "DL_DISCONNECT_confirm" ||
              sig.type === "DL_DISCONNECT_indication"
            ) {
              resolve();
            }
          });
        });

        // Initiate the disconnect from our side.
        session.postEvent({ name: "DL_DISCONNECT_request" });

        await Promise.race([
          disconnected,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("disconnect timeout")), 30_000),
          ),
        ]);
        await waitUntil(() => session.state === "Disconnected", 10_000);
        expect(session.state).toBe("Disconnected");
      },
      180_000,
    );
  },
);

/**
 * Telnet into BPQ's sysop port, log in, and type `C 3 <callsign>` to
 * initiate an outbound L2 connect on BPQ's KISS-TCP port (netsim node c,
 * port 8102 inside docker). Mirrors the C# `DriveBpqConnectAsync` helper.
 */
async function driveBpqConnect(target: Callsign): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const sock = createConnection({ host: HOST, port: BPQ_TELNET_PORT });
    let buf = "";
    const close = () => {
      try {
        sock.destroy();
      } catch {
        // best-effort
      }
    };
    sock.setEncoding("ascii");

    let stage = 0;
    let timer = setTimeout(() => {
      close();
      reject(new Error(`BPQ telnet stuck at stage ${stage}: '${buf}'`));
    }, 10_000);

    function advance(): void {
      clearTimeout(timer);
      timer = setTimeout(() => {
        close();
        reject(new Error(`BPQ telnet stuck at stage ${stage}: '${buf}'`));
      }, 10_000);
    }

    sock.on("error", (err) => {
      clearTimeout(timer);
      close();
      reject(err);
    });

    sock.on("data", (chunk: string) => {
      buf += chunk;
      const lower = buf.toLowerCase();
      switch (stage) {
        case 0:
          if (lower.includes("user")) {
            buf = "";
            sock.write("admin\r");
            stage = 1;
            advance();
          }
          return;
        case 1:
          if (lower.includes("password")) {
            buf = "";
            sock.write("admin\r");
            stage = 2;
            advance();
            // Settle so BPQ has finished printing the banner.
            setTimeout(() => {
              sock.write(`C 3 ${target.toString()}\r`);
              stage = 3;
              advance();
              // Keep the telnet session open for a beat so BPQ doesn't
              // abandon the command, then close.
              setTimeout(() => {
                close();
                resolve();
              }, 1500);
            }, 500);
          }
          return;
      }
    });
  });
}

async function waitUntil(condition: () => boolean, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition not met within ${budgetMs}ms`);
}
