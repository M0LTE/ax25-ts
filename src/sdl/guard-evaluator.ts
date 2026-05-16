/**
 * Evaluates the small boolean expression language used in SDL transition
 * `guard:` fields. Grammar:
 *
 *   expr   := term ("or" term)*
 *   term   := factor ("and" factor)*
 *   factor := "not"? identifier
 *
 * Identifiers are resolved against an externally-supplied bindings table
 * (e.g. `"own_receiver_busy"` → a closure reading `ctx.ownReceiverBusy`).
 * Whitespace separates tokens. Parentheses are not supported — every guard
 * observed in the spec is a simple conjunction of negated or unnegated
 * flags, occasionally an `or`. The grammar grows only as new SDL pages
 * need it.
 *
 * Empty / null / whitespace-only expression is treated as `true` (no guard).
 *
 * Mirrors the C# `Packet.Ax25.Session.GuardEvaluator` line-for-line.
 */
export type GuardBindings = ReadonlyMap<string, () => boolean>;

export class GuardEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardEvaluationError";
  }
}

export class GuardEvaluator {
  constructor(private readonly bindings: GuardBindings) {}

  evaluate(expression: string | null | undefined): boolean {
    if (expression == null) return true;
    const trimmed = expression.trim();
    if (trimmed === "") return true;
    const tokens = trimmed.split(/[ \t]+/).filter((t) => t.length > 0);
    const state = { tokens, idx: 0, original: expression };
    const result = this.parseOr(state);
    if (state.idx !== tokens.length) {
      throw new GuardEvaluationError(
        `trailing tokens in guard expression '${expression}' at position ${state.idx}`,
      );
    }
    return result;
  }

  private parseOr(state: ParseState): boolean {
    let result = this.parseAnd(state);
    while (state.idx < state.tokens.length && state.tokens[state.idx] === "or") {
      state.idx++;
      const right = this.parseAnd(state);
      result = result || right;
    }
    return result;
  }

  private parseAnd(state: ParseState): boolean {
    let result = this.parseFactor(state);
    while (
      state.idx < state.tokens.length &&
      state.tokens[state.idx] === "and"
    ) {
      state.idx++;
      const right = this.parseFactor(state);
      result = result && right;
    }
    return result;
  }

  private parseFactor(state: ParseState): boolean {
    if (state.idx >= state.tokens.length) {
      throw new GuardEvaluationError(
        `expected identifier in '${state.original}' at position ${state.idx}`,
      );
    }
    let negate = false;
    if (state.tokens[state.idx] === "not") {
      negate = true;
      state.idx++;
      if (state.idx >= state.tokens.length) {
        throw new GuardEvaluationError(
          `expected identifier after 'not' in '${state.original}'`,
        );
      }
    }
    const ident = state.tokens[state.idx++]!;
    const pred = this.bindings.get(ident);
    if (!pred) {
      throw new GuardEvaluationError(
        `unbound identifier '${ident}' in '${state.original}' — add a binding before evaluating this guard`,
      );
    }
    const value = pred();
    return negate ? !value : value;
  }
}

interface ParseState {
  readonly tokens: readonly string[];
  idx: number;
  readonly original: string;
}
