# x402-spendguard

[![CI](https://github.com/x402spendguard/x402-spendguard/actions/workflows/ci.yml/badge.svg)](https://github.com/x402spendguard/x402-spendguard/actions/workflows/ci.yml)

A spend firewall for AI agents that pay via [x402](https://x402.org).

It sits between your agent and the x402 payment step and enforces policy **before**
any payment is signed or settled. Settlement is irreversible, so the only safe place
to say "no" is *before* it happens.

**Contact:** Kevin Brown, x402.spendguard@gmail.com

## Why

An agent that can pay can be *made* to pay — by prompt injection, a compromised tool,
or a runaway loop. The headline failure modes are wallet drains: payment redirected to
an attacker address, or repeated / oversized payments. `x402-spendguard` is a small,
auditable guard you run yourself that makes those impossible within limits you set.

## v1 scope — anti-drain + signature integrity

v1 enforces, before any payment is signed:

**Anti-drain**
- **Kill switch** — halt all payments instantly.
- **Destination allowlist** — only pay `(address, chain)` pairs you've approved (defeats payment-redirect injection). An empty allowlist denies everything: secure by default.
- **Spend caps** — per-request, per-domain, and global budgets, denominated per `(asset, chain)`.

**Signature integrity** — because the x402 signature commits to the *money*, not the *request*, v1 also checks the authorization about to be signed against the challenge you actually received:
- **Amount match** — the signed `value` must equal the challenge amount. (v1 facilitators otherwise accept overpayment.)
- **Recipient match** — the signed `to` must equal the challenge `payTo`.
- **Lifetime bound** — `validBefore` must respect the challenge's `maxTimeoutSeconds`, a bound no facilitator enforces.

**Scope of v1:** EIP-3009 `exact` payments on **EVM chains** (Ethereum and the EVM family — Base, Polygon, Arbitrum, …). Solana/SVM and the `upto` metered scheme are denied with a clear reason and deferred to v2. Base — where most current x402 volume lives — is EVM, so v1 covers today's dominant venue.

Two things that surprise people, stated up front:
- **Global budgets are per-denomination, not per-dollar.** You set a cap for USDC-on-Base, not a single dollar ceiling across every token — because summing different tokens would require a price feed, and the guard makes no network calls and holds no opinion about value.
- **An empty allowlist denies everything.** Secure by default: you name your destinations, rather than the guard guessing.

v1 does **not** do: replay/nonce protection, `upto`, non-EVM chains, or enforcement against a compromised agent process — all deferred (see below). Provided AS IS, without warranty (see LICENSE).

## What it is — and is not

This guard **screens the signature**, not just the offer: it interposes where the payment authorization is built, so it sees the actual struct before it is signed. That is what lets it enforce the signature-integrity checks above — checks an offer-screening guard structurally cannot make. (See [docs/prior-art.md](docs/prior-art.md) for how this relates to other tools; they are complementary, not competing.)

Limits we hold ourselves to, stated up front:

1. **It is not more enforceable than any in-process guard.** An agent whose code an attacker controls calls the signer directly and bypasses it. The guard gives you *visibility into what is about to be signed*, not *authority over whether it is signed*. It stops an honest agent that has been lied to — prompt injection, a compromised tool, a runaway loop — not an agent whose code is owned. Raising that ceiling (a key-holding local daemon; on-chain delegation) is the roadmap, not v1.
2. **Spend accounting is serialized within one process, not yet across processes.** The bundled file store has no cross-process lock, so **two processes sharing one wallet's ledger can under-count and silently bypass a cap.** Until that's closed (tracked as ACCT-05), **run one guard instance per wallet.** This is the one place our "state the surprising limit up front" discipline had a blind spot; an external review caught it, and now it's here.
3. **Spend state must live on a writable, persistent, local disk.** The bundled file store needs a path that survives restarts. On a **read-only filesystem** it cannot persist at all; in **ephemeral/serverless** environments (a per-instance `/tmp` wiped between invocations) each cold start begins with **empty** spend state, so your cumulative caps silently reset and stop enforcing — a fail-**open**, not a crash, that anyone able to spin up fresh instances can trigger. Until unsupported topologies are *detected and refused*, run the guard as a single long-lived process with a real disk, and **do not rely on the caps in ephemeral or read-only deployments.** Our rule: an unsupported deployment must fail *loud*, not silently mis-enforce.
4. **Write-ahead accounting over-counts on downstream failure.** Spend is recorded before the payment settles (so a crash never under-counts) — but a payment the facilitator later rejects still consumes budget until a settlement-reconciliation path exists (v2). A run of failed payments can walk you into your cap early.

## Design principles

- **Fail closed.** Every ambiguous case — a policy error, an engine exception, a missing field — results in **deny**. A guard that fails open is not a guard.
- **Mechanism, not policy.** The guard enforces the deterministic policy *you* write; it forms no opinions of its own. No heuristic "this looks suspicious" judgments — that would be the guard authoring policy — so, no anomaly detection.
- **No egress.** The guard makes no network calls and ships no telemetry. Your payment data never leaves your machine. Absent, not opt-out.
- **Small, auditable core.** The security-critical logic is a pure function with zero runtime dependencies — small enough to read in one sitting.

## Documentation

- **[THREAT_MODEL.md](THREAT_MODEL.md)** — adversaries, assets, trust boundary, and what we do and do not defend.
- **[REQUIREMENTS.md](REQUIREMENTS.md)** — numbered, testable requirements, each traced to a threat and a test.
- **[TEST_PLAN.md](TEST_PLAN.md)** — testing methodology: how we prove the requirements hold.
- **[SECURITY.md](SECURITY.md)** — how to report a vulnerability, and our disclosure commitment.
- **[docs/decisions.md](docs/decisions.md)** — the decision record: what we chose, why, and what we rejected.
- **[docs/roadmap.md](docs/roadmap.md)** — tracked future work and deferrals, each with its rationale and gate.
- **[docs/x402-protocol-notes.md](docs/x402-protocol-notes.md)** — the x402 protocol facts a guard depends on, verified against source.
- **[docs/prior-art.md](docs/prior-art.md)** — existing x402 guards, read at the source level, credited and compared.

## Authorship

This project is built by a human and an AI working together — Kevin Brown, with Claude. We say so plainly because you are being asked to trust a security tool, and you should know how it was made.

The security-critical core is deliberately small — a pure function, zero runtime dependencies — **specifically so that a human can read all of it.** That is the point of the size limit, not a coincidence of it. Every claim this project makes about the x402 protocol was verified against the protocol's source rather than from an AI's recollection; we found, more than once, that the recollection was wrong. The reasoning behind every design decision is written down in [docs/decisions.md](docs/decisions.md) so you can check the argument, not just the conclusion.

Read the code. That has always been the deal with a guard.

## Status

Pre-alpha. Core policy engine + tests only. The core is being brought into line with the threat model (see REQUIREMENTS.md); payment-interception adapters for the x402 client SDKs are a later slice.

```bash
npm install
npm test
```

## License

MIT (open-core: the guard is and stays free/open; a hosted version + dashboard may come later).
