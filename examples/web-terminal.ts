/**
 * Web-terminal example — the packet-term-web shape: a browser page with a
 * scrollback pane and an input line, talking AX.25 connected mode through a
 * USB KISS modem via Web Serial.
 *
 * What this shows (the "build a web terminal" use case end-to-end):
 *   1. A user-gesture-driven connect button (Web Serial requires it).
 *   2. One `Ax25Stack` per port; one session per `connect`.
 *   3. Rendering inbound bytes into scrollback as they arrive (`onData`).
 *   4. Sending a typed line on Enter (`write`), CR-terminated per packet
 *      convention.
 *   5. Link teardown both ways — local "disconnect" click and remote DISC
 *      (`onDisconnected`).
 *   6. A monitor tap (`onFrameTraced` on a listener-based variant) is shown
 *      in `inbound-listener.ts`; a terminal usually wants the session view.
 *
 * Run target: NOT executable in Node (no `navigator.serial`, no DOM). It
 * compiles and typechecks against the public API surface; inline it into a
 * real page (the markup it expects is sketched at the bottom).
 */
import {
  Ax25Stack,
  Callsign,
  WebSerialKissTransport,
  type Ax25Session,
} from "../src/index.js";

const scrollback = document.querySelector<HTMLPreElement>("#scrollback")!;
const inputLine = document.querySelector<HTMLInputElement>("#input")!;
const connectBtn = document.querySelector<HTMLButtonElement>("#connect")!;
const disconnectBtn = document.querySelector<HTMLButtonElement>("#disconnect")!;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function print(text: string): void {
  scrollback.textContent += text;
  scrollback.scrollTop = scrollback.scrollHeight;
}

let stack: Ax25Stack | null = null;
let session: Ax25Session | null = null;

// 1. Web Serial demands a user gesture — wire the whole bring-up to a click.
connectBtn.addEventListener("click", () => {
  void (async () => {
    const port = await navigator.serial.requestPort();
    const transport = new WebSerialKissTransport(port, { baudRate: 9600 });
    stack = new Ax25Stack(transport);
    await stack.start();

    print("*** Connecting to GB7CIP…\n");
    session = await stack.connect({
      from: Callsign.parse("M0LTE-2"),
      to: "GB7CIP",
    });
    print("*** Connected\n");

    // 3. Inbound bytes → scrollback, as they arrive. A BBS/node prompt is
    //    plain text; render it verbatim (packet convention is CR line ends —
    //    normalise for the DOM).
    session.onData((chunk) => print(decoder.decode(chunk).replaceAll("\r", "\n")));

    // 5b. The far end can drop the link too (DISC, or T1/N2 retry exhaustion).
    session.onDisconnected(() => {
      print("*** Disconnected\n");
      session = null;
    });
  })();
});

// 4. Enter sends the typed line, CR-terminated.
inputLine.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || session === null) return;
  const line = inputLine.value;
  inputLine.value = "";
  print(`${line}\n`); // local echo
  void session.write(encoder.encode(`${line}\r`));
});

// 5a. Local teardown: DISC → UA, then release the port.
disconnectBtn.addEventListener("click", () => {
  void (async () => {
    await session?.disconnect();
    await stack?.stop();
    session = null;
    stack = null;
    print("*** Closed\n");
  })();
});

/*
 * The page this expects (any styling you like):
 *
 *   <pre id="scrollback"></pre>
 *   <input id="input" placeholder="type a line, Enter to send" />
 *   <button id="connect">Connect</button>
 *   <button id="disconnect">Disconnect</button>
 *
 * For a full production take on this shape — TNC2-style monitor, multiple
 * sessions, NET/ROM awareness — see m0lte/packet-term-web, which consumes
 * this library from npm.
 */
