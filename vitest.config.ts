import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Integration tests live under tests/integration/ and dial the docker
    // interop stack on 127.0.0.1:8100. They have their own runner script
    // (`npm run test:integration` — see package.json) and a docker-presence
    // skip-guard, but excluding them from the default include keeps a plain
    // `npm test` invocation from probing the network at all.
    exclude: ["node_modules/**", "dist/**", "tests/integration/**"],
    environment: "node",
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
  },
});
