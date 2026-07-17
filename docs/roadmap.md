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

- **Adapter veto hardening — blocklist → allowlist. DONE (D-029).** `guardedSigner` now exposes a
  curated allowlist (guarded `signTypedData` + non-signing passthroughs), not a spread of the inner
  signer — so present-and-future alternate signing routes are absent, not an enumerated blocked
  subset. This closed a **demonstrated** leak: a real viem `LocalAccount`'s `signAuthorization`
  (EIP-7702) was passing through the old spread unguarded. Proven both directions in the default
  gate (a real `LocalAccount`: no un-blocked route by reference + keys ⊆ allowlist; and an e2e
  ALLOW proving the curated surface still satisfies the real SDK). *Residual, minor:* the interleave
  check compares the challenge by reference, so a re-parsed-equal challenge re-observed before
  `consume` fails closed (the safe direction) rather than being treated as idempotent — leave as is.

- **Live e2e harness — DONE (D-028 deny path, D-029 route-completeness, D-030 funded settle).**
  Deny path: the real `@x402` client (both generations) driven through a genuine 402 over localhost,
  blocking a bad payment and reaching a signature **only** via the wrapped `signTypedData` (canary
  signer, no funds). Funded path: **validated live** — a compliant payment settled 0.01 USDC on Base
  Sepolia (tx `0x3231d02f…d1316c`), guard-allowed + recorded, real `LocalAccount` signing through
  the allowlist wrap, `x402.org` facilitator verify+settle (gasless payer). The funded test
  **self-skips** without `TESTNET_PRIVATE_KEY` so `npm test`/CI stay hermetic; opt-in via
  `npm run test:e2e:funded`. Runbook: `test/e2e/FUNDED.md`. Lives in `test/e2e/` (never imported by
  `src/`, no-egress proof intact); `.env*` gitignored except `.env.example`. **The whole adapter arc
  (D-026→D-030) is now proven end-to-end on real hardware.** (THREAT_MODEL ASM3.)

- **Read APIs for dashboard integration — pull, not push.** Surface what the guard captures so
  others can build their own dashboard tech, WITHOUT the guard ever egressing. The distinction:
  a read interface (the user pulls their own data locally) is not egress; only the guard
  *initiating* an outbound send is. Ladder, tightest first: (1) the **JSONL decision log already
  is the read API** (structured, `v:1`, `0o600`); (2) a read-only in-process **`snapshot()`** —
  **DONE (D-033)**: current spend per (domain,asset), cap headroom, window, halt; pure
  `projectSnapshot` + `SpendGuard.snapshot()`; lock-free (rides the store's retried `load()`),
  read-only (never writes/persists), fails **loud** (`snapshot.state_unreadable`) never fabricating
  zeros, honest (surfaces write-ahead over-count, hides no denom); SNAP-01..03; (3) optional, opt-in, *separate* module — a **loopback-only, read-only** local
  endpoint for a separate-process UI (never in core); (4) **not ours** — the fleet collector /
  cross-machine aggregation (management edge): the integrator builds it on their infra with their
  egress decision, atop our read interface. The read surface must be a documented, versioned
  contract. The guard stays a data *source the user controls, never a sender* — the inverse of
  Sentinel. (Management-edge egress is still converge-first, likely with Opus.)

- **Dev-tooling vulnerabilities.** `npm audit` flags a critical/high/moderate in the
  `vitest`/`vite`/`esbuild` dev tree (dev-server / UI-server issues) — **dev-only, not shipped**
  (runtime `npm audit --omit=dev` = 0). Fix = upgrade `vitest` to 4.x (a breaking change); evaluate
  and do it deliberately. Not blocking; surfaced when `@x402` was added (which itself added none).

- **Verifiable audit log — integrity core DONE (D-036).** The decision log is now tamper-**evident**:
  per-entry `seq` + a hash chain (each record commits to the prior via an injected `ChainHasher`
  seam — unkeyed SHA-256 default, pluggable to keyed HMAC), `verify({expectedHead?})` (anchor-relative:
  self-verify is a health check, an external anchor or keyed mode catches a full rewrite), and
  `onAuditFailure` surfacing (the swallowed-sink gap closed). Framed detection-not-prevention +
  forensic-not-enforcement (a broken chain surfaces loud, never gates a payment — can't be a DoS),
  consistent with the trust model (THREAT_MODEL §3). AUDIT-01..03. Seq monotonic across restarts
  (seeded from the log tail; a **torn head** fails loud + restarts a fresh genesis whose discontinuity
  is visible in `verify()`). **Fast-follows (deliberately split for undiluted review of the security
  core):**
  - **Rotation / size cap.** Unbounded growth lets attacker-driven volume fill the disk. Cross-segment
    chain linkage is designed-in (a new segment's genesis `prev` = prior head). (D-025 Q2/F4/F5.)
  - **Cross-process-log CAS.** Two processes sharing one log file can fork the chain; today `verify()`
    **detects** the fork (fail-loud, forensic-only) — a CAS-for-the-log (mirroring the ledger, D-031)
    would *prevent* it. Gated on a real multi-writer-one-log need. (D-036.)

## Tracked deferrals

- **ACCT-05 — cross-process spend integrity. DONE (D-031).** Closed by a **topology-agnostic
  versioned (compare-and-swap) store seam**: the guard's `SpendStore` is now load-with-version /
  save-if-unchanged; the bundled `FileSpendStore` implements it with a genuine OS-atomic `link()`
  (create-or-`EEXIST`), a **concurrent** startup probe that refuses-closed on a filesystem that can't
  prove atomic exclusive-create (+ a known-unsafe-mount denylist), keep-last-3 cleanup, and bounded
  fail-closed read-retry. The guard runs a bounded CAS retry loop that re-evaluates on conflict and
  denies on exhaustion. Unifies ACCT-02 + ACCT-05 (one mechanism, two scopes) and closes the ASM6
  silent fail-open (refuse loud). Chosen over single-owner/lock/external via the tier lens (D-031).
  **Validated (D-032):** a genuine **multi-process** smoke test (`cross-process-smoke.e2e.test.ts`)
  spawns N real OS processes racing on one `FileSpendStore`; against a cap admitting exactly M
  payments they admit exactly M and the ledger records every one (no lost updates). A teeth case
  (the same harness on a non-CAS store must OVER-allow) proves the gate isn't vacuous and is
  **CI-verified** (`e2e` job sets `SMOKE_TEETH=1`, `retry: 3` absorbs scheduling jitter). This retires the README's
  "one instance per wallet" hedge **for the same-host case**. **Multi-*host* is a separate item:**
  it needs a networked FS (which the store refuses) → an external CAS store adapter, not a shared
  file — folds into the store-adapters line, not a file-store gap.

- **L2 — ledger-file permission check. DONE (D-034).** The `FileSpendStore` ledger now mirrors both
  patterns: version files are **created `0o600`** (owner-private at rest — PRIV-04) and a
  **world-writable** ledger is **refused** on read before its bytes are trusted (integrity, the
  CONF-01 mirror — ACCT-06). Scoped to the world-write bit on the **file** (consistent with CONF-01);
  the world-writable-**directory** vector (equally applicable to `policy.json`) is deferred to a
  future *uniform* dir-perm pass, documented rather than half-addressed. Kevin pulled this forward
  from the snapshot privacy discussion (it's the real "who-else-on-this-box" surface). (D-022, D-025.)

- **Windows platform-guard for the perm gates. DONE (D-035).** The POSIX mode-bit refusals
  (CONF-01 policy, ACCT-06 ledger) are now **skipped on Windows** (`process.platform === "win32"`)
  via a single guarded predicate (`modeIsWorldWritable`), where Node synthesizes `0o666` and an
  unguarded check would **misfire into a deny-all** (not merely no-op) — a latent brick, invisible
  because dev/CI is Linux/WSL2. Windows privacy/integrity rest on NTFS ACLs (`%LOCALAPPDATA`);
  a full ACL adapter is a future opt-in (needs `icacls`/native → out of the zero-dep core). PLAT-01.
  Surfaced by Kevin's "what about Windows users?" question. **Still owed:** verification on real
  Windows (can't from Linux/WSL2), and the deferred *uniform dir-perm pass* noted under L2.

- **CONF-02 — name the policy-parse behavior as a requirement.** `parsePolicy`'s parse-into-`Policy`
  contract is tested but has no requirement ID. **Gate: Kevin ratifies.** (D-024.)

- **Surface audit-write failures (operationally). DONE (D-036).** Folded into the audit-log slice: an
  injected `onAuditFailure` on `LoggingGuard` surfaces a failed append (and a torn head) to the
  operator; the verdict stays structurally independent (FAIL-03). (D-025, D-036, FAIL-03.)

## Cross-cutting (ongoing)

- **Property tests** (add `fast-check` as a dev dependency) and **full T1–T15 abuse-case coverage**
  against the threat model.
- **npm-publish gate** — the SemVer 0.x publish milestone (D-020). The **publishable artifact is
  built + pack-verified (D-037)** and the **release pipeline is armed**: `.github/workflows/release.yml`
  publishes with **provenance** on a `vX.Y.Z` tag, gated behind the full suite + a tag↔version guard;
  runbook + npm-account checklist in [releasing.md](releasing.md). The version is **held at 0.1.4** —
  the `0.2.0` bump + first publish follow the **property-test pass** (build-the-artifact → property-test
  the pinned surface → publish). Owed by the maintainer before first publish: reserve the name, 2FA, and
  a scoped `NPM_TOKEN` (or Trusted-Publishing OIDC).

## v2 / explicitly out of scope for v1

Not deferrals to schedule — ratified scope cuts, each documented so the boundary is loud:
replay/nonce protection (nonce is carried-unread; L3 length check is v2), the `upto` scheme (ASM4),
non-EVM chains (ASM5, D-017), enforcement against a compromised agent process (A5), and
budget-exhaustion reconciliation on settlement failure (M3). See THREAT_MODEL §6 and the decision record.
