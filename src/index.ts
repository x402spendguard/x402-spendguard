// The public API surface — the SOLE entry point of the published package (`exports` exposes only
// this barrel; every other module is unreachable by construction). What appears here is a FOREVER
// contract: adding an export is conventionally a minor, backward-compatible change; removing or
// renaming one is a breaking change. So this surface is deliberately MINIMAL — promote a symbol
// here only when a real consumer needs it. The frozen-surface test (test/packaging.test.ts,
// PKG-01) fails the build if this set changes without a deliberate edit.
//
// Value exports are the frozen list checked by PKG-01. Type-only exports carry no runtime binding;
// they name the arguments and returns of the values above so a consumer can annotate their code.

// ── Construct & wire (the documented flow) ─────────────────────────────────────────────────────
export { SpendGuard } from "./accounting/guard.js";
export { LoggingGuard } from "./audit/decision-log.js";
export { createSpendGuardBinding } from "./adapters/x402-binding.js";
export { FileSpendStore } from "./adapters/file-spend-store.js";
export { systemClock } from "./adapters/system-clock.js";
export { loadPolicyFile } from "./adapters/policy-file-loader.js";
export { parsePolicy } from "./parse.js";
// Build a caps key (`chain|token`) by construction rather than hand-concatenating the composite
// string — the #1 policy-authoring error surface. `caps` is keyed by `AssetKey`; `assetKey({chain,
// token})` produces one correctly, and a wrong-shaped key can't be typed by accident.
export { assetKey } from "./parse.js";

// ── Audit (opt-in, tamper-evident) ─────────────────────────────────────────────────────────────
export { HashChainDecisionLog } from "./audit/hash-chain-log.js";
export { sha256ChainHasher, hmacChainHasher } from "./audit/chain-hasher.js";

// ── Errors a consumer catches ──────────────────────────────────────────────────────────────────
export { PaymentBlockedError } from "./adapters/x402-guarded-signer.js";
export { SnapshotUnreadableError } from "./accounting/snapshot.js";

// ── Seams you implement (the trust-model reversal seam: supply a hardened store/log on a shared host)
export type { SpendStore, Clock, Version } from "./accounting/guard.js";
export type { DecisionLog, Authorizer, LogEntry } from "./audit/decision-log.js";
export type { ChainHasher } from "./audit/chain-hasher.js";

// ── Types you name in signatures ───────────────────────────────────────────────────────────────
export type { VerifyResult } from "./audit/hash-chain-log.js";
export type { SpendGuardBinding } from "./adapters/x402-binding.js";
export type { Result } from "./parse.js";
export type {
  Policy,
  Caps,
  AllowlistEntry,
  AssetId,
  AssetKey,
  Verdict,
  PolicyDecision,
  PaymentEvaluation,
  Challenge,
  Authorization,
  SpendState,
  Snapshot,
  DenominationSnapshot,
  DomainSnapshot,
  // branded primitives — you read these off Policy/Snapshot; construct a Policy via parsePolicy/loadPolicyFile
  Amount,
  UnixSeconds,
  Address,
  ChainId,
  Domain,
  OpaqueHex,
} from "./types.js";
