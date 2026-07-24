# x402-spendguard

[![CI](https://github.com/x402spendguard/x402-spendguard/actions/workflows/ci.yml/badge.svg)](https://github.com/x402spendguard/x402-spendguard/actions/workflows/ci.yml)

A spend firewall for AI agents that pay via [x402](https://x402.org).

It sits between your agent and the x402 payment step, enforcing your policy **before**
any payment is signed or settled. Settlement is irreversible, so the only safe place
to say "no" is *before* it happens.

Spendguard v1 does **not** do: replay/nonce protection, `upto`, non-EVM chains, or enforcement against a compromised agent process — all deferred (see below). Provided AS IS, without warranty (see LICENSE).

**Contact:** Kevin Brown, x402.spendguard@gmail.com

## Why

An agent that can pay can be *made* to pay — by prompt injection, a compromised tool,
or a runaway loop. The headline failure mode is the wallet drain: a payment redirected
to an attacker's address, or repeated and oversized payments that bleed the account.
`x402-spendguard` is a small, auditable guard you run yourself: you set the limits —
caps, an allowlist, a kill switch — and it blocks any payment that would cross them,
before it is signed.

## What spendguard v1 enforces

Before any payment is signed, **spendguard v1** enforces the following. (That's the
guard's own version number — distinct from the x402 *protocol's* v1 and v2 generations,
both of which the guard supports.)

**Anti-drain**
- **Kill switch** — halt all payments instantly.
- **Destination allowlist** — only pay `(address, chain)` pairs you've approved (defeats payment-redirect injection).
- **Spend caps** — per-request, per-domain, and global budgets, denominated per `(asset, chain)`.

**Signature integrity** — because the x402 signature commits to the *money*, not the *request*, the guard also checks the authorization about to be signed against the challenge you actually received:
- **Amount match** — the signed `value` must equal the challenge amount. (x402 v1 facilitators otherwise accept overpayment.)
- **Recipient match** — the signed `to` must equal the challenge `payTo`.
- **Lifetime bound** — `validBefore` must respect the challenge's `maxTimeoutSeconds`, a bound no facilitator enforces.

**Coverage:** EIP-3009 `exact` payments on **EVM chains** (Ethereum and the EVM family — Base, Polygon, Arbitrum, …). Solana/SVM and the `upto` metered scheme are denied with a clear reason and deferred to a later version. Base — where most current x402 volume lives — is EVM, so v1 covers today's dominant venue.

Two things that surprise people:
- **Global budgets are per-denomination, not per-dollar.** You set a cap for USDC-on-Base, not a single dollar ceiling across every token — because summing different tokens would require a price feed, and the guard makes no network calls and holds no opinion about value.
- **An empty allowlist denies everything.** Secure by default: you name your destinations, rather than the guard guessing.

## What it is — and is not

**What it is:** a guard that screens the *signature*, not just the offer — it interposes where the payment authorization is built, so it sees the actual struct before it is signed. That is what lets it enforce the signature-integrity checks above (checks an offer-screening tool structurally cannot make). Complementary to offer-screening guards, not competing — see [docs/prior-art.md](docs/prior-art.md).

**What it is not** — the limits, stated plainly so you can decide if it fits:

- **Not a wall against a compromised agent.** If an attacker controls the agent's code, it calls the signer directly and bypasses the guard — you get *visibility into what is about to be signed*, not *authority over whether it is signed*. It stops an *honest* agent that has been lied to (prompt injection, a bad tool, a runaway loop), not one whose code is owned. Raising that ceiling (a key-holding local daemon, on-chain delegation) is the roadmap, not this version.
- **Cross-process safe on one host, not across hosts.** Processes sharing one wallet's ledger on the *same host* are serialized by an atomic compare-and-swap store, so they cannot jointly overspend a cap (validated with a real N-process race). Spanning *separate hosts* needs an external store — a database, a Durable Object — which the bundled file store is not.
- **Needs a durable, atomic store — and says so loudly if it can't get one.** Cumulative caps need somewhere to keep the running total; the file store refuses to start on a filesystem it can't prove atomic (NFS/SMB are refused by name) rather than under-enforce silently. A stateless or ephemeral runtime with no durable store cannot enforce cumulative caps at all.
- **Counts spend before settlement, so it can over-count on failure.** Spend is recorded before the payment settles (a crash never *under*-counts), but a payment the facilitator later rejects still consumes budget until settlement-reconciliation lands (a later version). A run of failures can reach your cap early.

The full reasoning behind each limit — the trust model, at-rest hardening, and Windows handling — is in [THREAT_MODEL.md](THREAT_MODEL.md).

## Design principles

- **Fail closed.** Every ambiguous case — a policy error, an engine exception, a missing field — results in **deny**. A guard that fails open is not a guard.
- **Mechanism, not policy.** The guard enforces the deterministic policy *you* write; it forms no opinions of its own. No heuristic "this looks suspicious" judgments — that would be the guard authoring policy — so, no anomaly detection.
- **No egress.** The guard makes no network calls and ships no telemetry. Your payment data never leaves your machine. Absent, not opt-out. Read APIs like `snapshot()` are **pull, not push** — an in-process, owner-only view you request locally, never a sender; the guard is a data *source you control*. The copy it hands back is your private financial posture (including who you pay) — treat it with the same care as the ledger file.
- **Trust model: your isolation boundary.** The guard is as secure as the container, sandbox, or VM it runs inside, and assumes no hostile process shares that boundary — one that does can read the signing key and defeat any in-process guard. Enforcement (caps, allowlist, binding, kill switch) is platform-agnostic and always on. At-rest hardening (file permissions, and a tamper-evident audit log) is *opportunistic* — a bonus layer where your platform supports one, never a substitute for the isolation boundary, and never a pretense of protection where it can't be delivered — **one true statement on every OS.** A genuinely shared multi-user host wants a hardened store, which the topology-agnostic store interface lets you supply — see [THREAT_MODEL.md](THREAT_MODEL.md).
- **Small, auditable core.** The security-critical logic is a pure function with zero runtime dependencies — small enough to read in one sitting.

## Supply chain & capabilities

**Zero runtime dependencies.** The published tarball is `dist` only — compiled JS and type declarations, no source, no maps, no bundled code. `@x402/core` and `@x402/evm` are *optional* peer dependencies you already run to make x402 payments; the guard structurally matches their types and imports **neither at runtime**. So a bare `npm install x402-spendguard` pulls in nothing else, and none of the x402 SDK's transitive tree (viem, etc.) is ours.

A capability scanner (e.g. [Socket](https://socket.dev)) run against our own code will still flag two capabilities. Both are real, both are the product working as designed, and neither is network egress:

- **Filesystem access** — by design. The spend ledger, the policy file, and the tamper-evident decision log are on local disk (`node:fs`). That is where cumulative caps and the audit trail live; there is nowhere else to keep them. The ledger is created **owner-private** (`0o600`) and reads only *your* files. Crucially, **there is no network capability paired with it** — nothing can exfiltrate what it reads.
- **Network access** — real, but a *veto, not a caller.* The guard **wraps the `fetch` transport your client already uses** so it can see a 402 and record which host you chose to call, then enforce your caps before a payment is signed. It reads only the response `status` and passes the response through unchanged (`guardedFetch`, [src/adapters/x402-transport.ts](src/adapters/x402-transport.ts)); it also uses the `URL` constructor to parse a hostname for allowlist matching. It imports no network module and **originates no request of its own** — wrapping the transport is the entire mechanism of a firewall.

This is the same claim as **No egress** above, stated at the level a scanner sees. Don't take our word for it — [read the code](src/); it's small on purpose.

## Documentation

- **[THREAT_MODEL.md](THREAT_MODEL.md)** — adversaries, assets, trust boundary, and what we do and do not defend.
- **[REQUIREMENTS.md](REQUIREMENTS.md)** — numbered, testable requirements, each traced to a threat and a test.
- **[TRACEABILITY.md](TRACEABILITY.md)** — the requirements-traceability matrix: every requirement → its verifying test(s) → status. Generated from the suite (`npm run traceability`) and CI-checked so it can't drift.
- **[TEST_PLAN.md](TEST_PLAN.md)** — testing methodology: how we prove the requirements hold.
- **[docs/reason-codes.md](docs/reason-codes.md)** — the deny-reason legend: every code the guard emits, what it means, and what to change — grouped by where you hit it. Generated from the code, CI-checked so it can't drift.
- **[policy.example.json](policy.example.json)** — the annotated starter policy (also shipped in code as `STARTER_POLICY_JSON`); every field, with fail-loud placeholders.
- **[SECURITY.md](SECURITY.md)** — how to report a vulnerability, and our disclosure commitment.
- **[docs/verifying-releases.md](docs/verifying-releases.md)** — how to independently verify a release's signed build provenance attestation (and a heads-up about a false alarm from older npm).
- **[docs/decisions.md](docs/decisions.md)** — the decision record: what we chose, why, and what we rejected.
- **[docs/roadmap.md](docs/roadmap.md)** — tracked future work and deferrals, each with its rationale and gate.
- **[docs/x402-protocol-notes.md](docs/x402-protocol-notes.md)** — the x402 protocol facts a guard depends on, verified against source.
- **[docs/prior-art.md](docs/prior-art.md)** — existing x402 guards, read at the source level, credited and compared.

## Authorship

This project is built by a human and an AI working together — Kevin Brown, with Claude. We say so plainly because you are being asked to trust a security tool, and you should know how it was made.

The security-critical core is deliberately small — a pure function, zero runtime dependencies — **specifically so that a human can read all of it.** That is the point of the size limit, not a coincidence of it. Every claim this project makes about the x402 protocol was verified against the protocol's source rather than from an AI's recollection; we found, more than once, that the recollection was wrong. The reasoning behind every design decision is written down in [docs/decisions.md](docs/decisions.md) so you can check the argument, not just the conclusion.

Read the code. That has always been the deal with a guard.

## Status

**`v0.2.1` — on [npm](https://www.npmjs.com/package/x402-spendguard): `npm install x402-spendguard`, published from CI (tokenless OIDC) with a signed build provenance attestation.** The guard installs in front of a real `@x402` client and enforces at the moment a payment is signed.

**Recent highlights (0.2.x):** first release to npm; the property-test layer landed (mutation-proven); and a **P0 cross-process over-allow, found before publish, was fixed** (ACCT-07; postmortem in [TEST_PLAN.md](TEST_PLAN.md) §9).

Still **pre-alpha** (`0.x`): single-agent, testnet-validated, single-tenant trust model (see [THREAT_MODEL.md](THREAT_MODEL.md)). **Not for mainnet.** Zero runtime dependencies; `@x402` is an optional peer dependency.

## What's proven — live and in the automated test suite

- **Both x402 generations** (v1 and v2) — one guard, dispatched on the protocol version.
- **Deny works in the wild** — a real `@x402` client driven through a genuine 402 is blocked on kill-switch / off-allowlist / over-cap, and reaches a signature *only* through the guarded (allowlist) route.
- **Allow settles** — a policy-compliant payment, signed through the guard, is verified and settled **on-chain** by a real facilitator. Validated live on **Base Sepolia** (real USDC, real transaction) — reproducible with a throwaway key and faucet USDC ([`test/e2e/FUNDED.md`](test/e2e/FUNDED.md)).
- **Cross-process spend integrity** — two processes on one wallet's ledger can't both pass a cap they jointly exceed; validated across real separate OS processes (same host).
- **`snapshot()` read API** — a read-only, pull view of current spend vs. caps for a local dashboard; never transmits.
- **Tamper-evident audit log** — the decision log is a hash chain you can `verify()`; unkeyed by default, keyed HMAC if you supply a key.
- **Owner-private, tamper-refusing at rest** — the ledger is created `0o600` and refuses a world-writable file (Windows-guarded).
- **Property-tested enforcement core** — nine `fast-check` property tests covering eight invariants (no-drain, fail-closed fuzzing, binding soundness, same-asset accounting, clock monotonicity, determinism, reason-code observability, hash-chain tamper-detection), each confirmed non-vacuous by mutation.
- **Frozen, zero-dependency artifact** — a single frozen public entry point (`import { … } from "x402-spendguard"`), a `dist`-only build with zero runtime dependencies and a build provenance attestation you can verify ([how to verify](docs/verifying-releases.md)).

## Configuring the guard

The guard enforces *your* policy and holds no opinions of its own. A policy is a JSON file: a kill switch, a destination **allowlist**, and per-denomination **caps** — plus a few operational fields. The full annotated shape is [`policy.example.json`](policy.example.json).

**1. Start from the shipped template.** It fails loud until you edit it, so you can't accidentally run a misconfigured guard:

```ts
import { writeStarterPolicy } from "x402-spendguard";
await writeStarterPolicy("./policy.json"); // owner-only (0600); refuses to overwrite an existing file
```

(Or copy [`policy.example.json`](policy.example.json).)

**2. Replace the placeholders.** Each `REPLACE_WITH_…` value must be edited — **including the `0x` prefix on addresses**: replace the whole `0xREPLACE_WITH_YOUR_PAYEE_ADDRESS`, not just the part after `0x`, or you'll be left with a stray `0x`. Caps are in the token's **base units** (USDC has 6 decimals, so `"5000000"` = 5 USDC). The `caps` key is a `chain|token` coordinate — build it with `assetKey({ chain, token })` rather than hand-concatenating it.

**3. Validate it — and read your caps back in human units.** This is the check on the one authoring mistake that fails *open*: an off-by-a-zero cap the guard would faithfully enforce. Declare each denomination's `decimals`/`symbol` in an optional `display` section and the echo renders the cap the way you meant it:

```ts
import { readFileSync } from "node:fs";
import { loadPolicyFile, parseDisplay, describePolicy } from "x402-spendguard";
const loaded = loadPolicyFile("./policy.json");
if (!loaded.ok) throw new Error(`policy invalid [${loaded.reason}]: ${loaded.detail}`);
const display = parseDisplay(JSON.parse(readFileSync("./policy.json", "utf8")));
const desc = describePolicy(loaded.value, display.ok ? display.value : undefined);
// desc.denominations[0].perRequest.human === "50.000000 USDC"  ← if you meant 5, the extra zero is obvious
```

From the repo you can run the same check as a one-liner: `npx vite-node scripts/validate-policy.ts ./policy.json`.

**4. When a payment is denied, the reason says why.** Every decision carries a stable code; look it up in the **[reason-code legend](docs/reason-codes.md)** — it says what each code means and what to change, and which denials are *correct* rather than misconfigurations (e.g. `bind.amount_mismatch` is a tampered payment, not a setting to fix).

## Wiring it in

The guard interposes at the three points an x402 client exposes, through one binding — the veto happens at the signer, where the *real* struct about to be signed is visible. A complete setup, from policy file to wired client:

```ts
import {
  loadPolicyFile, FileSpendStore, systemClock, SpendGuard, createSpendGuardBinding,
} from "x402-spendguard";

// 1. Load your policy (fails closed on a bad, unreadable, or world-writable file).
const loaded = loadPolicyFile("./policy.json");
if (!loaded.ok) throw new Error(`policy invalid [${loaded.reason}]: ${loaded.detail}`);

// 2. Build the guard over a durable, cross-process-safe ledger.
const store = new FileSpendStore("./ledger", systemClock.now());
const guard = new SpendGuard(store, systemClock, loaded.value);

// 3. Bind it to the three x402 interposition points.
const binding = createSpendGuardBinding(guard);
registerExactEvmScheme(client, { signer: binding.wrapSigner(signer) }); // veto at signing — wire this FIRST
client.onBeforePaymentCreation(binding.hook);                            // capture the offer
const guardedFetch = binding.wrapFetch(globalThis.fetch);               // capture the real request origin
```

`wrapSigner` is the veto and the one wire that fails *open* if you forget it — wire it first. More runnable examples are in [`examples/`](examples/); the full hermetic deny path and a live funded settle are in [`test/e2e/`](test/e2e/).

```bash
npm install
npm test          # the hermetic suite (no network, no funds)
```

## License

MIT (open-core: the guard is and stays free/open; a hosted version + dashboard may come later).
