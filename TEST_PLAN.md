# x402-spendguard — Test Plan

**Point of contact:** Kevin Brown, x402.spendguard@gmail.com
**Status:** Pre-alpha. The testing methodology for the **v1** guard.
**Companions:** [THREAT_MODEL.md](THREAT_MODEL.md) (what we defend), [REQUIREMENTS.md](REQUIREMENTS.md) (what must hold).

---

## 1. Why a guard is tested differently

For most software, tests confirm the happy path works. For a guard, **the product is what it refuses** — so a passing happy-path suite proves almost nothing about security. Three consequences shape everything below:

- **Negative space is the point.** The load-bearing assertions are "this attack is *denied*," not "this payment is allowed." We test the deny far more than the allow.
- **Fail-closed is a testable default, not a vibe.** Every ambiguous or malformed input is an expected **deny**. We *inject* the ambiguity — a throw, a missing field, a garbage amount — and assert the deny (FAIL-01/02).
- **Adversarial, not illustrative.** A test should *stage the attack* and assert the refusal, the way the strongest prior-art tool stands up a hostile 402 server and asserts the signer is never invoked. A test that checks a flag is weaker than one that plays the adversary.

And the framing that governs the rest of this document:

> **The code is the claim. The tests are the evidence. The threat model is the argument for why the claim matters.**

A user cannot verify "this guard fails closed" by reading a thousand lines and trusting themselves. They look for a test that injects a throw and asserts deny. For an open-source security tool, the test suite is not internal QA — it is **the public evidence that the claims are true.** That is why this document is a first-class, published artifact.

---

## 2. The testing stack — and what each layer can and cannot prove

Each layer answers a different question and closes a different epistemic gap. **No layer substitutes for another, and no layer can rescue a flaw in the layer above it.** Tests are the evidence layer; they cannot repair a wrong threat model.

| Layer | Answers | Catches | **Cannot prove** |
|-------|---------|---------|------------------|
| **Threat model** | What are we defending, and against whom? | Defending the wrong thing | That the model is complete |
| **Requirements** | What must hold for that defense? | A threat with no control | That the requirements are sufficient |
| **TDD loop** | Does the code do what we said? | Code/spec divergence | That we specified the *right* thing |
| **Property tests** | Do the invariants hold on inputs nobody imagined? | Unimagined input classes | Anything outside the stated invariants |
| **Abuse cases** | Are the actual attacks refused? | Controls that pass alone but fail *composed* | Attacks we never conceived |
| **Regression** | Does a fixed bug stay fixed? | Recurrence | Anything about bugs not yet found |

Read as a sentence: **threat model → requirements → a TDD loop for the requirements we know, property tests for the inputs we didn't imagine, and abuse cases for the attacks we did — plus a regression test for every bug that ever bit us.**

The `Cannot prove` column is the honest part. A green suite is evidence that our imagination was satisfied, not that an attacker's will be.

---

## 3. Testability is a requirement, not an aspiration

"Testability" is not falsifiable, so it cannot be a requirement. The properties that *produce* it are, and they are **design requirements** — see [REQUIREMENTS.md](REQUIREMENTS.md):

- **CORE-01** — the policy core is a pure function of `(payment, challenge, policy, state)`. Purity is what makes the security-critical logic exhaustively testable *without mocks*.
- **INJ-01** — the clock and the spend-state store are injected dependencies at every layer that uses them. Without this, CLOCK-01 and the accounting requirements are unfalsifiable: a module reading the wall clock ambiently satisfies every other requirement while being untestable.
- **PRIV-01** — no egress, checked statically. This is what makes "no telemetry" *provable* rather than promised.

Testability decided late is the most expensive bolt-on of all. It is not a property you can add to code; only one you can design into it.

---

## 4. TDD as the working loop — and its limit

We adopt test-driven development for the core: **write the failing test that states what we want, write the least code that passes it, refactor.** It fits this project unusually well — the core is a pure function, and [REQUIREMENTS.md](REQUIREMENTS.md) already contains a table of named tests waiting to be written as failing tests today. Writing the *deny* test first also forces us to say what deny means *observably*, which is precisely why OBS-01 (every decision carries a stable reason code) exists.

**Its limit, which matters more here than in ordinary software: TDD only tests what you thought of.** A green suite proves the specification was met, not that the specification was right or complete. For a security tool that gap *is* the risk. So TDD is necessary and not sufficient, and it is paired with the two companions in the stack:

- **Property-based tests** attack our imagination — they generate inputs nobody conceived and assert the invariants hold anyway. INV-2 (*throw garbage at it; it must never allow*) is the single most valuable test in this plan, precisely because no human writes those inputs.
- **Abuse-case tests** (the security literature's mirror of use cases) stage the threats T1–T15 as concrete attacks and assert refusal *for the right reason*.

---

## 5. Two axes of coverage, and the meta-test that enforces them

A guard can pass every requirement in isolation and still let an attack through by composition. We cover two axes; neither substitutes for the other:

1. **Requirement tests** — one or more per `[v1]` requirement. Test names are exactly the names in the requirements table.
2. **Abuse-case tests** — one or more per threat **T1–T15**, staged as an attack, asserting deny *with the correct reason code*. These live in `test/abuse-cases.test.ts`, and — like the requirement axis — the abuse-case axis is **enforced by its own meta-gate**, whose source of truth is [THREAT_MODEL.md](THREAT_MODEL.md) §5: it derives the threat set and each threat's controls from the §5 table, and turns the suite red if a threat loses its staged test, if a §5-named control is not a tested requirement (cross-linking to the REQ→test axis below through the threat model's own declared mapping), or if the §5 table is malformed (fail-closed — a reformatted table cannot pass vacuously green).

**Traceability is enforced by a meta-test.** A dedicated test reads [REQUIREMENTS.md](REQUIREMENTS.md), extracts every `[v1]` requirement's named test, and asserts that test exists in the suite. A requirement whose test is missing turns the suite red. This is the mechanism that keeps requirements and tests from silently drifting apart, and it is why *a requirement that cannot name a test is not a requirement.* Traceability runs both directions: each test is tagged with the `REQ`/`T` id it discharges.

**Coverage policy.** Line coverage is necessary but not sufficient, and we will not fetishize the percentage — 100% coverage of a check that asserts the wrong thing is worthless. We report line coverage as a hygiene floor (no untested paths in the core) and treat **requirement coverage and threat coverage** as the real bar.

---

## 6. Invariants (property-test targets)

These hold for *every* input:

- **INV-1** — No `allow` is ever returned when any applicable cap would be exceeded.
- **INV-2** — Any input that is not a well-formed, in-policy payment returns `deny`. *(Fail-closed fuzzing: it must never allow on garbage.)*
- **INV-3** — Any exception thrown anywhere during evaluation surfaces as `deny`.
- **INV-4** — An `allow` implies the signed struct matches the challenge on `to`, `value`, asset, and `chainId` (binding soundness — what makes the cap/allowlist decision meaningful).
- **INV-5** — Only amounts of the *same* `(asset, chain)` are ever summed against a cap.
- **INV-6** — `evaluate()` is a pure function of its arguments; it reads no wall clock and no randomness internally.
- **INV-7** — No decision path performs I/O or network egress.
- **INV-8** — Every decision carries a stable, machine-readable reason code.
- **INV-9** *(accounting)* — Concurrent evaluations never both consume budget that jointly exceeds a cap; spend is durable and monotonic under normal operation; a clock anomaly never increases available budget or extends a capability. **This invariant must be exercised against the *real* store under *generated* concurrent interleavings at depth — many commits × preemption, not only the pure engine or a handful of low-count races.** The ACCT-05 ABA (§9) lived precisely in the depth×contention corner that hand-written examples cannot reach: it does not exist until the version chain is long enough that cleanup reclaims a version a stalled writer still holds.

**Implemented (fast-check).** `test/properties.test.ts` backs the pure-surface invariants with generated inputs: **INV-1** (no-drain over a random payment sequence — *the* property), **INV-2** (`parsePolicy` / `parseChallenge` / `parseAuthorization` never throw on arbitrary input), **INV-4** (binding soundness — any challenge↔authorization mismatch denies), and the **clock-monotonicity** clause of INV-9 (`applyWindow` never regresses `lastSeen` under any clock sequence). The *concurrent* clause of INV-9 is proven against the real store by the depth-stress e2e (§9), not here — a pure-engine property cannot reach the file-store race, which is the whole lesson of §9. Also implemented: **INV-5** (same-`(asset,chain)` accounting — spend in one denomination never consumes another's cap), **INV-6** (determinism/purity — same arguments → same decision), **INV-8** (every decision carries a non-empty reason code), and **hash-chain any-mutation-fails** (keyed+anchored). Each property is confirmed non-vacuous (it fails against a deliberately broken engine). **INV-7** (no egress in the decision path) is covered statically by PRIV-01 (`core-has-no-egress`), and **INV-3** (any thrown exception surfaces as `deny`) by the engine's fail-closed backstop + INV-2's fuzzing — neither is a generative-property target.

---

## 7. Test vectors and fixtures

- **Derive fixtures from the real x402 schemas, not from our imagination of them.** Challenge and payload fixtures are built from the actual x402 Zod schemas / SDK types (v1 `X-PAYMENT` and v2 `PAYMENT-SIGNATURE` shapes). Where spec prose and the Zod schemas disagree, the schemas win (see [docs/x402-protocol-notes.md](docs/x402-protocol-notes.md)).
- **A catalog of known-bad inputs**, reused across tests: overpayment (`value > amount`), recipient mismatch (`to ≠ payTo`), long-lived authorization (`validBefore` beyond `maxTimeoutSeconds`), wrong asset/`chainId`, non-`exact` scheme, malformed/oversized/nested JSON, missing required fields.
- **Money edge cases** as a dedicated fixture set: `bigint` boundaries, values that would lose precision as a float, negative, zero, non-integer, and `NaN`/`Infinity` string amounts (MONEY-01).
- **Both wire generations.** Every wire-sensitive test runs against v1 *and* v2 — v1 is what is deployed, v2 is what is current.

---

## 8. What makes a test good — and the anti-patterns we refuse

**A good test:**
- asserts an observable **decision plus the correct reason code** — a test that denies for the *wrong* reason is a false pass;
- stages the actual condition (injects the throw, the malformed field, the concurrent call) rather than asserting an internal flag;
- is deterministic — time and randomness enter only through an injected dependency (INJ-01).

**Anti-patterns, refused explicitly:**
- **Never encode a hole as expected behavior.** The clearest prior-art failure we found was a tool whose own test documented that its pre-flight check evaluated against a zero amount — ratifying the gap as "expected." A test that blesses a known weakness is worse than no test. If a check cannot be made sound, the requirement stays *failing* until the code changes.
- **No happy-path-only suites.** A control without a negative test is untested.
- **Never mock away the security-critical logic** to make a test pass.
- **Never weaken a test to go green.** The requirement is fixed; the code is the variable.

---

## 9. Lessons from a P0 — concurrency invariants need *generated* interleavings, at depth

This section is a durable postmortem, kept here because its lessons are process, not a one-time fix. It records a real over-allow (a violation of INV-9 / ACCT-05) that passed adversarial review **and** a full green suite, and the specific, nameable gaps that let it through — so the next slice near the concurrency core is reviewed and tested against them.

**The bug (ACCT-05 CAS store, shipped in v0.1.4).** The file store commits spend with an OS-atomic compare-and-swap: `link()` the next state to `<ledger>.v<N+1>`, where `EEXIST` means "another writer won this version — conflict, retry." A separate `cleanup` step GCs old version files (`KEEP_VERSIONS = 3`). The two interact fatally: once the chain advances far enough, `cleanup` **deletes a version number a stalled in-flight writer still holds as its `expected`**. That writer's `link()` to the reclaimed hole then *succeeds* — so `link`-`EEXIST`, the CAS's entire conflict signal, silently stops being reliable (a classic **ABA**: the version number was reused after deletion). The stalled writer commits an orphan *below* the true max; `load()` (which reads the max) ignores it, so the **durable ledger stays correct** — but `compareAndSave` returned `true`, so `authorize()` returns a **spurious `allow`**: in production, one real over-cap payment that gets signed and settled. Bounded (one extra payment per occurrence, no compounding), but a genuine violation of the "two processes cannot both pass a cap they jointly exceed" claim. Caught **before publish, before mainnet, before funds** — by an unrelated pack-install test whose CPU contention randomly generated the interleaving, then proven **deterministically** and turned into the regression test.

**Where it slipped, precisely — a scale-and-interaction blind spot, not sloppiness.** Every test we wrote and every adversarial race we ran exercised the CAS at **low version counts**: the smoke test had contention but few commits; the adversarial probes had a few writers but low depth; the unit tests had neither. The ABA *cannot occur* until a writer falls `KEEP_VERSIONS` behind mid-commit, which needs **depth (many commits) × contention (preemption mid-commit) simultaneously** — and no test had both. `cleanup` was reviewed for its *own* correctness (deletes the right files, crash-safe) but never for its *interaction* with the CAS's core precondition. Nobody asked: *what does deleting a version do to a writer still holding that version number?* The answer is visible by inspection — once the question is asked.

**Three durable changes (ranked by leverage):**

1. **Property/stress testing is a required layer for any slice that touches the concurrency core — not a later-chapter nicety — and it runs at depth against the *real* store, not the pure engine.** Example-based tests (ours, the adversarial races, the smoke teeth) each encode an interleaving *a human imagined*; the ABA lived in one nobody wrote. For concurrency invariants, adversarial examples are **necessary but provably insufficient** — you need a harness that *generates* interleavings you didn't conceive. A concurrency-stress property generating "many commits under contention with stalled writers" (INV-9, against `FileSpendStore`) would have found this **by construction**, at the ACCT-05 slice. This is the single highest-leverage change, and the retroactive proof that property-tests belong *alongside* a concurrency slice, not after it.

2. **Review checklist — GC-meets-in-flight (general to any CAS + reclamation system).** When a slice adds a reclamation / cleanup / GC / rotation / pruning step to a system with optimistic concurrency, the review **must** ask explicitly: *"Can reclaiming X break an in-flight operation that still references X?"* Any compare-and-swap plus a garbage collector has this latent question — it is the ABA precondition, and the answer is usually visible by inspection. It is now a mandatory review item, not a thing we hope someone thinks of.

3. **Adversarial concurrency passes run at sustained, production-like depth — not just correctness-demonstrating depth.** GC-vs-writer interactions only exist past a depth threshold; a few writers over a few commits proves the mechanism *works* without stressing the machinery (`cleanup`) that quietly becomes load-bearing under real traffic.

**Meta-lesson — the boring maintenance code next to a security invariant is often *part of* the invariant.** `cleanup` was reviewed as housekeeping ("delete old files, best-effort, can't hurt"). It could hurt: it was silently the thing that broke the CAS's unique-version-forever precondition. The next time a slice adds an innocuous-looking GC/rotation/pruning step near the enforcement core, that is the flag to review it as **enforcement code, not plumbing**.

**Calibration — the process did not fail; it caught this one layer later than ideal.** Defense-in-depth is *supposed* to have the CI/honest-test layer behind the review layer. This was caught before any real harm by an honest test written to prove something else, against a culture that left `main` red and proved the mechanism against its own work rather than burying it. The goal of tightening is to move the catch **earlier** next time — via the layer (property-testing at depth) and the question (GC-vs-in-flight) that convert "a human must imagine this interleaving" into "the machine generates it and the question is mandatory" — not to pretend example-based review of concurrency can ever be made perfect. It cannot; that ceiling is exactly why the other layers exist.

---

## 10. Deferred

Test methodology for code that does not exist yet is evidence of nothing, and would mostly be wrong; so it is defined **when the code it describes exists.** Several items once listed here have since landed and moved into the sections above — adapter/integration testing (wire parsing, interposition actually blocking a real signing call, challenge↔struct correlation per ASM3; see `test/x402-wire.test.ts`, `test/x402-guarded-signer.test.ts`, `test/x402-binding.test.ts`), CI configuration (`.github/workflows/ci.yml`, `release.yml`), and property-based testing. What remains genuinely deferred is test phasing and tooling choices beyond the current runner ([vitest](https://vitest.dev)).

The property-testing library (`fast-check`) is a **dev**-dependency; this does not violate DEP-01, which constrains *runtime* dependencies in the core only.

---

*Provided as-is. This is a working methodology, revised as the guard is built.*
