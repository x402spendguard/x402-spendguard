import { defineConfig, configDefaults } from "vitest/config";

// The DEFAULT gate (`npm test`) — the hermetic, offline unit + property suite that guards
// `main`. It deliberately EXCLUDES `test/e2e/**`: those tests stand up a real @x402 client
// against a local resource server over real HTTP, so they are opt-in (`npm run test:e2e`,
// its own config + a separate CI job) and never part of the always-green default gate.
// Keeping egress-touching tests out of the default run is what lets the static no-egress
// proof over `src/` remain the whole story for `npm test`.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "test/e2e/**"],
  },
});
