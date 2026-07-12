import { defineConfig } from "vitest/config";

// The OPT-IN end-to-end gate (`npm run test:e2e`). Runs ONLY `test/e2e/**` — the live-flow
// harness that drives a real @x402 client through a genuine 402 against a local resource
// server. Kept in its own config (and its own CI job) so it is never conflated with the
// hermetic default `npm test`. The deny-path suite is hermetic (localhost, no key, no funds);
// the funded settle path (deferred) is the only part that will ever need `.env` secrets.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.test.ts"],
    // A real HTTP round-trip + client handshake is slower than a pure unit test.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
