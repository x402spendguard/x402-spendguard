# Roadmap / backlog

Tracked future work, with the rationale and the decision record behind each item — so a
deferral is a *named thing on a list*, not a comment that evaporates when a slice merges.
This is honest scope, not a promise of dates. `0.x` is pre-alpha; anything may change.

Convention: each item names its **gate** (what must be true before it ships) and links the
[decision record](decisions.md) or [requirement](../REQUIREMENTS.md) that governs it.

## Next slices (near term)

- **SDK adapter — the drop-in integration.** **v2 + v1 wire paths DONE** (D-026, D-027): wire
  normalization for both generations, the signer-wrap veto core, transport-capture for honest
  DOM-01, and the `createSpendGuardBinding` drop-in, all against verified `@x402/core@2.18.0`. The
  v1 path proved small once source-verified — the current `@x402/core` client fires
  `onBeforePaymentCreation` and signs via the same `signTypedData` for BOTH generations, so one
  hook dispatches on `x402Version` and only the challenge shape (loose network name,
  `maxAmountRequired`, offer-level resource) differs. **Remaining:** **live-flow integration
  testing** against a testnet/facilitator (not unit-testable in-repo) — the harness below.
  (THREAT_MODEL ASM3; REQUIREMENTS DOM-01.)

- **Adapter veto hardening — blocklist → allowlist (post-review residual, non-blocking).** The
  signer wrap spreads the inner signer, then overrides the three known signing methods
  (`sign`/`signMessage`/`signTransaction`) to fail closed — covering every route to the EIP-3009
  signature *today*, but a *future* viem/SDK signing method would be re-exposed by the spread. The
  durable pattern is an **allowlist**: return only `address` + the guarded `signTypedData` +
  explicitly-named non-signing methods. (Opus, D-026.) **This residual is invisible to the
  deny-path e2e harness by construction** (its canary exposes only 4 methods) — the *only* test
  that will force it is the funded-settle milestone's real-`LocalAccount` acceptance criterion
  (D-028). Do the allowlist refactor with that test in hand. *Minor, related:* the interleave check
  compares the challenge by reference, so a re-parsed-equal challenge re-observed before `consume`
  fails closed (the safe direction) rather than being treated as idempotent.

- **Live e2e harness — DENY PATH DONE (D-028); funded settle path remains.** The deny-path
  milestone shipped: the real `@x402` client (both generations) driven through a genuine 402 over
  localhost, with our binding installed, blocks a bad payment and reaches a signature **only** via
  the wrapped `signTypedData` (Finding A, in the wild) — asserted with a canary signer, so **no key
  and no funds** are involved. Lives in `test/e2e/` (never imported by `src/`, no-egress proof
  intact), opt-in `npm run test:e2e` + a separate CI job, never the green-main gate; `.env*`
  gitignored except `.env.example`. **Remaining — the funded settle path:** one *policy-compliant*
  micro-payment that actually settles on a testnet facilitator (base-sepolia), proving the happy
  path end-to-end. This is the only part that moves value: it needs a **funded testnet wallet**
  (key from the untracked `.env`) and stays out of automated CI. **Acceptance criterion (Opus,
  D-028):** it MUST drive a **real viem `LocalAccount`** (not the 4-method canary) and assert **no
  un-blocked signing route** across its full method surface — this is the ONLY test that will ever
  exercise the blocklist→allowlist residual against a real signer, so it is a hard requirement of
  this milestone, not a comment. **Until it exists, do not place this in front of a funded wallet.**
  (D-028; THREAT_MODEL ASM3.)

- **Read APIs for dashboard integration — pull, not push.** Surface what the guard captures so
  others can build their own dashboard tech, WITHOUT the guard ever egressing. The distinction:
  a read interface (the user pulls their own data locally) is not egress; only the guard
  *initiating* an outbound send is. Ladder, tightest first: (1) the **JSONL decision log already
  is the read API** (structured, `v:1`, `0o600`); (2) a read-only in-process **`snapshot()`**
  (current spend per (domain,asset), cap headroom, window, halt) — **the cheap first step, fully
  in-boundary**; (3) optional, opt-in, *separate* module — a **loopback-only, read-only** local
  endpoint for a separate-process UI (never in core); (4) **not ours** — the fleet collector /
  cross-machine aggregation (management edge): the integrator builds it on their infra with their
  egress decision, atop our read interface. The read surface must be a documented, versioned
  contract. The guard stays a data *source the user controls, never a sender* — the inverse of
  Sentinel. (Management-edge egress is still converge-first, likely with Opus.)

- **Dev-tooling vulnerabilities.** `npm audit` flags a critical/high/moderate in the
  `vitest`/`vite`/`esbuild` dev tree (dev-server / UI-server issues) — **dev-only, not shipped**
  (runtime `npm audit --omit=dev` = 0). Fix = upgrade `vitest` to 4.x (a breaking change); evaluate
  and do it deliberately. Not blocking; surfaced when `@x402` was added (which itself added none).

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
