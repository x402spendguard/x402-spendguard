# Roadmap / backlog

Tracked future work, with the rationale and the decision record behind each item — so a
deferral is a *named thing on a list*, not a comment that evaporates when a slice merges.
This is honest scope, not a promise of dates. `0.x` is pre-alpha; anything may change.

Convention: each item names its **gate** (what must be true before it ships) and links the
[decision record](decisions.md) or [requirement](../REQUIREMENTS.md) that governs it.

## Next slices (near term)

- **SDK adapter — the drop-in integration.** DOM-01 origin derivation (from the client-observed
  request, never a server field), v1/v2 wire parsing, interposition at the payment-creation hook /
  signer wrap, the ASM3 challenge↔struct correlation, and the L4 brand-runtime invariant at the
  composition root. This is the slice that turns the core into something you install. (THREAT_MODEL
  ASM3; REQUIREMENTS DOM-01.)

- **Verifiable audit log.** Bundle three related audit-integrity items into one slice, because they
  solve the same problem — *can a reader trust this trail wasn't truncated or forged?*
  - **Sequence number (detectable loss).** A monotonic per-entry `seq` so a reader can *detect* a
    missing entry, not just have a failure swallowed silently. Must be monotonic **across restarts**
    (seed from the log tail on startup) or every restart is a false gap — a real sub-feature.
  - **Tamper-evidence (hash chain).** Each entry carries the prior line's hash, so deletion/forgery
    is detectable. Until then: *log integrity == filesystem permissions* (documented, not claimed away).
  - **Rotation / size cap.** Unbounded growth lets attacker-driven volume fill the disk, which then
    triggers the swallowed-loss path above. (Decision record: D-025, findings Q2/F4/F5.)

## Tracked deferrals

- **ACCT-05 — cross-process spend integrity.** The bundled file store has no cross-process lock;
  two processes on one wallet can under-count. The fix is an **architectural fork, not "which lock"**
  (single-owner authorizer vs a transactional store vs an external store) — decided *before* the code,
  because it's the same fault as the read-only/serverless silent fail-open. **Gate: converge on which
  deployment topologies to honestly support; land before the npm-publish gate.** (D-021, D-024; ASM6.)

- **L2 — ledger-file permission check.** The decision log is now created `0o600` (D-025 F2); the
  symmetric world-writable check on the `FileSpendStore` ledger is still owed — a one-line mirror of
  CONF-01. **Gate: converge (pulling a deferred item forward is a scope call, per D-024).** (D-022, D-025.)

- **CONF-02 — name the policy-parse behavior as a requirement.** `parsePolicy`'s parse-into-`Policy`
  contract is tested but has no requirement ID. **Gate: Kevin ratifies.** (D-024.)

- **Surface audit-write failures (operationally).** A failing sink is swallowed (correct — must not
  flip a verdict) but currently invisible to the operator. Folds into the verifiable-audit-log slice
  or an injected error callback. (D-025, FAIL-03.)

## Cross-cutting (ongoing)

- **Property tests** (add `fast-check` as a dev dependency) and **full T1–T15 abuse-case coverage**
  against the threat model.
- **npm-publish gate** — the SemVer 0.x publish milestone (D-020). Gated on the SDK adapter and
  ACCT-05 being resolved-or-honestly-scoped.

## v2 / explicitly out of scope for v1

Not deferrals to schedule — ratified scope cuts, each documented so the boundary is loud:
replay/nonce protection (nonce is carried-unread; L3 length check is v2), the `upto` scheme (ASM4),
non-EVM chains (ASM5, D-017), enforcement against a compromised agent process (A5), and
budget-exhaustion reconciliation on settlement failure (M3). See THREAT_MODEL §6 and the decision record.
