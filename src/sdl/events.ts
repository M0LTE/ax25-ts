import type { Ax25Event as Ax25EventName } from "ax25sdl";
import type { Ax25Frame } from "../frame.js";

/**
 * Events posted into the SDL session driver. Each event has a `name`
 * that matches an `on:` field on a generated transition spec
 * (e.g. `"SABM_received"`, `"DL_CONNECT_request"`, `"T1_expiry"`).
 *
 * `name` is the generated {@link Ax25EventName} closed set (the `ax25sdl`
 * `Ax25Event` string-literal union), so it lines up exactly with the typed
 * `TransitionSpec.on` the driver matches against — a typo'd event name is a
 * compile error, and no event-name normalisation/aliasing layer is needed
 * (the figure-spelled names already are the canonical set).
 *
 * Frame-receipt events carry the triggering {@link Ax25Frame}; upper-
 * layer DL primitives carry their payload; timer expirie names are
 * just markers. The {@link Ax25SessionBindings} closures dereference
 * the trigger when frame-aware predicates fire.
 */
export interface Ax25Event {
  /** SDL event name — matches `transition.on` ({@link Ax25EventName}). */
  readonly name: Ax25EventName;
  /** Triggering frame, if any. */
  readonly frame?: Ax25Frame;
  /** Upper-layer payload (DL-DATA / DL-UNIT-DATA / I-frame-pop). */
  readonly data?: Uint8Array;
  /** PID accompanying upper-layer payload. */
  readonly pid?: number;
  /** N(S) extracted from the popped queue entry (for I_frame_pops_off_queue). */
  readonly ns?: number;
}

/** Build a frame-receipt event. The event name is figure-spelled. */
export function frameEvent(name: Ax25EventName, frame: Ax25Frame): Ax25Event {
  return { name, frame };
}

/** Build a timer-expiry event (no frame, no payload). */
export function timerEvent(name: Ax25EventName): Ax25Event {
  return { name };
}

/** Build a DL-DATA-request event (upper layer wants to send `data`). */
export function dlDataRequestEvent(data: Uint8Array, pid: number): Ax25Event {
  return { name: "DL_DATA_request", data, pid };
}

/** Build an I_frame_pops_off_queue synthetic event. */
export function iFramePopsOffQueueEvent(
  data: Uint8Array,
  pid: number,
): Ax25Event {
  return { name: "I_frame_pops_off_queue", data, pid };
}

/** Build a DL_CONNECT_request event. */
export function dlConnectRequestEvent(): Ax25Event {
  return { name: "DL_CONNECT_request" };
}

/** Build a DL_DISCONNECT_request event. */
export function dlDisconnectRequestEvent(): Ax25Event {
  return { name: "DL_DISCONNECT_request" };
}
