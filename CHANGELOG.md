# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and versions follow
[Semantic Versioning](https://semver.org/). **This project is `0.x` (pre-1.0): the public API may change between releases, and it is
not yet production-ready.**

## [0.7.0] — 2026-08-03

Additive since 0.6.0 — the **config-linter + wrap-up** chapter. No breaking change.

### Added
- **Policy linter — `lintPolicy` (LINT-01).** An advisory, pure check for *structural contradictions*
  in a parsed policy: a **dead cap** (caps not in `perRequest ≤ perDomain ≤ global` order, so the
  outer cap can never bind), an **unpayable allowlist entry** (a destination allowlisted on a chain
  with no caps denomination — CAP-05 denies every payment to it), and the mirror **unreachable
  denomination**. It reports *contradictions, never choices* (mechanism-not-policy): it never judges a
  cap value, only flags a cap that is structurally inert. Advisory-only — it never gates enforcement;
  `parsePolicy` stays the trust gate. New barrel exports: `lintPolicy`, and the `PolicyLintFinding` /
  `PolicyLintKind` types. (D-043.)

### Fixed
- **Export writers no longer crash on a missing parent directory.** `writeSnapshotExport` /
  `writeAuditExport` threw `ENOENT` when the target's parent did not exist — and the README's own
  `./export/snapshot.json` example triggered it. They now create the parent recursively, owner-only
  (`0o700`, matching the `0o600` file), so a fresh export subdirectory just works; an existing dir's
  mode is left untouched.

### Security / internal
- **The no-egress static proof is now non-vacuous, and the core provably cannot spawn a subprocess
  (D-042).** The import-denylist half of the no-egress proof matched module bans against
  string-stripped code, so the module specifier was blanked before the pattern ran — a planted
  `node:net` import passed the "no-egress" test. Fixed (comment-stripped-but-string-kept matching,
  mutation-proven across static/dynamic/`require` forms), and `child_process` / `http2` are now
  genuinely forbidden in the core. No runtime behavior change — the guarantee was always true, but now
  the proof actually backs it.

### Docs / tooling
- `npm run verify` mirrors CI locally (typecheck + test + the generated-artifact staleness gates that
  live outside `npm test`). The guard is now dogfooded against the published `x402-bench`. README
  stranger-readiness fixes: a peer-install prerequisite for the wiring examples, clone-context on the
  from-source `npm test` block, and absolute repo URLs for the documentation index + demo GIF so they
  resolve from a locally-installed README too.

## [0.6.0] — 2026-07-28

Additive since 0.5.0 — the **integration + decision-sink** chapter. No breaking change.

### Added
- **The decision sink — alerting without the core ever reaching out.** `readDecisionLogAfter(path,
  afterSeq)` is an out-of-process cursor reader of the durable decision log (the same seam the
  dashboard reads): it tracks the record's `seq`, resumes across restarts, and drops nothing because
  the log *is* the buffer — so a slow notifier can never add latency to a payment. `toAlert(record)`
  is the **redacted-by-default** notification projection (**ALERT-01**): it carries the *fact* of a
  decision (`seq`/`at`/`verdict`/`reason`) and, by construction, **not** the counterparty tuple
  (`to`/`origin`/`amount`), because a notification is the one artifact that leaves the machine — the
  `seq` points at the full record in the local, owner-only log. The **send** lives only in an
  operator-wired notifier outside the core (never `src/`), so the no-egress proof holds. A complete
  runnable reference is `scripts/decision-notifier.ts` (`npm run notify`). New barrel exports:
  `readDecisionLogAfter`, `toAlert`, and the `Alert` / `ChainedRecord` types.

### Fixed
- **`@x402/fetch` composition — the guard now vetoes through the standard high-level paid-fetch.**
  `wrapFetchWithPayment` hands the inner fetch a `Request` object; `guardedFetch` was deriving the
  origin via `String(input)` (`"[object Request]"`, not the URL), so origin capture silently broke
  and every payment through the real wrapper failed **closed** on `context_incomplete`. It now reads
  the URL from `string | URL | Request` (structural, no DOM dep), and `FetchLike` is widened so
  `wrapFetchWithPayment(wrapFetch(fetch), client)` type-checks. Proven end-to-end in
  `test/e2e/integration-fetch.e2e.test.ts`. (It failed closed — a false deny, never a false allow.)

## [0.5.0] — 2026-07-27

Closes **Finding D** — the one place the wiring API could fail **open, silently**. The guard's power
is the signer wrap (the veto); the removed `createSpendGuardBinding` handed the caller a free-floating
`wrapSigner` they had to remember to apply *and* thread into scheme registration. Forgetting it (or
registering the raw signer) meant every payment was signed unchecked, with nothing to self-detect —
the cardinal sin for a guard. This release makes that state **un-expressible**, not merely documented.

**Breaking change** (cheap now — `0.x`, no consumers yet to break). If you wired the guard, replace
`createSpendGuardBinding` with `installSpendGuard`:

```ts
// before (0.4.x): three pieces, wrapSigner easy to forget → silent fail-open
const binding = createSpendGuardBinding(guard);
registerExactEvmScheme(client, { signer: binding.wrapSigner(signer) });
client.onBeforePaymentCreation(binding.hook);
const guardedFetch = binding.wrapFetch(fetch);

// after (0.5.0): the installer OWNS the wrap + hook; only the fail-closed transport is yours
const { wrapFetch } = installSpendGuard(client, {
  guard,
  signer, // your raw signer — installSpendGuard wraps it and registers the WRAPPED one
  registerScheme: (client, signer) => registerExactEvmScheme(client, { signer }),
});
const guardedFetch = wrapFetch(fetch);
```

### Changed
- **`installSpendGuard(client, { guard, signer, registerScheme })` replaces `createSpendGuardBinding`**
  as the blessed wiring path. It wraps your signer internally and registers the **wrapped** one
  through your one-line `registerScheme` bridge, and it registers the challenge hook itself — so there
  is no signer-wrap step left to forget. It returns only `{ wrapFetch }`; omitting the transport wrap
  fails **closed** (no origin → the guarded signer refuses to sign), so — unlike the old `wrapSigner`
  — nothing on the surface can fail open. The `@x402` scheme registrar is *injected* (not imported),
  so the guard core stays `@x402`-free (no-egress proof + standalone install intact) and works for any
  scheme family. New requirement **WIRE-01**; the real-client deny-path e2e is rewired onto it and
  proven (the veto still fires; verified by mutation — register the raw signer and the suite goes red).

### Removed
- **`createSpendGuardBinding` and the `SpendGuardBinding` type** — the footgun-shaped surface whose
  `wrapSigner` could be silently omitted (Finding D). A deprecated fail-open path is still a reachable
  fail-open path, so it is removed, not deprecated. Use `installSpendGuard` / `SpendGuardInstall`.

## [0.4.0] — 2026-07-26

Adds a **dashboard / export chapter** — a way to *see* the guard working — built as a dump-file the
guard writes plus a single dependency-free static viewer that reads it. **No socket, no server, no
`fetch`**: the export is a file, so the statically-provable no-egress guarantee (the crown jewel)
holds unchanged, at the viewer edge too. Entirely additive: new barrel exports, no breaking change
(the existing API and `dist` decision path are unchanged).

### Added
- **A corruption-resistant export wire format** — `serializeSnapshot(snapshot, opts?)` turns a
  `SpendGuard.snapshot()` into a portable JSON export, and `writeSnapshotExport(path, export)` writes
  it **owner-only** `0o600`, atomically. Money is a **tagged envelope** `{ "$b": "<base-units>",
  "text": "<human>" }`: JSON has no bigint and a base-unit amount routinely exceeds 2⁵³, so a naive
  `Number()` would silently round it into a confident lie — instead a naive parse yields an *object*
  (loudly `NaN`), a program recovers the **exact `bigint`** via `parseSnapshotExport` (the shipped
  reviver), and the `text` is pre-rendered in trusted Node so a viewer displays it and does **no money
  math at all**. Counterparty-origin redaction is an opt-in caller option (default lossless).
- **An audit export + authoritative verify** — `serializeAudit(log)` / `writeAuditExport(path, …)`
  project a `HashChainDecisionLog` into a display-only view (its own `head` + self-consistency, **no**
  self-attested "verified" verdict — a file an attacker could rewrite cannot make one about itself).
  The authoritative check is the operator running `scripts/verify-audit.ts` against a head they
  **pinned out-of-band** (`--expected-head`) or a keyed hasher whose key they hold (`X402_AUDIT_KEY`,
  taken from the env, never argv). A same-directory sibling file is not an anchor.
- **A static export viewer** — `viewer/index.html`, a **single dependency-free HTML file** that reads
  a dumped snapshot or audit export and renders it (spend-vs-caps, the counterparty breakdown, the
  audit head + self-consistency). It **imports nothing and cannot egress** (no `fetch`, socket,
  `<script src>`, or external asset), is **math-free** (displays the pre-rendered `text`, so a >2⁵³
  amount renders exactly and it cannot corrupt an amount on screen), **escapes** attacker-influenced
  counterparty strings, and shows the audit head as a value to **compare** out-of-band — never as a
  verdict. Loads local files only; ships in the repo (like the CLIs), obtained from the repo/release.

### Internal
- **`renderMoneyText`** shared into `src/display.ts` (one source for the pre-rendered `text`, so the
  envelope's `$b` and `text` cannot diverge). New requirements `EXPORT-01/02/03`, `ANCHOR-01`,
  `VIEW-01`; each guarantee is mutation-proven where it guards something, and the viewer tests run the
  **shipped bytes** (the inline logic is extracted from `index.html` and executed) so they can never
  drift from the artifact.

## [0.3.0] — 2026-07-24

Adds a **config on-ramp** — the tooling a new user needs to author, check, and understand a policy —
and closes the one authoring error that fails *open*. Entirely additive: new barrel exports, no
breaking change (the existing API and `dist` decision path are unchanged).

### Added
- **`assetKey({ chain, token })`** — build a `chain|token` caps key by construction instead of
  hand-concatenating the composite string (the #1 policy-authoring error). A wrong-shaped key can no
  longer be typed by accident.
- **A shipped, fail-loud starter policy** — `STARTER_POLICY_JSON` (the file as text) and
  `writeStarterPolicy(path)` (writes it **owner-only** `0o600`, and **refuses to overwrite** an
  existing file). An unedited copy is *rejected* by `parsePolicy` with a specific reason rather than
  silently denying every payment. Also at the repo root as `policy.example.json`. This makes POL-01's
  long-promised "readable default policy file" real (it did not previously exist).
- **The policy echo — `describePolicy(policy, display?)`, `renderAmount`, `parseDisplay`.** Renders
  each cap in human units (e.g. `50.000000 USDC`) so an off-by-a-zero cap — the one authoring mistake
  that fails *open*, since the guard would faithfully enforce the larger ceiling — is visible at
  author time. Renders from user-declared `display` decimals only (no token registry, no lookup, no
  egress; exact integer-string math, never a float) and degrades to exact base units rather than
  guessing. `display` is display-only and structurally cannot affect a decision.
- **A generated, drift-gated deny-reason legend** (`docs/reason-codes.md`) — every code the guard can
  emit, what it means and what to change, grouped by where you encounter it (policy load / payment /
  read API). Generated from the code and CI-checked, so it can never drift or over-claim.
- **Config walkthrough + `examples/`** — the README now carries the complete, copy-runnable on-ramp
  (start from the template → edit → validate-and-echo → look up any deny code), and a runnable
  `examples/configure-and-echo.ts`.

### Internal
- **Central reason-code registry (`src/reasons.ts`)** — one source of truth for every emittable code.
  Two typed partitions make a cross-family code a compile error and a static check forbids raw reason
  literals, so the deny-legend's completeness is *provable*, not enumerated. `INV-8` tightened from
  "non-empty reason string" to "registered reason code".

### Deferred
- **Human decimal-string cap *input*** (`"5.00"` → base units). The echo renders base→human safely;
  accepting human→base input would make `decimals` enforcement-load-bearing and put money arithmetic
  in the tool, so it is its own converge-first slice.

## [0.2.1] — 2026-07-17

Test-hardening only — **no functional or API change** (the published `dist/` is identical to `0.2.0`).
Completes the property-test layer over the enforcement core, and is the first release published
through the **tokenless OIDC pipeline** (Trusted Publishing + provenance, auto-created GitHub Release).

### Internal
- **Property invariants INV-5 / INV-6 / INV-8** (`fast-check`, dev-only): same-`(asset,chain)`
  accounting (spend in one denomination never consumes another's cap), determinism/purity (same
  arguments → same decision), and reason-code observability (every decision carries a non-empty reason
  code). Each **mutation-proven** non-vacuous. This closes the generative-property targets — `INV-7` is
  static via PRIV-01, `INV-3` is the fail-closed backstop + `INV-2` fuzzing. (TEST_PLAN §6.)

## [0.2.0] — 2026-07-17

**First release on npm.** `x402-spendguard` is now `npm install`-able — a single frozen entry point (one public
import path), published from CI with a signed **provenance** attestation so a consumer can verify the tarball
was built from this commit by this workflow. This release also closes a P0 concurrency defect caught
(before any publish or funds) by the new packaging tests, and adds a mutation-proven property-test
layer over the enforcement core. Still pre-alpha (`0.x` — the API may change between releases), still EVM-only, still a
seatbelt for an honest agent that can be lied to — **not** a wall against a compromised one. See
[SECURITY.md](SECURITY.md); do not place it between an agent and a mainnet wallet.

### Added
- **A single, frozen public API surface (`src/index.ts`).** One barrel is the *sole* entry — the
  `exports` map exposes only `.`, so a deep import (`x402-spendguard/…/internal`) throws
  `ERR_PACKAGE_PATH_NOT_EXPORTED` at runtime **and** cannot type-resolve under `nodenext` (the "sole
  path by construction" discipline of the signer wrap, applied to the package boundary). The surface
  is a **deliberate, minimal allowlist** — "don't break userspace": adding an export is a
  conventionally-compatible minor change, removing one is a break, so we ship the minimum and a
  build-failing freeze test (PKG-01) keeps it from drifting in on an unrelated change.
- **A clean, `dist`-only build (`tsconfig.build.json`).** Emits compiled JS + declarations from `src`
  only — never the test tree — rooted so output is `dist/index.js`. **No source maps** (a shipped map
  would dangle against un-shipped source, or leak an absolute local path), zero runtime dependencies
  carried through.
- **A pack-and-install honesty gate (`test/e2e/pack-install.e2e.test.ts`).** Runs `npm pack`, unpacks
  the real tarball into a throwaway `node_modules`, imports **only** the barrel and runs the guard,
  then asserts a runtime deep-import throws, a **type** deep-import fails `tsc`, and the shipped file
  list contains no `.ts`/`.map`/test code/secret. The integration proof behind the PKG-01…05 hermetic
  requirements — the packaging analog of the cross-process smoke test.
- **Property-based tests (`fast-check`, a dev-only dependency).** Generative coverage of the core
  invariants — no-drain, fail-closed parsing, binding soundness, clock monotonicity, and hash-chain
  any-mutation-fails (keyed+anchored) — over the pure engine and accounting. Each was confirmed
  **non-vacuous by mutation** (it fails against a deliberately broken implementation). (TEST_PLAN §6.)
- **An armed, hardened release pipeline (`.github/workflows/release.yml`).** Publishes on a `vX.Y.Z`
  tag with `npm publish --provenance`, gated behind the full test suite (hermetic + the pack-install
  and smoke-teeth e2e), and refusing to publish a commit that is **not on `main`** or a tag that
  disagrees with `package.json`. Runbook + credential guidance in [docs/releasing.md](docs/releasing.md).

### Fixed
- **Cross-process over-allow under sustained contention (ACCT-07, the cleanup/CAS ABA).** A P0 in the
  0.1.x spend store: the CAS committed by `link()`-ing to a version *number*, and the version GC
  (`cleanup`) freed old numbers — so a writer stalled mid-commit could `link()` into a reclaimed
  number and commit a **spurious `allow`** past the cap (one real over-cap payment; the durable
  ledger stayed correct, so bounded, not a drain). Fixed with a **derived-floor guard**: a commit at
  or below `highestVersion() − KEEP_VERSIONS` is rejected as a conflict, pre- and post-`link`. Proven
  by a deterministic regression (red without the fix) and a depth×contention stress test with a
  process that mechanically asserts the store's version never goes backwards. Found by the new
  pack-install test's contention, before any publish or funds; postmortem + the process changes it
  drove are in [TEST_PLAN.md](TEST_PLAN.md) §9.

### Security
- **The published artifact is `dist`-only and zero-runtime-dependency** — no source, no maps, no test
  code (the only network-capable code in the repo), and **no install-time scripts** (no `postinstall`).
  Proven against a real tarball by the pack-install gate. The `@x402` packages remain *optional peer*
  dependencies. **Provenance** attestation on the published package ties the tarball to the reviewed
  commit and the CI build; the release pipeline refuses to publish a commit that is not on `main`, so
  the attestation never vouches for unreviewed code.

## [0.1.4] — 2026-07-17

Correctness, at-rest hardening, and honesty. Closes the last load-bearing correctness gap
(cross-process spend integrity), adds a read API and a tamper-evident audit log, hardens the
ledger at rest, fixes a latent Windows brick, and writes down the trust model. Still pre-alpha,
still source-only.

### Added
- **Cross-process spend integrity (ACCT-05).** The store is now a topology-agnostic versioned
  **compare-and-swap** contract — two processes on one wallet's ledger can no longer both pass a
  cap they jointly exceed (a losing writer is *told* it lost, instead of a silent last-write-wins
  under-count). Genuine OS-atomic `link()`; refuses (fail-closed) a filesystem it can't prove
  atomic, and NFS/SMB by name. **Validated across real separate OS processes.**
- **`snapshot()` — a read-only, pull view of current spend vs. caps.** In-process, owner-only;
  never transmits. Fails loud on an unreadable store rather than fabricating a zeroed view.
- **Tamper-evident audit log.** The decision log is a hash chain (`seq` + prior-hash + payload-free
  entry); `verify()` detects deletion/edit/reorder. Pluggable integrity seam — unkeyed SHA-256 by
  default or a keyed HMAC you supply. Honest by construction: self-verify is a health check; a full
  rewrite is caught only against an externally pinned head or in keyed mode (in the
  `verify({expectedHead?})` signature). Failed writes surface to the operator; being forensic, not
  enforcement, a broken chain never blocks a payment.
- **Requirements-traceability matrix ([TRACEABILITY.md](TRACEABILITY.md)).** Every requirement →
  its verifying test(s) → status, generated from the suite (`npm run traceability`) and CI-checked
  so it can never drift from reality.

### Security
- **The spend ledger is protected at rest.** It is created owner-only (`0o600`), and the guard
  refuses to trust a world-writable ledger file — one anyone could tamper with to reset your spend.
  These are POSIX permission checks; on Windows, which uses ACLs rather than Unix mode bits, they are
  **skipped**, because applying them there would wrongly refuse every ledger and disable the store.

### Notes
- **Trust model, stated.** The guard is as secure as the isolation boundary it runs inside; at-rest
  hardening is *opportunistic*, never a substitute for that boundary, never a pretense where it
  can't be delivered — the same true statement on every OS. A shared multi-user host wants a
  hardened store, which the store interface lets you supply. (THREAT_MODEL §3.)
- **Still source-only.** Feature-complete for v1's anti-drain + integrity scope, not yet on npm
  (next chapter). Zero runtime dependencies; `@x402` stays an optional peer dependency. Fast-follows:
  audit-log rotation, cross-process-log integrity, and confirming the Windows fix on a real Windows
  runner (it's currently verified with a simulated platform, since CI runs on Linux).

## [0.1.3] — 2026-07-13

The adapter is now **proven end to end on testnet**: the guard installs in front of a real
x402 client, blocks a bad payment, and lets a compliant one settle on-chain — validated live
on Base Sepolia. Both x402 generations, and a hardened veto. Still pre-alpha, still testnet.

### Added
- **x402 v1 wire path.** The adapter now speaks **both** x402 generations. The same guard, one
  payment hook, dispatched on the protocol version — v1's legacy shape (`maxAmountRequired`,
  loose network names like `base-sepolia`) is normalized to the same trustworthy challenge the
  v2 path uses. An unknown v1 network fails closed. (A bonus falls out: because the guard binds
  `value == amount`, it denies the v1 overpayment vector the ecosystem otherwise waves through.)
- **Live-flow end-to-end tests** (`test/e2e/`, opt-in — never part of the default test run).
  - **Deny path** drives a *real* `@x402` client through a genuine 402 and proves the guard
    blocks kill-switch / off-allowlist / over-cap payments — on both generations — reaching a
    signature **only** through the guarded route. Hermetic: no key, no funds.
  - **Funded settle** proves a *compliant* payment actually settles: a real funded signer signs
    through the guard, and a real facilitator verifies and settles it on Base Sepolia. Validated
    live (0.01 USDC, on-chain tx). It **self-skips** unless you provide a testnet key, so the
    default suite and CI never move funds. Runbook: [`test/e2e/FUNDED.md`](test/e2e/FUNDED.md).

### Security
- **Signer wrap hardened from a blocklist to an allowlist.** The guard's signer wrap now exposes
  a *curated* surface — the guarded `signTypedData` plus named non-signing reads — instead of
  passing the inner signer through and blocking the routes it knew about. This closed a real
  leak: a standard wallet account (viem `LocalAccount`) exposes a signing method
  (`signAuthorization`) the old blocklist didn't cover, which was reachable unguarded. Now every
  alternate signing route — present or future — is absent by construction, so the wrap is
  structurally the **sole** path to a signature. Verified against a real account in the default
  test suite.

### Notes
- **Testnet, single-agent, single-flow.** This validates the guard is correctly positioned in a
  real settlement flow. It does not cover cumulative spend across concurrent flows, non-EVM
  chains, the `upto` scheme, or mainnet — none of these are addressed at this milestone (what is
  deferred to a later version vs. permanently out of scope is tracked in
  [docs/roadmap.md](docs/roadmap.md)). Zero runtime dependencies remains true; `@x402` stays an
  optional peer dependency.

## [0.1.2] — 2026-07-11

The **drop-in SDK adapter** for x402 v2 — the guard now installs in front of a real x402
client, not just as a core library. Still pre-alpha; not yet validated against a live flow.

### Added
- **`createSpendGuardBinding(guard)`** — binds a guard to the three x402 interposition points
  (signer, payment hook, transport) through one shared correlation context. The veto happens
  at the signer wrap: it binds the **real EIP-712 struct** about to be signed, refuses
  unsupported structs (Permit2 / `upto`), and correlates the client-observed origin + offer +
  struct before allowing the signature. Built against verified `@x402/core@2.18.0`.
- **Honest DOM-01** — the per-domain budget keys on the **client-chosen request host**
  (redirect-immune), never a server-controlled field. Per-domain is a budgeting aid; the
  **global cap is the security boundary** against a payee spread across hostnames.
- **`@x402/core` + `@x402/evm`** as *optional peer* dependencies. Zero runtime deps still
  holds — the core needs no SDK; the adapter binds to the client you already have.

### Security
- Adversarial review (Opus) caught, and we closed, a **veto bypass**: the signer wrap now
  closes *every* signing route (`sign` / `signMessage` / `signTransaction`), not just
  `signTypedData`, since the same authorization signature could be produced by an alternate
  method. Concurrent payment flows on one binding now fail closed rather than mis-attributing
  spend.

### Not yet
- The **v1 wire path** (deprecated but deployed) and a **live testnet end-to-end** harness.
  Until the latter exists, do not place this in front of a funded wallet. See
  [docs/roadmap.md](docs/roadmap.md).

## [0.1.1] — 2026-07-11

Security hardening from two adversarial code reviews, plus the first edge slice: a
policy **config loader**. Still pre-alpha — no live x402 interception yet.

### Added
- **Config loader (CONF-01):** load a policy from a JSON file. The file is parsed into a
  trustworthy `Policy` at the boundary — every field required (no code-side defaults),
  money/time re-parsed through the branded primitives (a bare JSON number is refused, not
  coerced, so no >2^53 precision loss), cap keys re-canonicalized so a mixed-case token
  address can't yield a silently-never-matching cap. Format is JSON, keeping zero runtime
  deps. The loader **refuses a world-writable policy file** (a deterministic startup gate).

### Fixed (security — from adversarial review)
- **Per-domain cap bypass via a `__proto__` origin** — spend maps are now null-prototype and
  read with `Object.hasOwn`; `makeDomain` canonicalizes to a bare lowercased host so
  representation variants can't split a budget bucket.
- **Corrupt/unreadable ledger now denies** instead of throwing — fail-closed extends to the
  accounting layer.
- **Authorization lifetime is bounded by policy, not by the server** — the effective bound is
  `min(server maxTimeoutSeconds, policy maxAuthLifetimeSeconds)`; a malicious server can only
  shorten the window, never extend it.
- **Durable-write integrity** — `fsync` before `rename`, and a unique temp filename so
  concurrent writers can't clobber each other's temp file.

### Known limitation
- The bundled file store still has **no cross-process lock** (ACCT-05): two processes sharing
  one wallet's ledger can under-count. Run one guard instance per wallet until this closes.

## [0.1.0] — 2026-07-10

First public release. **Pre-alpha:** a spend-guard *core*, not yet drop-in. It decides
and accumulates spend correctly and is auditable end to end, but it does not yet
intercept a live x402 client for you (that is the adapter, next).

### Added
- **Documentation, reasoning-first:** threat model, numbered/testable requirements,
  test plan, a decision record (with rejected alternatives), source-verified protocol
  notes, and a prior-art survey.
- **Pure policy engine:** kill switch; destination allowlist and spend caps denominated
  per `(asset, chain)`; signature-integrity binding (`value == amount`, `to == payTo`,
  `validBefore` bounded by the challenge's `maxTimeoutSeconds`, asset/chain match);
  **fail-closed** on any ambiguity. EVM-only, `exact` scheme.
- **Durable single-writer spend accounting:** write-ahead recording (a crash before
  settlement over-counts, never under-counts), async-mutex serialization, monotonic
  clock/window handling, and record-failure-denies.
- **By construction:** zero runtime dependencies; no network egress; branded types that
  make bad states (negative amounts, float money, un-normalized addresses) unrepresentable;
  the signed payload is excluded from the decision core, so it cannot be logged.

### Not yet (deferred — see `THREAT_MODEL.md`, `docs/decisions.md`)
- SDK interception adapter (drop-in x402 integration), decision-log layer, config loader.
- Replay/nonce protection, the `upto` scheme, non-EVM chains, and enforcement against a
  compromised agent process — all v2.

### Security
- **Do not place this between an agent and a funded wallet yet.** It is a seatbelt for an
  honest agent that can be lied to, not a wall against one whose code is owned. See
  [`SECURITY.md`](SECURITY.md).
