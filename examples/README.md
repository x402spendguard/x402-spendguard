# Examples

Runnable, minimal examples. Install the package first (`npm install x402-spendguard`), then run one with your TypeScript runner (e.g. `npx tsx examples/<file>.ts`).

- **[configure-and-echo.ts](configure-and-echo.ts)** — the config on-ramp with only the library, no network: build a policy, then echo its caps in human units so an off-by-a-zero cap is obvious (`describePolicy`). Also shows `assetKey` for building a `chain|token` caps key by construction.

For the full end-to-end wiring — a real `@x402` client driven through a 402, the hermetic deny path, and a live funded settle — see [`../test/e2e/`](../test/e2e/). Those are proof harnesses rather than teaching examples, but they show every interposition point wired against a real client.
