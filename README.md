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
2. **Cross-process spend accounting is enforced — and validated — by a compare-and-swap store, on one host.** Multiple processes on **one host** sharing a wallet's local-disk ledger are serialized: the store commits only if the ledger hasn't moved since it was read (an atomic `link()`-based compare-and-swap), so a losing writer is *told* it lost and re-evaluates instead of silently overwriting. This is exercised by a real N-process race (`test/e2e/cross-process-smoke.e2e.test.ts`): against a cap that admits exactly N payments with far more demand than that, **exactly N are admitted and the durable ledger records every one** — no lost updates. The store also **refuses to run** (fail-closed) on any filesystem it can't prove honors atomic exclusive-create — NFS/SMB are refused by name, and anything that fails a concurrent exclusive-create probe is refused too. **Remaining boundary (honest):** sharing one ledger across *separate hosts* requires a networked filesystem, which is exactly the case the store won't trust — so multi-host is out of scope for the *file* store. A multi-host deployment needs an external CAS store (a database, a Durable Object — a future adapter over the same versioned seam), not a shared file. (ACCT-05, D-031, D-032.)
3. **Spend state must live on a store the guard can prove atomic — unsupported topologies fail *loud*, not silent.** The bundled file store needs a writable, persistent path that honors atomic exclusive-create; it **refuses to start** on one that doesn't, rather than silently under-enforcing. A truly **ephemeral/stateless** runtime (no durable store anywhere) genuinely cannot enforce *cumulative* caps — there's nowhere to keep the running total — so the honest answer is to give the guard a durable store (the store interface is a topology-agnostic versioned contract: a database, a Durable Object, etc.) or run one long-lived process with a real disk. **Do not expect cumulative caps to hold with no durable store.** Our rule: an unsupported deployment fails *loud*, not silently mis-enforcing. At rest, the ledger is created **owner-private** (`0o600`) and a **world-writable** ledger is **refused** before it's trusted — a tampered ledger could reset spend — the same posture as the decision log (ACCT-06/PRIV-04). This is scoped to the ledger *file*; don't place your ledger in a world-writable *directory*. **On Windows** these POSIX mode checks don't apply — Windows uses ACLs, not mode bits, so they are **skipped** to avoid misfiring (PLAT-01). Rely on **NTFS ACLs** instead: keep the ledger, policy, and log under your user profile (`%LOCALAPPDATA%`), where inherited ACLs already restrict them to your account.
4. **Write-ahead accounting over-counts on downstream failure.** Spend is recorded before the payment settles (so a crash never under-counts) — but a payment the facilitator later rejects still consumes budget until a settlement-reconciliation path exists (v2). A run of failed payments can walk you into your cap early.

## Design principles

- **Fail closed.** Every ambiguous case — a policy error, an engine exception, a missing field — results in **deny**. A guard that fails open is not a guard.
- **Mechanism, not policy.** The guard enforces the deterministic policy *you* write; it forms no opinions of its own. No heuristic "this looks suspicious" judgments — that would be the guard authoring policy — so, no anomaly detection.
- **No egress.** The guard makes no network calls and ships no telemetry. Your payment data never leaves your machine. Absent, not opt-out. Read APIs like `snapshot()` are **pull, not push** — an in-process, owner-only view you request locally, never a sender; the guard is a data *source you control*. The copy it hands back is your private financial posture (including who you pay) — treat it with the same care as the ledger file.
- **Trust model: your isolation boundary.** The guard is as secure as the container, sandbox, or VM it runs inside, and assumes no hostile process shares that boundary — one that does can read the signing key and defeat any in-process guard. Enforcement (caps, allowlist, binding, kill switch) is platform-agnostic and always on. At-rest hardening (file permissions, and a tamper-evident audit log) is *opportunistic* — a bonus layer where your platform supports one, never a substitute for the isolation boundary, and never a pretense of protection where it can't be delivered. **The same true statement on every OS.** A genuinely shared multi-user host wants a hardened store, which the topology-agnostic store interface lets you supply — see [THREAT_MODEL.md](THREAT_MODEL.md).
- **Small, auditable core.** The security-critical logic is a pure function with zero runtime dependencies — small enough to read in one sitting.

## Documentation

- **[THREAT_MODEL.md](THREAT_MODEL.md)** — adversaries, assets, trust boundary, and what we do and do not defend.
- **[REQUIREMENTS.md](REQUIREMENTS.md)** — numbered, testable requirements, each traced to a threat and a test.
- **[TRACEABILITY.md](TRACEABILITY.md)** — the requirements-traceability matrix: every requirement → its verifying test(s) → status. Generated from the suite (`npm run traceability`) and CI-checked so it can't drift.
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

**`v0.2.1` — on [npm](https://www.npmjs.com/package/x402-spendguard): `npm install x402-spendguard`, published from CI (tokenless OIDC) with a signed provenance attestation.** The guard installs in front of a real `@x402` client and enforces at the moment a payment is signed. What's proven, live and in the suite:

- **Both x402 generations** (v1 and v2) — one guard, dispatched on the protocol version.
- **Deny works in the wild** — a real `@x402` client driven through a genuine 402 is blocked on kill-switch / off-allowlist / over-cap, and reaches a signature *only* through the guarded (allowlist) route.
- **Allow settles** — a policy-compliant payment, signed through the guard, is verified and settled **on-chain** by a real facilitator. Validated live on **Base Sepolia** (real USDC, real transaction) — reproducible with a throwaway key and faucet USDC ([`test/e2e/FUNDED.md`](test/e2e/FUNDED.md)).
- **Cross-process spend integrity** *(new in 0.1.4)* — two processes on one wallet's ledger can't both pass a cap they jointly exceed; validated across real separate OS processes (same host).
- **`snapshot()` read API** *(new)* — a read-only, pull view of current spend vs. caps for a local dashboard; never transmits.
- **Tamper-evident audit log** *(new)* — the decision log is a hash chain you can `verify()`; unkeyed by default, keyed HMAC if you supply a key.
- **Owner-private, tamper-refusing at rest** *(new)* — the ledger is created `0o600` and refuses a world-writable file (Windows-guarded).

**Now on npm, with provenance** *(new in 0.2.0)* — a single **frozen** public entry point (`import { … } from "x402-spendguard"`), a `dist`-only zero-dependency artifact, published from CI with a signed build attestation you can verify. The enforcement core is **property-tested** — nine `fast-check` invariants (no-drain, fail-closed fuzzing, binding soundness, cross-asset accounting, clock monotonicity, determinism, reason-code observability, hash-chain tamper-detection), each confirmed non-vacuous by mutation — and a **P0 cross-process over-allow, found before publish, is fixed** (ACCT-07; postmortem in [TEST_PLAN.md](TEST_PLAN.md) §9).

Still **pre-alpha** (`0.x` — nothing is stable, anything may change): single-agent, testnet-validated, single-tenant trust model (see [THREAT_MODEL.md](THREAT_MODEL.md)). **Not for mainnet.** Zero runtime dependencies; `@x402` is an optional peer dependency.

### Wiring it in (the shape)

The guard interposes at the three points an x402 client exposes, through one binding — the veto happens at the signer, where the *real* struct about to be signed is visible:

```ts
const binding = createSpendGuardBinding(guard);              // guard = your policy + spend store
registerExactEvmScheme(client, { signer: binding.wrapSigner(signer) }); // veto at signing
client.onBeforePaymentCreation(binding.hook);                // capture the offer
const guardedFetch = binding.wrapFetch(globalThis.fetch);    // capture the real request origin
```

A complete, runnable example — both the hermetic deny path and a live funded settle — is in [`test/e2e/`](test/e2e/).

```bash
npm install
npm test          # the hermetic suite (no network, no funds)
```

## License

MIT (open-core: the guard is and stays free/open; a hosted version + dashboard may come later).
