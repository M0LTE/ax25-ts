/**
 * Names of timers the SDL refers to. AX.25 v2.2 defines T1 (acknowledge),
 * T2 (response delay), and T3 (inactive-link). The action dispatcher's
 * `start_T1` / `stop_T1` etc. verbs route through a {@link TimerScheduler}.
 */
export type TimerName = "T1" | "T2" | "T3";

/**
 * Arms / cancels / queries one of the three named SDL timers. The C# runtime
 * has the equivalent `ITimerScheduler` interface — this TS port keeps the
 * same shape so the guard-binding `T1_running` etc. predicates can read it.
 */
export interface TimerScheduler {
  /** Start `name` running for `durationMs`. If already armed, restart. */
  arm(name: TimerName, durationMs: number, onExpiry: () => void): void;
  /** Cancel `name` if armed; no-op otherwise. */
  cancel(name: TimerName): void;
  /** True if `name` is currently armed (and hasn't fired yet). */
  isRunning(name: TimerName): boolean;
  /** Milliseconds remaining until expiry, or 0 if not running. */
  timeRemainingMs(name: TimerName): number;
}

interface ArmedTimer {
  readonly handle: ReturnType<typeof setTimeout>;
  readonly endTimeMs: number;
  readonly onExpiry: () => void;
}

/**
 * Real-time scheduler backed by `setTimeout`. Used by the production session
 * driver. Tests can substitute a manual scheduler if they need to drive
 * timer fires deterministically.
 */
export class RealTimerScheduler implements TimerScheduler {
  private readonly armed: Map<TimerName, ArmedTimer> = new Map();

  arm(name: TimerName, durationMs: number, onExpiry: () => void): void {
    this.cancel(name);
    const endTimeMs = Date.now() + durationMs;
    const handle = setTimeout(() => {
      this.armed.delete(name);
      onExpiry();
    }, durationMs);
    this.armed.set(name, { handle, endTimeMs, onExpiry });
  }

  cancel(name: TimerName): void {
    const entry = this.armed.get(name);
    if (entry) {
      clearTimeout(entry.handle);
      this.armed.delete(name);
    }
  }

  isRunning(name: TimerName): boolean {
    return this.armed.has(name);
  }

  timeRemainingMs(name: TimerName): number {
    const entry = this.armed.get(name);
    if (!entry) return 0;
    const remaining = entry.endTimeMs - Date.now();
    return remaining > 0 ? remaining : 0;
  }
}
