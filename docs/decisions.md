# Decision Record

**Point of contact:** Kevin Brown, x402.spendguard@gmail.com

We committed that the *reasoning* would be as open as the code. This is that record: the decisions that shaped `x402-spendguard`, why we made them, and what we rejected. Where a decision looks like an omission — no anomaly detection, no `upto` support, no custody — the reasoning here is the difference between a principle and an oversight.

Format: context → decision → consequences → alternatives rejected. Decisions are numbered and dated; a superseded decision is marked, never deleted.

---

### D-001 — TypeScript, not Python
**2026-07-09 · Accepted**

**Context.** The x402 reference implementation and its client SDKs are TypeScript. Learning the protocol deeply is an explicit goal of this project.
**Decision.** Build in TypeScript.
**Consequences.** We wrap the SDK at the signing step with the least friction, and we learn the protocol where its guts actually live.
**Rejected.** Python — viable, but the clean version would be a localhost proxy: more moving parts, further from the reference implementations.

### D-002 — Open source, MIT, open-core
**2026-07-09 · Accepted**

**Context.** The product *is* trust. We are asking a developer to put our code between their agent and their wallet.
**Decision.** Open source, MIT licensed. The guard is and stays free and open. Any future paid surface is convenience — a hosted control plane, dashboards, alerts — never custody.
**Consequences.** "Read the thousand lines yourself" is the adoption pitch. Open + npm + GitHub is also the only realistic distribution path for a two-person team.
**Rejected.** Closed source — a security tool that touches money must be auditable or it is dead on arrival. Apache-2.0 was the defensible alternative (patent grant); MIT chosen for lowest adoption friction.

### D-003 — The enforcement ladder: v1 is the seatbelt rung
**2026-07-09 · Accepted**

**Context.** A guard's power is exactly what the agent *cannot do by itself* — a question about where the signing key lives, not about authenticating the agent. A process cannot verify its own integrity, and prompt injection fakes nothing: the code is authentic and the agent honestly asks to pay the attacker.
**Decision.** Three rungs. **Crawl:** an in-process library (this, v1) — defeats prompt injection, bypassable by owned code. **Walk:** a local daemon holding the *user's* key on the *user's* machine — enforceable against a compromised agent, and we hold nothing. **Run:** on-chain limits (session keys, delegation) — integrate, never reimplement. v1 ships the seatbelt and says exactly what it is.
**Consequences.** The cheap, bypassable library defeats the headline threat, because an injected agent asks *honestly* and the allowlist says no. The README must permanently state that this is not a wall.
**Rejected.** Starting at custody. It is a higher-liability product, and the first thing we'd learn would be key management rather than x402. **We will never hold customer keys**; hosting custody is rent-money risk for coffee-money reward.

### D-004 — Fail closed, with an audit/enforcement split
**2026-07-09 · Accepted**

**Context.** A guard that fails open is worse than no guard: it grants false confidence.
**Decision.** Every ambiguous case — a policy error, an engine exception, a missing field — results in `deny`. **But:** *enforcement* failures must deny, while *audit* failures must not flip a decision. "A decision the guard already made must not be undone by a record of it."
**Consequences.** REQ FAIL-01/02/03. A failure to durably record a *spend* before release still denies (that is accounting, not audit).
**Rejected.** Uniform "any error denies," which would make an audit-sink outage a payment outage. Pattern adopted from `presidio-hardened-x402`, credited in [prior-art.md](prior-art.md).

### D-005 — Pure core, state at the edges; money is `bigint`
**2026-07-09 · Accepted**

**Context.** Security-critical logic should be small, deterministic, and testable without mocks.
**Decision.** `evaluate()` is a pure function of `(payment, challenge, policy, state)`. Persistence, config loading, and interception live outside it. Money is always an integer in the asset's smallest unit — never a float.
**Consequences.** Exhaustive and property-based testing become cheap; the Trusted Computing Base stays small. `0.1 + 0.2 ≠ 0.3` will drain a wallet, so no float ever touches an amount (REQ MONEY-01).
**Rejected.** A core that reads its own state — it would need mocking, and the security-critical path would carry I/O.

### D-006 — No network egress, no telemetry
**2026-07-09 · Accepted**

**Context.** The guard's decision log is a map of the user's money, and the signed payload is a bearer capability. Transparency about *the tool* must never become exfiltration of *the user*.
**Decision.** The guard makes no outbound calls and ships no telemetry. **Absent, not opt-out.** Verified by a static check (REQ PRIV-01), and the log never contains the signed payload (PRIV-02).
**Consequences.** No hosted component can ever sit in the payment path. Any future paid surface is separate and opt-in.
**Rejected.** Default-on analytics. At least one existing x402 "guard" ships payer address, payee address, transaction hash, amount, asset, and network to a vendor endpoint by default. We consider that disqualifying.

### D-007 — Screen the signature, not just the offer
**2026-07-10 · Accepted**

**Context.** Every existing guard we read interposes on the HTTP transport and screens the server's *offer*. It therefore checks what the server *asked for*, and cannot check what the wallet *actually signed*.
**Decision.** Interpose where the payment authorization is built — the x402 v2 `onBeforePaymentCreation` hook, or by wrapping the signer — so the guard sees the `TransferWithAuthorization` struct before it is signed.
**Consequences.** Makes the binding checks (D-008) possible at all. Introduces a real engineering problem: the v2 hook has the requirement without the struct; the signer wrap has the struct without the resource URL. The adapter must correlate them (ASM3 in the threat model).
**Rejected.** Offer-screening alone. It is a legitimate and complementary approach — see [prior-art.md](prior-art.md) — but it cannot see the signature.

### D-008 — v1 scope: anti-drain **plus signature integrity**
**2026-07-10 · Accepted · supersedes the original "anti-drain only" scope**

**Context.** The x402 signature commits to money movement, not to the request. The `resource` URL is neither signed nor checked. v1 facilitators accept `value ≥ maxAmountRequired` (overpayment verifies), and nobody enforces the challenge's declared `maxTimeoutSeconds` against `validBefore`.
**Decision.** v1 enforces the anti-drain set (kill switch, destination allowlist, spend caps) **and** three binding checks: `value == amount`, `to == payTo`, and `validBefore ≤ now + maxTimeoutSeconds`. Nonce-based replay protection needs durable state and remains v2.
**Consequences.** The binding checks are pure comparisons between two objects the guard already holds — no state, no new dependency. Their honest justification is *soundness* (they make the cap and allowlist decisions meaningful, by ensuring the guard evaluated the same values that get signed) plus one *standalone* control (BIND-03 bounds a bearer capability's lifetime, which nothing downstream does).
**Rejected.** Deferring binding to v2 — which would have shipped a v1 whose only novelty was being written in TypeScript.

### D-009 — Caps denominated per `(asset, chain)`; allowlist keyed the same
**2026-07-10 · Accepted**

**Context.** `asset` in x402 is an ERC-20 contract address, and `network` is a chain identifier. Summing micro-USDC with another token's smallest units against one cap is meaningless, and the meaninglessness resolves in the attacker's favor about half the time. An address is not a destination — *an address on a chain* is.
**Decision.** Every cap is denominated per `(asset, chain)`; amounts of differing `(asset, chain)` are never summed. The allowlist is keyed on `(address, chain)`.
**Consequences.** REQ CAP-01/02/03/04, ALLOW-02, BIND-04. Retrofitting this after users have hand-written a `policy.yaml` would be a breaking change, so it is decided before the file format exists.
**Rejected.** A single bare number. Both existing tools we read do this; one assumes six decimals for *every* asset, mis-valuing an 18-decimal token by a factor of 10¹².

### D-010 — Empty allowlist denies everything
**2026-07-10 · Accepted**

**Context.** An unconfigured allowlist has to mean something.
**Decision.** Empty allowlist = deny all.
**Consequences.** The guard ships refusing every payment until the user names a destination. Secure by default: the user opts destinations *in* rather than opting danger *out*.
**Rejected.** Empty = allow-any. More convenient, and precisely the wrong default for a guard.

### D-011 — Mechanism, not policy → no anomaly detection
**2026-07-10 · Accepted**

**Context.** "Policy belongs in userspace, not the kernel." The guard's job is to enforce the policy the user wrote, deterministically.
**Decision.** The guard forms **no opinions of its own.** A control that enforces a user-authored deterministic rule is mechanism (in scope). A control requiring the guard to judge what is "suspicious" is policy in the guard (rejected). **Anomaly / spike detection is therefore rejected on principle, not deferred.**
**Consequences.** A user-configured deterministic *rate cap* ("at most N payments per window") survives the razor — it is mechanism, and a legitimate future cap dimension. Statistical spike detection does not.
**Rejected.** Anomaly detection, proposed by both an existing tool and an external analysis. A guard that false-denies on a statistical guess erodes the trust that is its entire product, and it breaks the deterministic, provable core.

### D-012 — v1 supports the `exact` scheme only
**2026-07-10 · Accepted**

**Context.** In the `upto` scheme, the client signs a *maximum* and the **resource server chooses the actual charge (0 → max) after consumption**. A guard cannot constrain that actual charge; it can only bound the worst case. `upto` is also a v2-only protocol scheme — absent from the deployed legacy packages.
**Decision.** v1 handles `exact` (the default, deployed, mainstream path). Non-`exact` schemes are **denied with a stable reason** (REQ BIND-05).
**Consequences.** Excludes no deployed legacy workload. When v2 adds `upto`, the rule differs by necessity: bind against the signed maximum, and disclose plainly that "the server may charge up to X."
**Rejected.** Attempting partial `upto` support in v1 — a guard that cannot state what it guards should refuse, not guess.

### D-013 — Requirements derive from a threat model; every requirement names a test
**2026-07-09 · Accepted**

**Context.** Brainstorming a security tool produces the requirements that are *easy to imagine*, not the ones an attacker will use.
**Decision.** Requirements are **derived** from the threat model. Each traces back to a threat it defeats and forward to a test that proves it. A requirement that cannot name a test is not a requirement — it is an open question.
**Consequences.** A traceability meta-test reads `REQUIREMENTS.md` and turns the suite red if a required test is missing. Also: ground-truth the protocol against source *before* writing protocol-touching requirements — our first attempt would otherwise have specified a deprecated SDK API from memory.
**Rejected.** A brainstormed feature list.

### D-014 — Testability is a requirement, not an aspiration
**2026-07-10 · Accepted**

**Context.** "Testability" is not falsifiable, so by our own rule it cannot be a requirement. The properties that *produce* it are.
**Decision.** Purity (CORE-01), static no-egress (PRIV-01), and **INJ-01** — the clock and spend-state store are injected dependencies at every layer; no module outside the composition root reads a wall clock or opens a store ambiently.
**Consequences.** Without INJ-01, the clock-anomaly and accounting requirements are *unfalsifiable*: an accounting module reading the wall clock ambiently would satisfy every other requirement while being untestable. Testability decided late is the most expensive bolt-on of all — it cannot be added to code, only designed in.
**Rejected.** Treating testability as a soft "design input." See [TEST_PLAN.md](../TEST_PLAN.md).

### D-015 — Publish when the repo is coherent, not when it is complete
**2026-07-10 · Accepted**

**Context.** Publication is a one-way door on first impressions. The documents currently describe a guard the code has not caught up to. And `prior-art.md` critiques two named projects — the weakest position from which to publish that is a repo that has shipped nothing.
**Decision.** Version control immediately; publish to GitHub when a stranger reading the documents and then the code finds them consistent: the core matches the model, and the tests named in `REQUIREMENTS.md` exist and either pass or visibly fail with a stated reason.
**Consequences.** The same words in `prior-art.md` read as *practitioner who read the source* beside a working guard, and as *criticism from someone who hasn't built anything* beside a stub. Coherence, not completeness, is the gate.
**Rejected.** Publishing immediately to build in the open. Reviewers can read the documents without a public repo; the standing of the critique cannot be recovered later.
