# End-to-end harness (`test/e2e/`)

Proves the guard is actually **wired into the real `@x402` payment flow** — not just correct in
unit isolation. Unit tests show the engine decides right; this shows the real SDK's
`ExactEvmScheme` (both x402 generations) hits our veto and **cannot route around it**.

## What runs today: the deny path (hermetic, no key, no funds)

[`deny-path.e2e.test.ts`](./deny-path.e2e.test.ts) drives the **real** `@x402` client through a
**genuine 402** served over real localhost HTTP ([`x402-local-server.ts`](./x402-local-server.ts)),
with our `createSpendGuardBinding` installed, and asserts:

- **Deny propagates, no signature produced.** Kill switch, off-allowlist payee, and over-cap
  amount each abort the real `createPaymentPayload` with the guard's specific reason
  (`halt` / `allowlist.blocked` / `cap.per_request`) — on **both v1 and v2** wire shapes. These
  deny tests carry the decision weight: they stay green only if the guard's *actual verdict* is
  load-bearing (verified by mutation — neuter the checks and they all fail).
- **Origin value drives the verdict.** With `requireOriginMatch` on, a resource origin that
  differs from the real request host denies with `origin.mismatch` — proving the origin the
  transport wrap *derived* reaches the policy, not just that origin is present.
- **Finding A in the wild.** On an allow (both v1 and v2), the real client reaches a signature
  **only** through our wrapped `signTypedData` — no other signing route. (Scope: this proves the
  honest client's route usage, not that the wrap blocks every route of a richer signer — that is
  the blocklist→allowlist residual the funded path exercises.)

The signer is a **canary** that records which route was reached and never produces a real
signature. Because the deny path never signs, there is **no key and no funds** involved — the
suite is fully hermetic (localhost, ephemeral port, no secrets, no external network).

```bash
npm run test:e2e             # runs the full hermetic e2e set (below); the funded suite self-skips
```

`npm run test:e2e` runs the whole e2e config, not just the deny path — the other hermetic suites are:

- **Cross-process spend integrity** — [`cross-process-smoke.e2e.test.ts`](./cross-process-smoke.e2e.test.ts)
  and [`cross-process-stress.e2e.test.ts`](./cross-process-stress.e2e.test.ts): real separate OS
  processes race one wallet's ledger; exactly the cap is admitted and the durable ledger records every
  allow (CI sets `SMOKE_TEETH=1`, so a non-CAS last-write-wins store would over-admit and fail).
- **Supply-chain / packaging** — [`pack-install.e2e.test.ts`](./pack-install.e2e.test.ts): packs the
  real tarball, installs it into a throwaway consumer, and asserts the frozen public surface and
  `dist`-only contents (PKG-01…05).

(Dedicated scripts also exist: `npm run test:e2e:smoke`, `npm run test:e2e:pack`.)

The whole harness lives under `test/e2e/` (never imported by `src/`), so the static no-egress proof
over `src/` is untouched, and it runs in its own vitest config + a separate CI job — **never** the
default `npm test` green-main gate.

## The funded settle path (opt-in, real value)

The one thing the deny path can't prove without value moving: a **policy-compliant** payment
actually settling on a testnet facilitator. That test now exists —
[`funded-settle.e2e.test.ts`](./funded-settle.e2e.test.ts) — and **self-skips** unless you provide a
funded base-sepolia key, so this suite and CI stay hermetic. It reads the key from an **untracked
`.env`** (see [`.env.example`](./.env.example)); a real key is **never** committed.

```
npm run test:e2e:funded      # skips unless TESTNET_PRIVATE_KEY is set
```

**Full runbook — provisioning a throwaway wallet, faucet USDC (no ETH needed), and running it: see
[FUNDED.md](./FUNDED.md).** Until you've run it green against a real facilitator, do not place this
in front of a wallet you care about.
