# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and versions follow
[Semantic Versioning](https://semver.org/). **This project is in `0.x` and is NOT
stable — anything may change until `1.0.0` is earned.**

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
