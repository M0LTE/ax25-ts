import { defineConfig } from "vitest/config";

/**
 * Integration-test vitest config. Drives `Ax25Stack` end-to-end against
 * the live docker interop stack (`docker/compose.interop.yml`). The tests
 * themselves probe `127.0.0.1:8100` and skip the whole describe block when
 * net-sim isn't listening, so this config is safe to run anywhere — but
 * by convention it's wired up to `npm run test:integration` and only
 * invoked when the stack is up (the `interop` CI job or by hand locally).
 *
 * Kept separate from `vitest.config.ts` so a plain `npm test` never even
 * loads these files — important because they import `node:net` and would
 * otherwise log a confusing "couldn't dial" warning even when skipped.
 */
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    // The afsk1200 sim plus BPQ's KISS retry / banner emission together
    // can soak up 10-20 seconds per scenario. Bump test/hook timeouts
    // from vitest's 5s default so the budgets the tests assert on are
    // the only ones that matter.
    testTimeout: 60_000,
    hookTimeout: 30_000,
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
  },
});
