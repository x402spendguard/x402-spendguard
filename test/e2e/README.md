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

```
npm run test:e2e
```

It lives under `test/e2e/` (never imported by `src/`), so the static no-egress proof over `src/`
is untouched, and it runs in its own vitest config + a separate CI job — **never** the default
`npm test` green-main gate.

## What's deferred: the funded settle path

The one thing this can't prove without value moving: a **policy-compliant** payment actually
settling on a testnet facilitator. That needs a funded base-sepolia wallet and is the next
milestone. It will read a key from an **untracked `.env`** (see [`.env.example`](./.env.example));
a real key is **never** committed. Until it exists, do not place this in front of a funded wallet.
