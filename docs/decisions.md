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

### D-016 — Development discipline
**2026-07-10 · Accepted**

**Context.** For a security tool, *how* the code is written is part of what a reader is asked to trust. Two failure modes bracket the work: the **band-aid** (patch the symptom, leave the cause) and the **gold-plate** (polish without a stopping rule). Both are avoidable with an explicit loop and explicit definitions.

**Decision — the loop.** Every development stroke follows:

> **audit → think → plan → write the failing test → implement → verify**

with an explicit **return edge from `implement` back to `think`.** Two edges are called out because they are the ones that get skipped:
- *Test-first is a named step.* We adopted TDD; if "implement" is allowed to swallow the test, we drift to test-after within a week.
- *Going back is the default, not a defeat.* Band-aids are not a character flaw — they are what happens when you discover mid-implementation that the plan was wrong and patching forward is cheaper than re-planning. Naming the edge makes re-planning the expected move.

**Decision — what a band-aid is** (so the rule is checkable): *a change that makes a symptom disappear without changing the model that produced it.* Concretely: adding a special case so a test passes; catching an exception to suppress it rather than to deny; widening a type to accommodate a value that should have been rejected. This is the code-side twin of the test-side rule in [TEST_PLAN.md](../TEST_PLAN.md): *never weaken a test to go green* ⟹ **never widen the code to accept an input you should reject.**

> *Honest caveat:* this rule is affordable **because we have no users.** No production incident is forcing a hotfix. If that changes, "no band-aids" needs a documented exception path — stop the bleeding, then the real fix, then a permanent regression test — rather than quietly becoming a rule we break.

**Decision — attack surface is a specific set, not every line.** We considered the stricter maxim "every source line is an attack surface" and rejected it as *imprecise in a costly way*: if every line is attack surface, none is, and scrutiny cannot be concentrated where the trust boundary actually sits. Taken literally it also pushes toward validate-everything-at-every-layer, which *increases* line count — and therefore bug count — while blurring where validation belongs.

Two sharper statements replace it, and both are true:
1. **Every line is a liability.** You own it, maintain it, and a reviewer must read it. The conclusion this drives is *write fewer lines* — which is exactly the point of a core small enough for a human to read in one sitting.
2. **Attack surface is where untrusted input meets a decision**, and it gets the paranoia: the challenge parser, the payload parser, amount parsing, cap arithmetic, policy loading, and the state-store boundary. Adversarial tests, property tests, and fuzzing concentrate there. Pure comparison logic downstream of a correct parse gets ordinary rigor.

We follow **parse, don't validate**: untrusted input is converted into a trustworthy type *once*, at the boundary; the interior then trusts its own types.

**Decision — the stopping rule (definition of done).** A change is done when: **the requirement's named test passes, the code is as small as it can be while passing, and no test was weakened to get there.** Quality is defined by the threat model and the requirements — not by how much more could theoretically be added.

**Consequences.** "Highest quality possible" is unbounded and is its own failure mode for a deliberately cheap, bounded project; the stopping rule above bounds it. The loop's audit step means we read the current source honestly before each stroke — the same discipline that caught a deprecated SDK API we would otherwise have specified from memory (D-013).

**Rejected.** "Every source line is an attack surface" (too strict; see above). Unbounded "highest quality possible" (no stopping rule). Test-after development (drifts immediately).

### D-017 — v1 is EVM-only (EIP-3009 `exact`); Solana/SVM deferred to v2
**2026-07-10 · Accepted · ratified explicitly by Kevin, not folded in**

**Context.** x402's `exact` scheme has an EVM variant (EIP-3009 — a legible, field-labeled EIP-712 struct) and a Solana variant (a partially-signed transaction — a different artifact entirely). Every binding check in this project reads the EVM struct's fields; none applies to the Solana form. Our `Authorization` type literally cannot represent an SVM payment.
**Decision.** v1 evaluates only EIP-3009 `exact` on EVM chains (Ethereum and the EVM family — Base, Polygon, Arbitrum, …). Solana/SVM is **denied at parse with a stable reason** and deferred to v2. This was raised for ratification as a **scope cut, not a refinement**, and accepted out loud — a foundational scope change does not become real by appearing inside a design doc.
**Consequences.** Base — where most current x402 volume lives — is EVM, so v1 covers today's dominant venue. The trade-off given up: the Base-vs-Solana cross-chain friction the pessimist case named as the interesting problem. Solana in v2 is real work — a genuinely different set of binding checks — not a config flag.
**Rejected.** Including SVM in v1 (would require the second binding-check set before shipping anything). Letting EVM-only arrive silently as a "type-model consequence" (the drift failure mode we have guarded against for ten turns).

### D-018 — No policy in the guard: no deciding literals in enforcement code
**2026-07-10 · Accepted**

**Context.** "Policy belongs in userspace." [D-011](#d-011--mechanism-not-policy--no-anomaly-detection) said the guard forms no opinions; this sharpens it from *what* the guard decides to *where the numbers live*.
**Decision.** The enforcement path contains **no security-deciding literal** — no hardcoded skew, no threshold, no default toggle. Every number, list, and tolerance is read from the user's `Policy`. Shipped defaults (e.g. clock-skew, the cross-origin flag's off state) live in a **readable default policy file**, never as constants in code. A reader of the guard's code should find zero numbers that decide an outcome.
**Consequences.** New requirement POL-01, testable by a static check. `clockSkewSeconds` and `requireOriginMatch` become policy fields with documented defaults in the shipped file, not code constants.
**Not policy, and correctly in the guard:** the binding/integrity checks (they make user policy *sound*, not a value judgment), fail-closed behavior ("deny" is the safe mechanism), and the coordinate system (smallest-units, the `(asset, chain)` key, the domain-derivation rule — the *language* policy is written in, not policy itself).
**Rejected.** "Sensible defaults" as code constants — a hidden opinion is still an opinion.

### D-019 — v2 seams built into v1 (tagged authorization, per-form cap amount, opaque nonce)
**2026-07-10 · Accepted**

**Context.** v1 is EVM-only, but must not foreclose v2 (Solana, `upto`, replay/nonce, the daemon rung). The rule: build the *seam*, never the *filling*.
**Decision.**
1. **`Authorization` is a discriminated union tagged by payment form** (`form: "eip3009-evm"` in v1). The engine dispatches binding checks on the tag; an unrecognized form is denied at parse. This *is* the EVM-only gate (D-017) — the v1 scope boundary and the v2 seam are one mechanism, no extra code. v2 adds a variant, not a rewrite.
2. **The cap-relevant amount is extracted per form**, not assumed to be `challenge.amount` — so v2's `upto` (cap against the signed maximum) is additive.
3. **The `nonce` is carried as an opaque `Hex`, never read in v1** (enforced by a test, not by an unreadable type — so v2 reads it without a type migration). Refines an earlier suggestion to type it unreadable; the test-enforced version carries into v2 cleanly.
**Consequences.** The pure core already decouples the decision from where enforcement lives (CORE-01), so the daemon rung needs no new seam. v2-awareness changes v1 in exactly two small, justified ways (the tagged union — needed anyway — and per-form amount extraction).
**Rejected.** Building SVM/`upto` parsers now (YAGNI — that is filling, not seam). Typing `nonce` unreadable (forces a v2 type migration for zero v1 benefit over the test-enforced version).

### D-020 — Release & configuration management
**2026-07-10 · Accepted**

**Context.** A security tool's version number is a trust signal. "v1" (our feature scope) and "1.0.0" (a SemVer stability promise) are different things and must not be conflated.
**Decision.**
- **Versioning is SemVer, and we live in `0.x` until 1.0.0 is *earned*.** `0.x` explicitly means "not stable, anything may change" — which is the honest signal for a pre-production guard. `1.0.0` means "we stand behind this as production-ready," is earned by real-world exercise, and may never come (this is an option). Stages: `0.0.x` pre-alpha (core) → `0.1.0` alpha (core + accounting) → `0.x` beta (v1 scope complete) → `1.0.0` earned. No `-alpha.N` suffixes — stability is described in Release notes and the README, not encoded in ceremony.
- **Two distinct "push" gates.** *GitHub-public* = "you can read and audit this"; gate is coherence (docs match code, CI green). *npm-publish* = "you can depend on this"; gate is the adapter (usable drop-in). GitHub-readable precedes npm-installable. Target: GitHub-public after the accounting layer (tag `v0.1.0`, CI in the same push); npm after the adapter.
- **Branching is GitHub Flow, not git-flow.** `main` stays green and coherent; each slice is a short-lived branch merged when green. `main` only ever sees green — WIP (which goes red first under TDD) lives on the branch. Adopt PR review only once public and a second human contributes.
- **Commits: light Conventional Commits** (`feat:`/`fix:`/`docs:`/`test:`/`chore:`). Hard rule: every commit to `main` leaves the suite green; security-relevant commits say so. Add `CHANGELOG.md` at first public push (a changelog is part of a security tool's trust story).
**Consequences.** The prior-art critique's "standing" concern (D-015) resolves itself: by public-push time it sits beside a working, green guard.
**Rejected.** git-flow (ceremony with no payoff at two-person scale). Calling the v1 scope "1.0.0" (a stability claim we have not earned). npm-publishing before the tool is usable drop-in.

### D-021 — Cross-process accounting: flag now, fix as a tracked slice
**2026-07-10 · Accepted (honesty fix); real fix timing OPEN**

**Context.** An external code review (Opus, reading the actual source) caught a gap our own discipline should have flagged: ACCT-02's single-writer guarantee holds *within one process*, but the bundled `FileSpendStore` has no cross-process lock. Two processes sharing one wallet's ledger can both load pre-spend state, both pass a cap, and both save — **under-counting and silently bypassing the cap, in the money-losing direction.** It was scoped only in a code comment, not in the README non-goals or threat model — an unflagged unsafe limit under a strong claim, which is exactly the failure mode this project exists to avoid.
**Decision (done now).** Flag it loudly and immediately: README limits, a KNOWN LIMITATION callout in REQUIREMENTS.md, ACCT-02 reworded to "within a single process," and a new **ACCT-05** (cross-process single-writer) recorded as an *unmet, honest* requirement with a deferred test — so the limitation cannot hide. Until closed: **run one guard instance per wallet.**
**Open.** The real fix — an OS/advisory-locked store, or compare-and-swap on load (re-read at save; conflict ⇒ fail-closed deny) — is dependency-free but a real slice. **Timing is Kevin's call:** before the adapter ships (Opus's lean, since multi-worker is a deployment a user would pick), or a documented v1 limitation with the fix as v1.x. Not decided.
**Also (finding 4):** write-ahead over-counts on downstream settlement failure (safe direction, but a run of failed payments reaches the cap early). Recorded as an explicit **v2** item: settlement-confirmation → reconcile. Not a bug; a named roadmap decision.
**Process note.** This is the second real bug an *actual code read* caught that a *design/docs read* missed (after the empty-allowlist hole). Grok's two "code reviews" never fetched `src/` and found neither. Code-level adversarial review remains owed; the fix here came from the reliability lens, not the adversarial one.

### D-022 — Adversarial code review: five landed attacks fixed
**2026-07-10 · Accepted**

**Context.** An adversarial review (Opus) ran seven concrete attacks against the *compiled* code; five broke something. The money-decision path (parse → bind → allowlist → caps) held — binding is exact bigint/lowercased-string comparison with no coercion seam, belt-and-braces holds, fail-closed denies fire. Every finding lived in the edge/accounting layer or in a requirement that over-promised.

**Fixed now (all confirmed, all unsafe-direction):**
- **H2 — `__proto__` origin bypassed the per-domain cap, and `makeDomain` didn't canonicalize.** Origin `"__proto__"` read `Object.prototype` (always 0) and wrote to the prototype (never persisted), silently voiding the per-domain cap; and `"shop.example"` / `":443"` / trailing-dot / URL forms keyed different budget buckets. Fixed: `makeDomain` canonicalizes to the bare lowercased hostname; spend maps are **null-prototype** (`Object.create(null)`) and reads use `Object.hasOwn` (belt-and-braces). *(My earlier `originOf` fix touched only the optional check, not the budget-bucket key — this fixes the real one.)*
- **H3 — a corrupt/unreadable ledger threw out of `authorize()` instead of denying.** FAIL-01 wrapped only `evaluate`, not `store.load()`. Fixed: load + window advance are wrapped; failure ⇒ `deny("state.load_failed")`. Fail-closed now extends to the accounting layer.
- **M1 — BIND-03 was defeatable by a malicious server.** The lifetime bound used the challenge's `maxTimeoutSeconds`, which is *server-controlled* — set it huge, the bound is toothless (a **remote** attack; malicious servers are A2, in scope). Fixed: new policy field `maxAuthLifetimeSeconds`; the effective bound is `min(server claim, policy max)`. The server can only shorten the window.
- **M2 — CLOCK-01 over-promised.** It claimed "a forward jump must not manufacture fresh budget," but the code resets on any forward elapse ≥ window; only the backward guard is real, and the one test covered only the backward half. Fixed as **honesty**: CLOCK-01 reworded to the backward-only guarantee it delivers; forward-jump-under-host-clock scoped explicitly to A5 and pinned by a characterization test. A requirement that claims more than the code delivers is exactly what this project's credibility rests on not doing.
- **L1 — no `fsync` before rename** (power-loss could truncate the ledger, feeding H3). Fixed: `openSync`+`fsyncSync`+rename, and a **unique** temp name (`.tmp.<pid>.<uuid>`) so concurrent writers can't clobber the same temp.

**Deferred, recorded (not silently dropped):**
- **H1 (full cross-process lock)** — still ACCT-05/D-021, Kevin's timing call. The unique temp name is a partial mitigation, not the fix.
- **M3 — budget-exhaustion DoS**: write-ahead + no reconciliation means repeated allowed-but-failing payments (via the in-scope injection vector) can exhaust *budget* (not funds) until the window resets. Availability tradeoff; real fix is settlement reconciliation (**v2**).
- **L2 — no integrity/permission check on the ledger file** (asymmetry with CONF-01's `policy.yaml` check). Mirror the world-writable check on the store, or document ledger integrity == filesystem permissions. **v1.x.**
- **L3 — `makeOpaqueHex` accepts zero-length `0x`.** Harmless in v1 (nonce is carried-unread per D-019); **v2** replay logic must validate the 32-byte length, not assume it from parse success.
- **L4 — brands are compile-time only.** The trust model rests on the adapter routing *all* untrusted input through the parsers and never casting — a load-bearing invariant for the adapter slice, ideally with a runtime assertion at the composition root.

**Tested-and-safe (confirmed by the review):** prototype pollution via a poisoned ledger *value* was inert; binding has no coercion bypass; `assetKey`'s `|` can't be injected; amount/time parsers reject floats/signs/`0x`/whitespace; the `user@host` URL trick resolves to the real host; kill switch, empty-allowlist-deny, CAP-05, engine-throw→deny all hold.

**Process note.** This is what a real code-level adversarial review buys that a design review cannot: three of these (H2, H3, M1) are exploitable and none is visible from the docs. The core policy engine is sound; the edge is where the money leaks.

### D-023 — Policy file format is JSON (dep-free)
**2026-07-11 · Accepted**

**Context.** The config-loader slice (CONF-01) needs an on-disk policy format. YAML is friendlier to hand-author (comments, less punctuation) but requires a parser dependency; JSON parses with the built-in `JSON.parse`.
**Decision.** **JSON.** A YAML parser is exactly the class of transitive dependency this guard exists to be skeptical of — adding one to read the *security policy itself* is the wrong trade. It also keeps DEP-01 (zero runtime deps) intact. Human-authoring ergonomics do not outweigh the supply-chain cost for a machine-adjacent file; revisit only if real users demand comments/anchors.
**Consequence.** `loadPolicyFile` (adapter) does `statSync` → CONF-01 world-writable gate → `readFileSync` → `JSON.parse` → `parsePolicy`. `parsePolicy` (pure, in `parse.ts`) is the config trust boundary: every field required (no code-side defaults — POL-01), money/time re-parsed through the branded primitives, cap keys re-canonicalized (a mixed-case token address must not yield a silently-never-matching cap that fails open), caps map null-prototype. CONF-01's wording updated from `policy.yaml` to the format-agnostic "policy file (`policy.json`)".

### D-024 — Change control (defect vs decision), H1 timing, v0.1.1
**2026-07-11 · Accepted (process); H1 timing resolved**

**Context.** The CCB question from 2026-07-10 surfaced that M2 (a CLOCK-01 requirement *rescope*) was landed solo when it should have been ratified first. Plus two roadmap items were parked: H1 cross-process lock timing (D-021) and whether to re-tag past v0.1.0.
**Decisions.**
- **Change control — the "CCB of two."** A *defect fix* (restores already-intended behavior, has a test) goes straight in. A *scope / requirement / design change* (a new knob, a changed requirement meaning, a rescope) must **converge/ratify FIRST**, even mid-session. Right-sized for a two-person pre-alpha — the one seam a formal CCB would give us, without the ceremony. Folded into D-016's discipline. This slice honored it: `parsePolicy`'s behavior is tested but no new requirement ID (a proposed **CONF-02**) was minted unilaterally — it's raised to Kevin instead.
- **H1 (ACCT-05) timing → document now, build pre-publish.** Ship v1 with the documented "one instance per wallet" limitation; build the real cross-process lock as its own slice before the npm-publish gate. Corruption is already prevented (unique temp name + fsync+rename); only lost-updates remain, and they are loudly flagged.
- **Re-tag v0.1.1 — yes, a light tag** for the hardening landed past v0.1.0 (D-022). Outward-facing, so pushed only on Kevin's go.

### D-025 — Decision-log layer: a decorator, off the enforcement path
**2026-07-11 · Accepted**

**Context.** The audit layer must record every decision (PRIV-02, FAIL-03 audit half) and be the durable, structured seam a future dashboard reads — *without* the audit ever being able to change enforcement.
**Decision — build it as a decorator, not code inside the guard.** `LoggingGuard` wraps any `Authorizer`: it runs the inner guard, gets the ALREADY-FINAL decision, attempts the log write, **swallows any sink error**, and returns the decision verbatim. This makes FAIL-03's audit half *structural* — the logger physically cannot see a decision before it is final, nor mutate it — and it embodies the captured principle *observability is strictly off the enforcement path*.
**PRIV-02 by construction.** `toLogEntry` is a hand-listed projection to a closed set of primitive-string fields (at, verdict, reason, detail, origin, chain, asset, to, amount). No signature (the decision core has none), **no nonce** (half the replay tuple), **no payer `from`**, no raw authorization. A test pins the exact key set so a "just log the whole authorization" regression fails loudly.
**Format — append-only JSONL (`FileDecisionLog`), fsync'd.** One JSON object per line: append-only, crash-durable, cheap to tail — the right shape for both an audit trail and a viewer. bigint money as decimal strings.
**Adversarial review (Opus, in-tree) — landed in this slice:**
- **F2 — the log was created world-readable (0o644).** PRIV-02 keeps the *secrets* out, but payees/amounts/origins/timing are still private payment data; a shared host leaked them to any local user — the mirror of CONF-01's asymmetry (refuse world-*writable* policy, but emit a world-*readable* ledger). Fixed: `FileDecisionLog` creates the file `0o600`. The mode applies on *creation* only; a pre-existing log keeps its mode (user-controlled, same footing as CONF-01).
- **F3 — schema version.** The on-disk record now carries `v: 1` as its first field, so a future reader/dashboard evolves against a known contract instead of guessing. Cheap now, expensive once a reader depends on the shape.
- **F1 — the "off the enforcement path" claim was half-true and is now corrected.** Verdict-integrity IS structural (the logger only sees a final decision and returns it verbatim). But `authorize` **awaits** the append, so liveness is coupled: a slow/stalled sink adds latency (never a different verdict). Opus's suggested append-timeout does NOT help, because the bundled `FileDecisionLog` fsyncs *synchronously* (blocks the event loop before any timer fires) — the same property `FileSpendStore` already has. Comment corrected to match the code; true decoupling (async I/O + timeout, or fire-and-forget, trading the durable-before-return property) is a **converge-first** design item shared with the spend store.

**Deliberately deferred (NOT pulled in silently, per D-024):**
- **Question 2 / silent audit loss → detectable loss (seq number).** A failing sink is swallowed (correct per FAIL-03) but *silently* — an attacker who breaks the log at the moment of a drain leaves a clean-looking, gap-free trail. Opus's fix: a monotonic per-entry sequence number so a *reader* can detect a missing entry (doubles as ordering/dedup). Done correctly it must be monotonic **across restarts**, so it's a real sub-feature, not a one-liner, and it pairs with F4's hash-chain. **Deferred as a documented, conscious choice**, to be built with F4 as one "verifiable audit log" item. *(Kevin's call — recorded here per Opus's own suggested path.)*
- **F4 — no tamper-evidence.** Plain append-only JSONL; a writer can delete/forge lines undetected. Load-bearing for a trail a dashboard is meant to *trust*. Document "log integrity == filesystem permissions"; v2 = hash chain (each entry carries the prior line's hash), pairing with the seq number.
- **F5 — unbounded growth → self-blinding.** No rotation/size cap; attacker-driven volume fills the disk, which then triggers the silent loss above. Roadmap (rotation), noted for the chain.
- **L2 — world-writable permission check on the *ledger* file.** F2 secured the new log file; the symmetric check on `FileSpendStore` remains the deferred L2 (converge-first).

### D-026 — SDK adapter: full-correlation interposition, v2 first
**2026-07-11 · Accepted**

**Context.** Re-verifying the current x402 SDK (`@x402/core@2.18.0`) against source surfaced the load-bearing fact: the `resource.url` available at the `onBeforePaymentCreation` hook is **server-declared** (it comes from the 402 body the payee sent). DOM-01 forbids keying a budget on a server-controlled field — so per-domain budgets **cannot** be honestly enforced at the hook. Neither the hook nor the signer sees the real outbound request URL; that lives only in the fetch/axios transport wrapper. The signed struct, the offer, and the real origin thus live in three different places.
**Decision — full-correlation interposition (chosen over hook-only and signer-only).**
- **Veto at the signer-wrap.** Wrapping `signTypedData` is the last gate before a signature exists, works on BOTH generations, and is hardest to bypass. It binds the **exact struct about to be signed** — catching a compromised client that signs something other than the offer (the whole point of screening the signature, not the offer).
- **Origin from the transport wrapper** (fetch/axios) — the real client-observed request origin, satisfying DOM-01 honestly. NOT the hook's server-declared `resource.url`.
- **Challenge from the hook / 402 body.** Correlated per payment flow via `PaymentFlowContext` (observe origin + challenge, consume-and-clear at signing).
- **Fail-closed throughout:** unsupported struct (`primaryType` ≠ `TransferWithAuthorization`), incomplete correlation, or a deny all THROW before the real signer runs — no signature on anything but a clean allow.
- **v2 first, v1 next** (v1 deprecated but deployed). Permit2/upto/SVM denied at parse (v1 = EVM `exact` only).
**Built — complete v2 adapter (branch `slice/adapter-wire-v2`):** wire normalization (`x402-wire.ts`), the veto core (`x402-guarded-signer.ts`: `PaymentFlowContext` + `guardedSigner`), transport capture (`x402-transport.ts`: `guardedFetch` records the real 402-response origin — DOM-01 honest), and the drop-in binding (`x402-binding.ts`: `createSpendGuardBinding` → `{wrapSigner, hook, wrapFetch}` sharing one context). `@x402/core` + `@x402/evm` added as **optional peer + dev deps** — DEP-01 holds (runtime deps still empty; `@x402` added no vulnerabilities of its own). `src/` imports no `@x402`; the hook/context shapes are declared STRUCTURALLY and a test asserts they are assignable to the real `@x402/core` types, catching drift without coupling the guard to the SDK. 24 adapter tests, 90 total green.
**Remaining:** the v1 wire path (v1 uses `maxAmountRequired` + loose network strings; deprecated but deployed) and true live-flow integration testing (needs a testnet/facilitator — not unit-testable in-repo).

**Adversarial review (Opus, in-tree) — NO-GO on Finding A; fixed in this slice:**
- **A (BLOCKER) — `{...inner}` re-exposed unguarded signing routes.** `guardedSigner` spread the whole signer, so a viem account's `sign`/`signMessage`/`signTransaction` passed through UNGUARDED — and the EIP-3009 authorization is an EIP-712 signature reproducible via `sign({hash})`, a full veto bypass on the guard's own return object. Fixed: the wrap now closes EVERY signing route — `signTypedData` is guarded; `sign`/`signMessage`/`signTransaction` throw `PaymentBlockedError`; non-signing reads (`readContract`, …) still pass through. The "last gate" claim is now structural, not one refactor from bypass.
- **C — per-domain key followed the server-movable `response.url`.** A payee could redirect / rotate subdomains to mint a fresh per-domain bucket and evade its own per-domain cap. Fixed: key on the **client-chosen request host** (redirect-immune), and DOM-01 reworded — plus the honest framing that per-domain is a budgeting aid and the **global cap is the security boundary** (per-host ≠ per-counterparty).
- **B — the serial-flow assumption was unenforced.** Origin mis-attribution under concurrent flows didn't fail closed (binding can't see origin). Fixed: `observeOrigin`/`observeChallenge` throw `adapter.concurrent_flow` on a conflicting re-observation before `consume` — the assumption is now an enforced invariant, not a doc note.
- **D — omitting `wrapSigner` fails OPEN** (the guard never runs, silently). Documented prominently as the one mandatory wire (the veto *is* the signer wrap, so its omission can't self-detect); a composition-root assertion is a possible future enhancement.

Post-fix: 26 adapter tests, 94 total green, tsc clean, runtime deps still 0. Held for Opus's re-review of the new signer surface.
**Serial-flow assumption:** one payment flow at a time per context. Interleaved concurrent flows can mis-correlate; a mismatch fails closed via the binding checks, but per-domain attribution assumes serial use — documented, like one-instance-per-wallet.

### D-027 — v1 wire path: one hook, dispatch on `x402Version`
**2026-07-12 · Accepted**

**Context.** The v1 wire path (deprecated but deployed) was the remaining half of D-026. Source verification of `@x402/core`+`@x402/evm@2.18.0` reshaped it to be *far* smaller than the roadmap assumed, and corrected a stale premise:
- The roadmap's "v1 has no confirmation hook" is true of the **legacy** `x402`/`x402-fetch@1.2.0` SDK, but the **current** `@x402/core` client ships `ExactEvmSchemeV1` and **fires `onBeforePaymentCreation` for BOTH generations** (the hook loop in `createPaymentPayload` runs before scheme dispatch, regardless of version). v1 also signs through the **same** `ClientEvmSigner.signTypedData`.
- ⇒ The **signer-wrap veto and transport capture are already generation-agnostic.** Only the *challenge shape* differs: v1 uses `maxAmountRequired` (not `amount`), keeps `resource` on the offer (v2 hoists it to the body), and gives a **loose network name** ("base-sepolia") instead of CAIP-2.

**Decision.**
- **Dispatch on the authoritative discriminator `ctx.paymentRequired.x402Version`** (`1 | 2`, a Zod literal) — NOT fragile field-sniffing (`amount` vs `maxAmountRequired`). One hook (`challengeCaptureHook`) handles both generations; an unknown version aborts (`adapter.unsupported_x402_version`), fail-closed.
- **`challengeFromV1`** resolves the loose network name to CAIP-2 via a table **mirrored verbatim from `@x402/evm`'s `EVM_NETWORK_CHAIN_ID_MAP`** — a protocol fact, not policy (POL-01 holds: it's a fixed ecosystem lookup, not a threshold the guard chooses). An **unknown name fails closed** (`wire.unknown_v1_network`): with no chain id we cannot key caps/allowlist or cross-check the signed struct's `chainId`. The table is null-prototype + `Object.hasOwn`-guarded so a `network` of `"toString"`/`"constructor"` cannot resolve. Then it hands off to the same `parseChallenge` boundary (which already accepted `maxAmountRequired`), so v1 and v2 converge on one parser.
- **Bonus security property:** the v1 ecosystem accepts `value >= maxAmountRequired` (overpay verifies cleanly at the facilitator), but our binding check is `value == amount` — so the guard **denies the documented v1 overpay/drain vector** the facilitator waves through.

**Built (this slice):** `challengeFromV1` + `V1Offer` + the network table in `x402-wire.ts`; `x402Version` dispatch in `x402-binding.ts` (structural `PaymentCreationContextLike` widened to the union of both offer shapes; the assignability test against the real `@x402/core` types still holds). 8 new tests (13 wire, 7 binding), **102 total green**, tsc clean, runtime deps still 0, no-egress static test intact.

**Still not live.** This is wire normalization + dispatch, unit-tested against fixtures. True v1 (and v2) live-flow validation against a testnet/facilitator remains the **live-testnet harness** gate before any funded wallet.

### D-028 — live-flow e2e harness: deny-path first, hermetic, no funds
**2026-07-12 · Accepted**

**Context.** Every slice through D-027 was unit-tested in isolation. The open question the roadmap flagged as *the top gate before any funded wallet*: is the guard actually **wired into the real `@x402` payment flow** — does the real SDK's `ExactEvmScheme` (both generations) hit our veto and fail to route around it? That is an integration fact no unit test can establish.

**Decision — prove the DENY path first, with zero value at risk.** The load-bearing observation: on a deny the guard throws **before a signature is released**, so nothing settles and the facilitator's verify/settle is never reached — meaning the deny path needs **no key and no funds**. So the first harness milestone is the deny path only; the funded allowed-settle path is deferred.
- **Real client, genuine 402, real HTTP.** `deny-path.e2e.test.ts` drives a real `x402Client` (both generations via `registerExactEvmScheme`) through a genuine 402 served over localhost (`x402-local-server.ts` encodes a schema-identical `PaymentRequired` the SDK's own way — v2 base64 `PAYMENT-REQUIRED` header via `encodePaymentRequiredHeader`, v1 JSON body). Our `createSpendGuardBinding` is installed; the transport wrap captures the real origin, the hook captures the challenge, the signer wrap vetoes.
- **Wire self-certification (no fiction).** Because the 402 is hand-built (not run through the server's price/decimals machinery), the harness proves it is *genuine* wire, not a lenient shape the client merely tolerates: the local server runs the SDK's own `validatePaymentRequired` (which we confirmed rejects empty / missing-`accepts` / numeric-`amount` / missing-`maxAmountRequired`) at setup, and for v2 validates the EXACT bytes the client parses by round-tripping through the real `encode`+`decode`. A deviation fails loudly before any test asserts.
- **Canary signer = the assertion mechanism.** The injected signer records which route was reached and never produces a real signature. On a deny our wrap throws before the inner signer, so `touched === []` — that IS the proof no signature was minted. On an allow, `touched === ["signTypedData"]` proves the real `ExactEvmScheme` reaches a signature only through the one guarded route (**Finding A, in the wild**). *Scope, stated to avoid overreach:* this proves the real CLIENT uses only `signTypedData`; it does NOT prove the wrap blocks every route of a richer signer (the canary exposes only the four known routes). Confirming a full viem `LocalAccount` has no un-blocked escape is the blocklist→allowlist residual, exercised by the deferred funded-settle path.
- **Scenarios:** kill switch, off-allowlist payee, over-cap amount — each asserts the real `createPaymentPayload` rejects with the guard's *specific* reason (`halt` / `allowlist.blocked` / `cap.per_request`), on **both v1 and v2**. Because a mis-dispatch or wire error would surface a *different* reason (e.g. `parse.chain_malformed`), the v1 tests passing on the guard's own reasons independently re-confirm the D-027 v1 path end-to-end. Plus an **origin-value** test (`requireOriginMatch` → `origin.mismatch`) proving the origin the transport wrap derived (the real request host) actually reaches the policy and drives a verdict — not just that origin is *present*. The Finding-A allow control runs on **both** generations.
- **Real clock, not a fake.** The live client stamps `validBefore` from wall time, so the guard runs on the real `systemClock` (generous lifetime + skew) or the timeout binding check would false-deny. A fake clock is the one thing that would make these tests lie.
- **Non-vacuity verified by mutation:** stripping the guard off the signing route (raw signer) flips 6/7 to red (the real client then proceeds to sign — `error` undefined, `touched` non-empty); restoring it returns green. The suite genuinely exercises the veto.

**Boundary discipline (matches the roadmap's guardrails).** The harness lives in `test/e2e/` — never imported by `src/`, so the static no-egress proof over `src/` is unaffected. It runs opt-in via `npm run test:e2e` (own `vitest.e2e.config.ts`; default `npm test` excludes `test/e2e/**` via `vitest.config.ts`) and a **separate CI job**, never the green-main gate. `.gitignore` blocks `.env*` (except `.env.example`); the deny path needs no secrets, and the deferred settle path reads a testnet-only key from an untracked `.env`.

**Built (this slice):** `test/e2e/{deny-path.e2e.test.ts, x402-local-server.ts, README.md, .env.example}`, the two vitest configs, `test:e2e` script, the CI `e2e` job, `.gitignore` secrets rules, and a **`files` allowlist** in `package.json`. **9 e2e tests green**, default gate still **102 green + 1 todo**, tsc clean, runtime deps still 0. No new dependencies (the canary needs no viem).

**Two independent adversarial passes (subagents) before merge — one on vacuity, one on boundary/wire/claims.** The vacuity pass refuted every "passes for the wrong reason" hypothesis by mutation (neuter `checks.ts` → 6 deny tests fail; disable origin capture → deny becomes `context_incomplete` and all fail; break `challengeFromV1` → exactly the 3 v1 tests fail; unwrap the signer → 6 fail). The boundary pass confirmed the no-egress boundary, the wire self-cert, and the secret-leak block, and surfaced the **tarball** finding below. Fixes folded from their findings:
- **`files` allowlist (the tarball, not just `src/`, must match the no-egress story).** This was the first slice to put network-capable code (`test/e2e` imports `node:http` + calls `fetch`) into the repo; without a `files` field `npm pack` shipped it. Added `"files": ["src"]` so a published tarball carries only the egress-free core — allowlist over denylist, the same lesson as the signer route-closure. Full publish surface (dist/types/exports) is still the npm-publish gate.
- **Origin *value* now drives a verdict** (the `requireOriginMatch` test above) — closes the residual that no test made the derived origin affect a decision.
- **Finding-A allow control generalized to v1+v2**; wording tightened so it never reads as more than "the honest client uses only `signTypedData`."

**Honestly-scoped residuals (coverage, not defects — recorded so a reviewer isn't misled).** (a) The Finding-A allow test carries no guard-*decision* weight (it stays green even if the guard always-allowed) — the *deny* tests carry all decision weight; (b) full origin end-to-end (origin-keyed per-domain accumulation, and richer `requireOriginMatch` positives) and the blocklist→allowlist completeness against a rich viem signer both land with the funded-settle path; (c) `toEqual(["signTypedData"])` would break if a future SDK retried signing — a brittleness note, not a current defect.

**Deferred (unchanged gate) — with a written acceptance criterion (Opus, this review).** The one allowed micro-payment that actually settles on a testnet — the only part that moves value and needs a funded key — remains the next milestone. Because this harness's canary is a 4-method object, it *structurally cannot* catch the blocklist→allowlist residual (a real viem `LocalAccount` has more signing methods than the canary exposes — `signAuthorization`, and whatever a future SDK adds), and only a prose comment flags that today. So the funded-settle milestone carries a hard acceptance criterion, not a comment: **it MUST drive a real viem `LocalAccount` and assert that no un-blocked signing route exists across its full method surface.** Otherwise the allowlist-hardening question stays permanently one milestone away with no test that forces it. Until the funded harness exists: do not place this in front of a funded wallet.
