# x402-spendguard — Requirements (v1)

**Point of contact:** Kevin Brown, x402.spendguard@gmail.com
**Status:** Pre-alpha. Requirements for the **v1** guard (anti-drain + signature integrity).
**Companion:** derived from and traceable to [THREAT_MODEL.md](THREAT_MODEL.md).

---

## How these requirements work

Each requirement is:
- a **single falsifiable assertion**,
- tagged to a **build** (all are `[v1]` unless noted),
- traced to the **threat(s)** it answers (see [THREAT_MODEL.md §5](THREAT_MODEL.md#5-threats--controls)),
- and paired with the **name of the test** that proves it.

**A requirement that cannot name a test is not a requirement** — it is an open question, and it lives in [§ Open questions](#open-questions) below rather than getting an ID it has not earned. A future traceability test asserts that every `[v1]` requirement here is named by some test in the suite; a requirement without a test turns the suite red.

**Governing principle — mechanism, not policy.** Every requirement below enforces a rule the *user* authored, deterministically. None of them require the guard to form its own judgment about what is "suspicious." A control that would require such a judgment (e.g. statistical anomaly detection) is out of scope by principle, not by schedule — see [THREAT_MODEL.md §6](THREAT_MODEL.md#6-non-goals).

---

## Kill switch

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **HALT-01** | When `policy.halt` is true, `evaluate()` returns **deny** for every input, including otherwise-valid payments. | T13 | `halt-denies-valid` |

## Destination allowlist

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **ALLOW-01** | If the allowlist is non-empty and the payment's `payTo` is not present, **deny**. | T1 | `allowlist-blocks-unlisted` |
| **ALLOW-02** | The allowlist is keyed on **(address, chain)**; the address is compared case-insensitively; the chain is not normalized away. | T1 | `allowlist-same-address-wrong-chain-denied` |
| **ALLOW-03** | An **empty** allowlist denies all payments (secure by default — the user opts destinations *in*, rather than opting danger *out*). | T1 | `empty-allowlist-denies-all` |

## Signature-integrity binding

The guard compares the challenge it received against the authorization about to be signed. See [THREAT_MODEL.md §5, "the binding checks deserve their honest justification"](THREAT_MODEL.md#the-binding-checks-deserve-their-honest-justification).

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **BIND-01** | For scheme `exact`: **deny** unless the signed `value` equals the challenge `amount` exactly (rejects both over- and under-payment; note v1 facilitators accept `value ≥ amount`). | T2, T5 | `bind-rejects-overpayment` |
| **BIND-02** | **Deny** unless the signed `to` equals the challenge `payTo` (after canonicalization). | T1 | `bind-rejects-recipient-swap` |
| **BIND-03** | **Deny** unless `validBefore ≤ now + maxTimeoutSeconds + skew`. (Facilitators do not enforce this bound; the guard does.) | T6 | `bind-rejects-long-lived-auth` |
| **BIND-04** | **Deny** unless the signed asset (`verifyingContract`) and `chainId` match the challenge's declared asset and network. | T7 | `bind-rejects-asset-mismatch` |
| **BIND-05** | A non-`exact` scheme (e.g. `upto`, `auth-capture`) is **denied** with a stable reason. (`upto` is deferred to v2; see note.) | T2 | `nonexact-scheme-denied` |
| **SCOPE-01** | A payment whose authorization form is not `eip3009-evm` (e.g. Solana/SVM) is **denied at parse** with a stable reason. v1 is EVM-only (D-017). | T2 | `nonevm-form-denied` |

> **v2 note (`upto`).** `upto` signs a *maximum*; the resource server sets the actual charge (0 → max) after consumption, and the client cannot constrain it below the max. When v2 adds `upto`, the rule is: cap against the signed maximum, bind `to == payTo`, bound the deadline, and **disclose to the user that the server may charge up to the maximum.**

## Spend caps

All caps are denominated per **(asset, chain)** and compared in integer smallest-units.

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **CAP-01** | Per-request: if `amount > cap[(asset, chain)]`, **deny**. | T2 | `cap-per-request-boundary` |
| **CAP-02** | Per-domain cumulative: if `domainSpent + amount > perDomainCap`, **deny**. | T3 | `cap-per-domain` |
| **CAP-03** | Global cumulative: if `globalSpent + amount > globalCap`, **deny**. | T4 | `cap-global` |
| **CAP-04** | Amounts of differing `(asset, chain)` are **never** summed into one cap. | T7 | `cap-no-cross-asset-sum` |
| **CAP-05** | A payment in an `(asset, chain)` with **no configured cap** is **denied** (missing cap = deny, fail-closed). | T2, T7 | `cap-asset-unconfigured` |

> **Per-denomination global.** There is no cross-asset "global dollar" cap. Summing USDC and another token into one ceiling would need a price oracle — which means network egress (violates PRIV-01) and the guard forming an opinion about value (violates the mechanism-not-policy razor). So the `global` cap is **per `(asset, chain)` denomination** (e.g. a USDC-on-Base budget), stated loudly because it surprises users who expect a dollar ceiling.

## Money representation

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **MONEY-01** | All amounts are integer smallest-units (`bigint`); the parser rejects negative, non-integer, `NaN`/`Infinity`, and out-of-decimal-range values; **no floating-point value ever touches an amount**. | T2, T7 | `money-rejects-malformed`, `money-precision-exact` |

## Fail closed

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **FAIL-01** | Any thrown exception on the enforcement path results in **deny**. | T8 | `throwing-check-denies` |
| **FAIL-02** | A missing or malformed field in the challenge or payment results in **deny** — never a skipped check. | T8 | `malformed-challenge-denies` |
| **PARSE-01** | Malformed input is denied with a **specific parse reason code** (e.g. `parse.amount_negative`, `scheme.unsupported`), never the generic `engine.error` backstop. Malformed input is *expected*, not a bug. | T8 | `parse-failure-specific-reason` |
| **FAIL-03** | An audit/log write failure does **not** flip an allow to a deny or a deny to an allow; but a failure to durably record a *spend* before the payment is released results in **deny** (see ACCT-01). | T8, T10 | `audit-failure-preserves-decision`, `spend-record-failure-denies` |

> The FAIL-03 split — *enforcement failures must deny; audit failures must not* — is deliberate. "A decision the guard already made must not be undone by a record of it." (Pattern adopted from presidio-hardened-x402; see [prior-art.md](docs/prior-art.md).)

## Spend accounting

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **ACCT-01** | Spend is recorded **write-ahead**, before the payment is released; a crash between record and settlement must never *under-count*. | T10 | `crash-between-record-and-settle-does-not-undercount` |
| **ACCT-02** | **Within a single guard instance/process,** evaluation is serialized (single-writer): two concurrent `authorize()` calls cannot both pass a cap they jointly exceed. | T9 | `concurrent-payments-cannot-both-pass` |
| **ACCT-03** | Spend state is durable across a process restart. | T3, T4 | `state-survives-restart` |
| **CLOCK-01** | A clock anomaly must never increase available budget or extend a capability: a backward jump must not reset a spend window; a forward jump must not manufacture fresh budget. Clock weirdness fails toward **deny**. | T9 | `clock-anomaly-fails-closed` |

> Durable, single-writer, crash-safe spend accounting is, to our knowledge, **unsolved in the existing tools we read** (both keep spend in per-process memory). It is genuinely open ground and one of the harder parts of v1.

> **KNOWN LIMITATION — cross-process (flagged by external review, 2026-07-10).** ACCT-02's single-writer guarantee holds *within one process*. The bundled `FileSpendStore` uses atomic writes but **no cross-process lock**, so two processes sharing one ledger file (e.g. two agent workers, one wallet) can both load pre-spend state, both pass a cap, and both write last-write-wins — which **under-counts and silently bypasses the cap**, in the money-losing direction. Until this is closed, **run one guard instance per wallet.** The real fix (an OS/advisory-locked or compare-and-swap store providing cross-process single-writer) is tracked as **ACCT-05** below; its build-vs-defer timing is an open decision.

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **ACCT-05** | A spend store shared across processes is serialized (cross-process single-writer): two processes cannot both pass a cap they jointly exceed. | T9 | `cross-process-cannot-both-pass` |

> ACCT-05 is **not yet met** — it is an honest open requirement, not a shipped guarantee (see `test/deferred.test.ts`). It exists so the limitation cannot hide.

## Privacy and egress

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **PRIV-01** | The core makes no network calls; a static check fails the build if the core can import a socket-capable module. | T12 | `core-has-no-egress` |
| **PRIV-02** | The decision log never contains the signed authorization or the payment header (both are bearer capabilities). | T11 | `log-never-contains-signature` |
| **PRIV-03** | No telemetry. Absent, not opt-out. | T12 | `no-telemetry-calls` |

## Domain derivation

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **DOM-01** | The domain a budget is keyed on comes from the **client-observed request origin** (the origin that actually received the 402, after redirects), **never** from a server-controlled challenge field such as `resource`. | T14 | `domain-derivation-ignores-redirect` |

## Configuration integrity

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **CONF-01** | The guard refuses to load a world-writable `policy.yaml` (a deterministic startup gate — mechanism, not judgment). | T15 | `rejects-world-writable-policy` |

> CONF-01 is the *only* defense v1 offers against policy-file tampering (T15/A8). Full policy-file integrity against an attacker with host write access is A5-adjacent and out of scope; policy integrity otherwise rests on filesystem permissions the user controls.

## Core hygiene

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **CORE-01** | `evaluate()` is pure: identical `(payment, challenge, policy, state)` yields an identical decision; no I/O in the core. | (design) | `core-is-pure` |
| **DEP-01** | The core has **zero** runtime dependencies. | (supply chain) | `core-zero-deps` |
| **OBS-01** | Every decision carries a stable, machine-readable reason code. | (design) | `every-decision-has-reason` |

## Testability — stated as requirements, not aspirations

"Testability" is not falsifiable and therefore cannot itself be a requirement. The concrete properties that *produce* it are — and they are **design requirements**, because a guard whose fail-closed and accounting behavior cannot be tested cannot be trusted. See [TEST_PLAN.md](TEST_PLAN.md).

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **INJ-01** | The clock and the spend-state store are **injected dependencies** at every layer that uses them. No module outside the composition root reads a wall clock or opens a store ambiently. | (enables CLOCK-01, ACCT-01/02/03) | `no-ambient-clock-or-store` |

**CORE-01** (purity) and **PRIV-01** (no egress, statically checked) are testability requirements too: purity is what makes the security-critical logic exhaustively testable without mocks, and a static egress check is what makes "no telemetry" *provable* rather than promised.

## No policy in the guard (D-018)

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **POL-01** | The enforcement path contains **no security-deciding literal** — every threshold, list, and tolerance is read from `Policy`. Shipped defaults (clock skew, the cross-origin flag) live in a **readable default policy file**, never as constants in code. | (mechanism-not-policy) | `no-deciding-literals-in-core` |

A reader of the guard's enforcement code should find zero numbers that decide an outcome. This is the code-level form of "policy belongs in userspace": the guard is a pure *interpreter* of policy, and every opinion is visible in one auditable file. Not policy, and correctly in the guard: the binding/integrity checks, fail-closed behavior, and the coordinate system (units, the `(asset, chain)` key, the domain rule).

Without INJ-01, CLOCK-01 and the accounting requirements are **unfalsifiable** — an accounting module that read the wall clock ambiently would satisfy every other requirement in this document while being untestable. This requirement exists because testability, decided late, is the most expensive bolt-on of all: it is not a property you can add to code, only one you can design into it.

---

## Open questions

Not yet requirements — they have no test they can name, or they await a design decision.

- **OQ (adapter correlation).** How the adapter presents both the challenge and the to-be-signed struct to `evaluate()` at one point (ASM3). Determines whether the binding checks are strong or degrade to internal-consistency-only. Blocks the adapter slice, not the pure core.
- **OQ (skew tolerance).** The exact `skew` value in BIND-03, and whether window resets may trust wall-clock time at all beyond the CLOCK-01 fail-safe direction.

## Deferred (post-v1, with rationale)

- **Rate / velocity cap** — a user-configured deterministic "at most N payments (or M spend) per short window." Legitimate mechanism (survives the mechanism-not-policy razor); the same shape as the spend caps. Deferred as a fast-follow cap dimension, not v1 core.
- **`upto` scheme support** — v2 (see BIND-05 note). Aligns with `upto` being a v2-only protocol scheme.
- **Enforcement rungs beyond the seatbelt** — a key-holding local daemon (enforceable against a compromised agent, without us holding keys) and integration with on-chain delegation (ERC-7710). These raise the enforcement ceiling; v1 does not.

---

*Provided as-is, without warranty. v1 is an anti-drain and signature-integrity guard, not complete x402 security.*
