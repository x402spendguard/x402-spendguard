# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and versions follow
[Semantic Versioning](https://semver.org/). **This project is in `0.x` and is NOT
stable — anything may change until `1.0.0` is earned.**

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
