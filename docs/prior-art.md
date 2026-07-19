# Prior Art — existing x402 spend guards

**Point of contact:** Kevin Brown, x402.spendguard@gmail.com
**Why this document exists:** an open-source security tool owes its users an honest account of what already exists, what those tools do well, and where this one differs. Building "the same thing again" without saying so would be dishonest; claiming novelty we do not have would be worse.

**Method and fairness note.** The characterizations below come from **reading the published source**, not READMEs or marketing — twice during our research that distinction changed the conclusion. Findings are **pinned to a version and a date**; software changes, and any of this may be out of date by the time you read it. We have tried to state verifiable, architectural facts and to credit what each project does well. If we have any of it wrong, please write to the address above and we will correct it. Nothing here is intended as disparagement; these are real projects solving hard problems, and one of them is genuinely excellent.

---

## `presidio-hardened-x402` (Python) — a serious tool, and the one to learn from

*Read at HEAD, 2026-07-09. MIT. ~v0.9.0.*

This is careful security engineering, and we want to say so plainly. From source, it demonstrates: correct time-of-check/time-of-use reasoning with a single lock spanning check-and-record; speculative-commit-with-rollback across the async signer boundary; a correct DNS-rebinding SSRF defense that resolves and pins the connection IP while preserving SNI; HMAC-authenticated outbound webhooks; fail-closed startup gates; and adversarial tests that stand up hostile 402 servers and assert that the signer is never invoked. It makes no network calls of its own by default. It is well above the median "security wrapper."

**What it genuinely solves** (and we do not intend to rebuild): pre-signing policy on the *offer* amount (per-call, rolling-window, per-endpoint) with correct concurrency; PII redaction of server-controlled metadata, robust to homoglyph/zero-width evasion; a wallet-substitution defense via a per-origin `pay_to` allowlist checked before signing; a duplicate-*submission* replay guard (atomic test-and-set, with a Redis option); secret/PII non-leakage on the error path; multi-party approval with SSRF-hardened webhooks; and a tamper-evident audit log.

**Where it structurally stops** — and this is a property of *where it sits*, not a criticism of its quality. Its data model is the server's **offer** (`resource_url, pay_to, amount, currency, network, deadline`). It has no field for a nonce, `validBefore`, `chainId`, or the signed authorization, because signing is a user-supplied callback it invokes and never inspects. It wraps the HTTP transport and screens the **challenge**. Therefore it checks *what the server asked for*, and cannot check *what the wallet actually signed*. The consequences, all following from that one fact:

- No binding between the screened offer and the signed payload. Overpayment (`value` exceeding the offer), `validBefore` unbounded by `maxTimeoutSeconds`, and the asset/chainId of the actual signature are not checked — the library screens `maxAmountRequired` while the wallet remains free to sign a different `value`.
- Spend accounting is in-memory and per-process; caps reset on restart, and multiple workers share no ledger.
- Caps are a single USD figure with the peg assumed for a stablecoin allowlist, not denominated per `(asset, chain)`; one float touches money en route to an otherwise-`Decimal` ledger.
- Several of its strongest guarantees (shared replay-fingerprint key, persistent audit-chain key, decision records, multi-party approval) are opt-in and off by default.

Its own documentation is honest about the first point — a module docstring concedes the decision record binds provenance, not the signature.

## `@x402sentinel/x402` (TypeScript, "Sentinel" by Valeo) — an observability wrapper

*Read at v0.2.0, 2026-07-09. MIT.*

We looked hard at this one because it is the closest TypeScript analogue by name. From source, its architecture places it **outside** the payment: `wrapWithSentinel` wraps the *output* of x402's payment-enabled fetch, so the 402→sign→retry→200 sequence happens inside a single call it does not see into. It observes the completed `200` — after the money has moved — and records the spend. Specific, checkable consequences at that version:

- Its pre-request check runs with the amount hardcoded to zero (the price is unknown before the request), so per-call, spike, and projected-spend checks evaluate against zero; a test in the repo documents this. Its shipped framework adapters wrap the raw global `fetch`, which does not pay.
- On a malformed 402 header it continues rather than denying (fails open on the enforcement path; configuration validation at construction does throw).
- Caps are a single USDC figure assuming six decimals for every asset, so an 18-decimal token is mis-valued. There is no `payTo` allowlist; the "allowlist" globs the request URL.
- The zero-config path posts audit records — payer address, payee address, transaction hash, amount, asset, network — to a vendor endpoint with the key `"anonymous"`, by default.

**Worth borrowing, credited:** its `bigint` money module is clean and correct, and its principle that *audit must never block the caller* is right — a distinction we adopt explicitly (our FAIL-03: audit failures must not flip a decision; enforcement failures must deny).

*(If Sentinel has changed materially since v0.2.0, this section is out of date — corrections welcome.)*

## Ecosystem-scope attacks are out of this tool's scope

Much of the x402 attack surface lives at the **protocol and ecosystem layers** — server, facilitator, discovery, chain, and economic — which a client-side guard structurally cannot reach (see [THREAT_MODEL.md §5a](../THREAT_MODEL.md#5a-which-documented-x402-attacks-are-in-scope) for the in-scope/out-of-scope mapping). We scope to the wallet's edge and leave those layers to the parties that own them.

One ecosystem-layer claim is worth flagging: that x402's Permit2 path binds the *resource* on-chain. Checked against source, it binds the *receiver* (which EIP-3009 also does), not the resource — so our pre-sign binding checks remain necessary on that path (see [x402-protocol-notes.md §4](x402-protocol-notes.md#4-permit2-does-not-close-the-resource-gap)). We note it in the spirit of checking claims against source.

---

## How this project relates

The projects above **screen the offer** — they interpose on the HTTP transport and evaluate the server's challenge. This project interposes at the **signer**, evaluating the `TransferWithAuthorization` struct before it is signed. Offer-screening and signature-screening inspect different objects at different points; layered, they cover more than either alone — **complementary, not competing.**

A full description of what this guard does, and the limits it holds itself to, belongs in self-description rather than in a survey of others: see the [README](../README.md) and [THREAT_MODEL.md](../THREAT_MODEL.md).

---

*Corrections welcome at the contact above.*
