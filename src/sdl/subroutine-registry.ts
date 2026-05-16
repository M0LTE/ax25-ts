import type { TransitionContext } from "./action-dispatcher.js";

/**
 * A subroutine action chain — invoked by `kind: subroutine` action steps
 * in the SDL transitions. Receives the same {@link TransitionContext} as
 * the calling chain so it can mutate session state and emit frames.
 */
export type Subroutine = (tx: TransitionContext) => void;

/**
 * Registry of figc4.7 subroutines. The C# runtime uses this to dispatch
 * `Establish_Data_Link`, `Select_T1_Value`, `Check_I_Frame_Acknowledged`,
 * etc. against generated subroutine paths. The TS port currently provides
 * a no-op stub registry — every known subroutine name routes to a
 * recorded log entry and continues. Future work: walk the
 * {@link DataLinkSubroutines} table (from `ax25sdl`) and synthesise the
 * action chain through the dispatcher.
 *
 * Document the gap in the README — the table-driven driver will still
 * walk Disconnected/AwaitingConnection/Connected/AwaitingRelease for the
 * happy-path round-trip, but anything that requires a subroutine body
 * (e.g. `Establish_Data_Link` building a SABM frame) is now handled by
 * the dispatcher's wrapper case-arms (see {@link ActionDispatcher}).
 * For the purposes of the SABM/UA/DISC/UA/I-frame happy path, the
 * dispatcher inlines the verbs it needs — `Establish_Data_Link` is
 * synthesised in place; `Select_T1_Value` is a no-op; and so on.
 */
export interface SubroutineRegistry {
  invoke(name: string, tx: TransitionContext): void;
}

/**
 * Default registry: logs an unknown-subroutine warning via the configured
 * sink and continues. Pre-registered subroutines route to their handler;
 * unknown names route to the logger so transcription typos / new
 * subroutines surface in a development log rather than silently drop on
 * the floor.
 */
export class DefaultSubroutineRegistry implements SubroutineRegistry {
  private readonly registry: Map<string, Subroutine> = new Map();

  constructor(
    private readonly onUnknown: (name: string) => void = () => {},
  ) {}

  /** Register a handler for a named subroutine. Replaces any prior. */
  register(name: string, impl: Subroutine): void {
    this.registry.set(name, impl);
  }

  invoke(name: string, tx: TransitionContext): void {
    const impl = this.registry.get(name);
    if (impl) {
      impl(tx);
      return;
    }
    this.onUnknown(name);
  }
}
