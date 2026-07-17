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
| **BIND-03** | **Deny** unless `validBefore ≤ now + min(server maxTimeoutSeconds, policy maxAuthLifetimeSeconds) + skew`. The challenge's `maxTimeoutSeconds` is *server-controlled and untrusted* (a malicious server sets it huge), so the **policy-authored** `maxAuthLifetimeSeconds` is the real ceiling — the server can only shorten the window, never extend it. | T6 | `bind-rejects-long-lived-auth` |
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
| **CLOCK-01** | A **backward** clock jump must never reset a spend window or un-count spend — time is viewed monotonically (`max(now, lastSeen)`). | T9 | `clock-anomaly-fails-closed` |

> **CLOCK-01 scope (corrected for honesty, 2026-07-10).** This requirement guarantees only the **backward** direction, which a pure function *can* deliver. It does **not** claim to stop a **forward** wall-clock jump: an attacker with host control over the clock (A5) can fast-forward past a window boundary and force an early rollover = fresh budget. A pure function cannot distinguish that from legitimate time passage without a trusted time source, so it is **out of scope (A5)** and characterized by the test `forward-jump-manufactures-budget`. The earlier wording ("a forward jump must not manufacture fresh budget") over-claimed relative to the code; an external review caught it, and the claim now matches reality.

> Durable, single-writer, crash-safe spend accounting is, to our knowledge, **unsolved in the existing tools we read** (both keep spend in per-process memory). It is genuinely open ground and one of the harder parts of v1.

> **CROSS-PROCESS (ACCT-05, now MET — D-031).** ACCT-02's single-writer guarantee holds *within one process*; **ACCT-05 extends single-writer across processes** via a versioned **compare-and-swap** store. A losing writer is *told* it lost (a detected conflict, not a silent last-write-wins overwrite) and re-evaluates against fresh state — collapsing the two scopes into one mechanism. The store **refuses to run** on a filesystem it can't prove honors concurrent atomic exclusive-create (`store.unverified`, fail-closed), so an unsupported topology fails *loud*, not silently. *Validation note:* the CAS logic is proven; a genuine **two-process (ideally two-host)** run on your target filesystem is the final check before relying on it in a multi-process deployment (see [design note](docs/design-acct-05-cas-store.md)).

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **ACCT-05** | A spend store shared across processes is serialized (cross-process single-writer): two processes cannot both pass a cap they jointly exceed. | T9 | `cross-process-cannot-both-pass` |
| **ACCT-06** | The durable spend ledger is **refused if world-writable** (fail-closed) — its permissions are checked **before** its bytes are trusted, so a locally-tampered ledger cannot silently reset spend (→ drain). The mirror of CONF-01 for the store; scoped to the world-write bit only (not group, not owner): mechanism, not judgment. | T15 | `ledger-refuses-world-writable` |

> **ACCT-06 scope (honest, L2/D-034).** Scoped to the world-write bit on the ledger **file**, exactly like CONF-01 on `policy.json`. A world-writable ledger **directory** (where an attacker could plant a forged higher-version file) is a broader vector that applies equally to the policy file — CONF-01 does not check it either — and is deferred to a future *uniform* directory-permission pass rather than half-addressed here. Full integrity against an attacker with host write access is A5-adjacent and out of scope; ledger integrity otherwise rests on filesystem permissions the user controls. POSIX-only (see the shared file-permission-gates note under CONF-01).

> ACCT-05 is **MET (D-031):** the versioned compare-and-swap `FileSpendStore` (`link()`-based atomic create-or-`EEXIST`) + the guard's bounded, fail-closed CAS retry loop. Tests: `cross-process-cannot-both-pass` (accounting.test.ts) plus the CAS suite (cas-store.test.ts: exhaustion→deny, the concurrent-exclusive-create probe refusing a broken filesystem, and real `link()` stale-version rejection).

## Privacy and egress

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **PRIV-01** | The core makes no network calls; a static check fails the build if the core can import a socket-capable module. | T12 | `core-has-no-egress` |
| **PRIV-02** | The decision log never contains the signed authorization or the payment header (both are bearer capabilities). | T11 | `log-never-contains-signature` |
| **PRIV-03** | No telemetry. Absent, not opt-out. | T12 | `no-telemetry-calls` |
| **PRIV-04** | The spend ledger is created **owner-private (`0o600`)** — spend amounts, origins, and the counterparty graph are private payment data (the same footing as the decision log's owner-only creation). Applies on **creation** only; a pre-existing file keeps its own mode (user-controlled, like CONF-01). | T12 | `ledger-created-owner-private` |

## Audit log integrity (tamper-evidence)

The decision log is the forensic record (AS3) and the read-API's tightest rung. Its integrity is **tamper-*evidence* (detection), not tamper-*prevention*** — and, per FAIL-03, an audit-integrity failure is **forensic, never enforcement**: it surfaces loudly and never gates a payment (so it can never become a DoS). Consistent with the trust model ([THREAT_MODEL.md](THREAT_MODEL.md) §3): opportunistic hardening through a seam, honest about its limits.

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **AUDIT-01** | The log is a **hash chain** — each record commits to its `seq`, the prior record's hash, and the entry contents; `verify()` detects a link-breaking edit, reorder, or mid-delete. **Self-verification is anchor-relative:** without an external `expectedHead` it catches non-adversarial corruption and naive edits, **not** a full self-consistent rewrite (by design — that needs the anchor or keyed mode). The contract carries this in its signature (`verify({expectedHead?})`), so it cannot be silently overclaimed. | (design) | `chain-detects-tamper`, `verify-is-anchor-relative` |
| **AUDIT-02** | The integrity primitive is an **injected seam** (`ChainHasher`): default unkeyed SHA-256 (corruption + naive-tamper + export-verify against a pinned head), pluggable to keyed **HMAC** (forgery-resistant to an attacker without the key) with **no core change**. | (design) | `keyed-chain-detects-forgery` |
| **AUDIT-03** | An audit-integrity failure — a failed append **or** a torn head at startup — **surfaces to the operator** (injected `onAuditFailure`) and **never flips a verdict** (FAIL-03). A torn head fails **loud** and starts a fresh genesis whose discontinuity is **visible in `verify()`** (never a silent clean slate). In-process appends are serialized (synchronous single-writer) into a linear chain; a cross-process fork is **detected** by `verify()`, not silently merged (CAS-for-the-log is a fast-follow). | (design) | `audit-failure-surfaced-not-swallowed`, `torn-head-fails-loud`, `concurrent-appends-linear-chain` |

## Domain derivation

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **DOM-01** | The domain a budget is keyed on comes from the **host the client chose to request** (redirect-immune), **never** from a server-controlled field — not the challenge `resource`, and not the post-redirect `response.url` (a payee can redirect / rotate subdomains to mint a fresh per-domain bucket). | T14 | `domain-derivation-ignores-redirect` |

> **Per-domain is a budgeting aid, not the security boundary.** Per-*host* bucketing ≠ per-*counterparty*: a payee spread across many hostnames is never bounded by the per-domain cap regardless of which URL keys it. The **global (per-asset,chain) cap is the boundary** against a hostile counterparty; per-domain limits blast radius across *cooperating* domains. (Refined per the adapter adversarial review — D-026, Finding C.)

## Configuration integrity

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **CONF-01** | The guard refuses to load a world-writable policy file (`policy.json`) — a deterministic startup gate, mechanism not judgment. Scoped to the world-write bit only (not group, not owner). | T15 | `rejects-world-writable-policy` |

> CONF-01 is the *only* defense v1 offers against policy-file tampering (T15/A8). Full policy-file integrity against an attacker with host write access is A5-adjacent and out of scope; policy integrity otherwise rests on filesystem permissions the user controls.

> **All file-permission gates are POSIX-only (and are explicitly guarded — PLAT-01).** CONF-01 (world-writable `policy.json`), the decision log's `0o600` creation, and **ACCT-06/PRIV-04** (the ledger's `0o600` + world-writable refusal) are POSIX-permission-based. On Windows, Node **synthesizes** `stat().mode` from the read-only attribute — a normal writable file reports `0o666` — so an *unguarded* `& 0o002` check would **misfire into a deny-all** (refuse every policy/ledger), not merely no-op. So the world-writable checks are **skipped on `win32`** (PLAT-01), degrading to an honest no-op. Read "world-writable refused" / "owner-private" as **Unix guarantees, not cross-platform**; Windows privacy+integrity rest on **NTFS ACLs** — place these files under the user profile (`%LOCALAPPDATA%`), where inherited ACLs restrict them to the owner.

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **PLAT-01** | The POSIX file-permission refusals (CONF-01 policy, ACCT-06 ledger) are **skipped on Windows** (`process.platform === "win32"`), where Node synthesizes mode bits — so they degrade to an honest no-op instead of misfiring into a deny-all. | (portability) | `perm-gates-skipped-on-windows` |
> Format is JSON (D-023): dep-free, so the guard adds no parser to its own supply chain. The loader also *parses* the file into a trustworthy `Policy` at the boundary — every field required (no code-side defaults, POL-01), money/time re-parsed through the branded primitives, cap keys re-canonicalized. A named requirement for that parse behavior (**CONF-02**) is proposed, pending ratification.

## Core hygiene

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **CORE-01** | `evaluate()` is pure: identical `(payment, challenge, policy, state)` yields an identical decision; no I/O in the core. | (design) | `core-is-pure` |
| **DEP-01** | The core has **zero** runtime dependencies. | (supply chain) | `core-zero-deps` |
| **OBS-01** | Every decision carries a stable, machine-readable reason code. | (design) | `every-decision-has-reason` |

## Read API (snapshot)

A read-only, **pull** projection of current spend vs. caps — the primitive a local viewer/dashboard consumes. Viewer-never-actor: it exposes **nothing new** (owner-only, in-process; the caller already holds the signer and can read the ledger directly), and the core never persists or ships it. A `Snapshot`, once held, is the system's most sensitive artifact-at-rest (the counterparty graph in `byDomain`); its lifecycle is the caller's responsibility (see the type doc).

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **SNAP-01** | `snapshot()` is **read-only**: it reads state via the store's existing retried `load()` and **never** writes — no `compareAndSave`, no `verifyAtomicity` — so it cannot mutate spend or interfere with `authorize()`. A read-only monotonic window advance is computed for display and **never persisted**. | (design) | `snapshot-is-read-only` |
| **SNAP-02** | On an **unreadable** spend store, `snapshot()` **throws** (`snapshot.state_unreadable`), never a fabricated zeroed snapshot. The **same** no-false-permissive principle as fail-closed, pointing **loud** instead of closed because a zeroed snapshot is a *lie* (a read for a human), not a safe deny. | (design) | `snapshot-unreadable-throws-not-zeros` |
| **SNAP-03** | The snapshot is an **honest view**: every configured cap appears (even at 0 spent), a denomination with spend but no configured cap is **shown** (never hidden), and a write-ahead **over-count** is surfaced — `spent` may exceed a cap; `remaining` clamps at 0 while the raw `spent`/cap remain visible. | (design) | `snapshot-honest-view` |

## The published artifact (packaging)

> **"Don't break userspace" (PKG, D-037).** What a published package exports is a **forever contract** — adding an export is non-breaking, removing one is a breaking change. So the surface is a **deliberate, minimal allowlist**, enforced by a build-failing freeze test, and the *only* reachable path is the single barrel (`.`); every internal module is unreachable by construction (the same "sole path" discipline as the signer wrap). The artifact is `dist`-only (compiled JS + declarations, **no source, no maps**), so a stranger installs exactly the reviewed enforcement core and nothing else. This first publish is the one moment underexport is free — there are no consumers yet to break.

| ID | Requirement | Threat | Test |
|----|-------------|--------|------|
| **PKG-01** | The public API surface is a **frozen, explicit allowlist**: the barrel's exports must equal a declared set, so a change to what is published fails the build unless the frozen set is deliberately updated. An export cannot drift in on an unrelated refactor. | (userspace contract) | `public-surface-is-frozen` |
| **PKG-02** | The package publishes a **single entry**: `exports` exposes only `.` (plus `./package.json`), `main`/`types` resolve into `dist`, `sideEffects` is `false`, and `engines.node` is declared. Deep imports (`x402-spendguard/…/internal`) are unreachable — Node throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. | (userspace contract) | `package-manifest-is-single-entry` |
| **PKG-03** | The build emits the artifact from `src` **only** (never `test`), rooted so output is `dist/index.js` — not `dist/src/…` — with declarations on and **source/declaration maps off** (a shipped map would dangle against un-shipped source, or leak an absolute local path). | (supply chain) | `build-emits-from-src-only` |
| **PKG-04** | Deep imports are blocked through the **type** channel as well as the runtime channel: the `exports` map exposes no internal subpath and no wildcard, so a consumer cannot type-resolve an internal symbol under `nodenext`/`bundler` resolution — the barrel is the sole path for types too, not just for values. | (userspace contract) | `exports-map-blocks-deep-imports` |
| **PKG-05** | The published tarball ships **only** `dist` (compiled JS + declarations) plus the manifest/README/LICENSE — **no `.ts` source, no `.map`, no `test`/e2e code, no `.npmrc` or secret**. The `files` allowlist and the map-free build make this true by construction. | (supply chain) | `publish-ships-only-dist` |

> **PKG validation (the teeth).** `test/e2e/pack-install.e2e.test.ts` proves PKG-01…05 against a **real tarball**, the way the cross-process smoke test proves ACCT-05 against real processes: it runs `npm pack`, unpacks into a throwaway `node_modules`, imports **only** the barrel and runs a live deny, then asserts a runtime deep-import throws `ERR_PACKAGE_PATH_NOT_EXPORTED`, a **type** deep-import fails `tsc` under `nodenext`, and the shipped file list contains no `.ts`/`.map`/test/secret. Opt-in (it builds and packs), run in the CI `e2e` job — not part of the hermetic default gate. The PKG-0x tests above are the hermetic guarantees; this is the integration proof they hold in reality.

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
