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
2. **Abuse-case tests** — one or more per threat **T1–T15**, staged as an attack, asserting deny *with the correct reason code*.

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
- **INV-9** *(accounting)* — Concurrent evaluations never both consume budget that jointly exceeds a cap; spend is durable and monotonic under normal operation; a clock anomaly never increases available budget or extends a capability.

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

## 9. Deferred

Test methodology for code that does not exist yet is evidence of nothing, and would mostly be wrong. The following are defined **when the code they describe exists**: adapter/integration testing (wire parsing, interposition actually blocking a real signing call, challenge↔struct correlation per ASM3), test phasing, specific tooling choices beyond the current runner ([vitest](https://vitest.dev)), and CI configuration.

Note that a property-testing library will be a **dev**-dependency; this does not violate DEP-01, which constrains *runtime* dependencies in the core only.

---

*Provided as-is. This is a working methodology, revised as the guard is built.*
