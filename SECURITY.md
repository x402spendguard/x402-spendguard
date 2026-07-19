# Security Policy

**Contact:** Kevin Brown — **x402.spendguard@gmail.com**

## Status: pre-alpha — please do not rely on this yet

This project is under active development. The full guard is implemented — policy engine, spend accounting, decision log, and the payment-interception adapter that vetoes at the signer — and it is **testnet-validated**: driven by a real `@x402` client, it blocks non-compliant payments and settles compliant ones on-chain (Base Sepolia, real USDC). But it is **pre-alpha** — single-agent, single-tenant, **not for mainnet.** Do not place it between an agent and a wallet holding funds you care about.

## Reporting a vulnerability

**Email the address above. Please do not open a public issue for a security bug.**

Include what you found, how to reproduce it, and what you think the impact is. A proof of concept helps enormously.

- We aim to **acknowledge within 5 business days.**
- This is a two-person project. We do **not** commit to a fixed remediation deadline, but we will keep you informed of progress.
- There is **no bug bounty** — we cannot pay. We will credit you by name unless you'd rather we didn't.
- We will not pursue legal action against good-faith security research conducted against your own systems and funds.

## Our disclosure commitment

**Fix, release, then publish the finding in full — including flaws we introduced ourselves.**

The coordination is about *timing*, measured in days, not about keeping anything. We will not quietly patch a security bug and say nothing. If this guard fails in a way that could have cost someone money, that failure gets written up publicly, with the reasoning, once users have a fix available.

A guard's value is that you can check it. That obligation does not pause when the news is bad.

## In scope

- The policy engine and its checks.
- Spend accounting, the decision log, configuration loading.
- The interception adapter — the guarded signer and the transport wrap.
- **Any case where the guard *allows* a payment the user's policy should have denied.** This is the core failure mode.
- **Any case where the guard fails open** — an exception, a malformed input, or an unreachable store that results in `allow` rather than `deny`.
- Any case where the guard **leaks the signed payment payload**, the payment header, or user data. The signed payload is a bearer capability; writing it anywhere is a vulnerability.
- **Any case where the guard touches key material at all.** The guard never holds keys or funds. If you find it doing so, that is critical — report it immediately.

## Not vulnerabilities — documented non-goals

These are stated in [THREAT_MODEL.md §6](THREAT_MODEL.md#6-non-goals). Discussion is welcome, but they are known, intentional, and not bugs:

- **The guard can be bypassed by an agent whose code an attacker controls.** It is a seatbelt, not a wall — it gives visibility into what is about to be signed, not authority over whether it is signed. No in-process guard can do otherwise.
- **The guard does not defend the resource server, the facilitator, or the chain.** Replay-to-many-grants, settlement front-running, reorg revert-grant, CDN cache leakage, and denial of settlement are real x402 attacks that a client-side spend guard structurally cannot address. See [THREAT_MODEL.md §5a](THREAT_MODEL.md#5a-which-documented-x402-attacks-are-in-scope).
- **The guard does not protect a user from their own policy.** It enforces policy; it does not author or evaluate it. A loss inside the limits you configured is the guard working as specified.
- **The guard does nothing after settlement.** Settlement is irreversible; that is the premise of the tool.
- **The guard assumes TLS.** Without it, the 402 challenge is rewritten before the guard ever sees it.
- **The guard performs no anomaly detection.** Heuristic "this looks suspicious" judgments would be the guard authoring policy. Its absence is a design decision, not an oversight.

## Vulnerabilities in x402 itself

If you find a flaw in the x402 protocol or its SDKs, please report it to the [x402 Foundation](https://github.com/x402-foundation/x402), not to us. If it changes how this guard *should* behave, we'd be grateful if you told us too — our reading of the protocol is documented in [docs/x402-protocol-notes.md](docs/x402-protocol-notes.md) and may be wrong.
