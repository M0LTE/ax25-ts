import type { Ax25Guard, GuardTerm } from "ax25sdl";

/**
 * Evaluates a typed SDL guard — the `guard:` of a {@link TransitionSpec} /
 * {@link SubroutinePath} (a `GuardTerm[]` conjunction) and a {@link LoopRange}'s
 * single-term `predicate`.
 *
 * Each {@link GuardTerm} is a typed {@link Ax25Guard} atom plus a `negate`
 * flag. A conjunction holds when every term holds (logical AND, applying each
 * term's `negate`); an empty conjunction is unguarded (always `true`).
 *
 * Atoms are resolved against an externally-supplied bindings table keyed by the
 * generated {@link Ax25Guard} closed set (e.g. `"own_receiver_busy"` → a closure
 * reading `ctx.ownReceiverBusy`). Because the key type is the closed union, the
 * binding table is exhaustive by construction — a renamed or typo'd atom is a
 * compile error, not an unbound-identifier throw at runtime. This replaces the
 * former string-expression parser (`expr := term ("or" term)*`, etc.) and the
 * hand-mirrored predicate-alias reconciliation: the typed `GuardTerm[]` already
 * carries the conjunction structure and the canonical spelling, so there is no
 * string to tokenise and no dual-spelling to reconcile.
 *
 * Mirrors the C# `Packet.Ax25.Session.GuardEvaluator` over `GuardTerm[]`.
 */
export type GuardBindings = ReadonlyMap<Ax25Guard, () => boolean>;

export class GuardEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardEvaluationError";
  }
}

export class GuardEvaluator {
  constructor(private readonly bindings: GuardBindings) {}

  /**
   * Evaluate a guard conjunction. Empty / null / undefined is unguarded
   * (`true`); otherwise every term must hold.
   */
  evaluate(guard: readonly GuardTerm[] | null | undefined): boolean {
    if (guard == null) return true;
    for (const term of guard) {
      if (!this.evaluateTerm(term)) return false;
    }
    return true;
  }

  /** Evaluate a single term: resolve its atom, then apply `negate`. */
  evaluateTerm(term: GuardTerm): boolean {
    const pred = this.bindings.get(term.atom);
    if (!pred) {
      throw new GuardEvaluationError(
        `unbound guard atom '${term.atom}' — add a binding before evaluating this guard`,
      );
    }
    const value = pred();
    return term.negate ? !value : value;
  }
}
