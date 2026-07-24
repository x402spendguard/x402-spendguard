// The reason-code REGISTRY — the single source of truth for every stable machine code the
// guard can emit, and the metadata a downstream legend renders from.
//
// WHY THIS EXISTS (two guarantees, both by construction — not by careful enumeration):
//  1. Cross-family safety. A verdict (`PolicyDecision`) must never carry a parse/config code, and
//     a parse `Result` must never carry a verdict code. The two helper families are typed against
//     DISJOINT partitions (`DecisionReason` vs `ConfigReason`), so `deny(CONFIG.cap_key_malformed)`
//     is a COMPILE error, not a runtime surprise that still passes a membership test.
//  2. Completeness. The legend's claim "every code is documented" is only as good as its
//     enumeration of EMISSION SURFACES — and there are more than there look to be (verdicts arise in
//     checks.ts AND guard.ts AND a raw literal in engine.ts; Result failures in parse.ts AND the
//     loader AND wire.ts; plus two thrown error classes and a binding abort). Hand-listing surfaces
//     is fragile. So a static check (see test/reasons.test.ts) forbids any reason-shaped string
//     literal in src/ OUTSIDE this file — every code must originate HERE, whatever its carrier.
//
// Adding a code: add it to the right partition below WITH its metadata. The static check makes an
// un-registered literal fail CI; the legend gate (S5) makes an un-documented code fail CI. You
// cannot ship a code that isn't here, and you cannot ship a code here that the legend doesn't cover.

/** Where in the guard's lifecycle a user encounters a code — the "where will I hit this?" a
 *  stuck user needs. `policy-load` = parsing/loading the policy file; `payment` = evaluating a
 *  payment (verdict, or parsing the server's challenge/authorization); `read-api` = a read method. */
export type ReasonWhen = "policy-load" | "payment" | "read-api";

/** Legend metadata for one code. `detail` on the emitted record is dynamic; THIS is the stable,
 *  user-facing explanation the legend renders. */
export interface ReasonMeta {
  /** What it means, one line. */
  means: string;
  /** What the user should change (or confirmation that the block is correct-by-design). */
  fix: string;
  /** When in the lifecycle it surfaces. */
  when: ReasonWhen;
}

// ── Partition 1: DECISION reasons — carried by `PolicyDecision.reason` (the verdict). ─────────────
// Emitted via deny()/allow() in checks.ts and guard.ts, and the one raw literal in engine.ts.
export const DECISION_REASONS = {
  ok: { means: "The payment passed every check.", fix: "None — this is an allow.", when: "payment" },
  halt: { means: "Kill switch engaged; all payments are denied.", fix: "Set policy.halt to false to resume.", when: "payment" },
  "bind.amount_mismatch": { means: "The signed value does not equal the challenge amount.", fix: "Not a config error — the payment was tampered with or mismatched; the deny is correct.", when: "payment" },
  "bind.recipient_mismatch": { means: "The signed recipient does not equal the challenge payTo.", fix: "Not a config error — a mismatched payment; the deny is correct.", when: "payment" },
  "bind.asset_mismatch": { means: "The signed (chain, token) does not equal the challenge's.", fix: "Not a config error — a mismatched payment; the deny is correct.", when: "payment" },
  "bind.timeout_exceeded": { means: "The authorization's validBefore exceeds the allowed lifetime.", fix: "Raise policy.maxAuthLifetimeSeconds, or the server's window is too long; the deny is correct.", when: "payment" },
  "origin.mismatch": { means: "The challenge's resource origin does not match the request origin.", fix: "Expected when requireOriginMatch is on and origins differ; the deny is correct.", when: "payment" },
  "allowlist.empty": { means: "No destinations are permitted (empty allowlist ⇒ deny all, secure by default).", fix: "Add at least one { address, chain } to policy.allowlist.", when: "payment" },
  "allowlist.blocked": { means: "The payee/chain is not on the allowlist.", fix: "Add this (address, chain) to policy.allowlist, or the block is correct.", when: "payment" },
  "cap.asset_unconfigured": { means: "No caps are configured for this (asset, chain) denomination.", fix: "Add a policy.caps entry for this denomination — a missing entry denies by design.", when: "payment" },
  "cap.per_request": { means: "The amount exceeds the per-request cap.", fix: "Raise caps.perRequest for this denomination, or the block is correct.", when: "payment" },
  "cap.per_domain": { means: "Cumulative spend to this domain would exceed the per-domain cap.", fix: "Raise caps.perDomain, or the block is correct.", when: "payment" },
  "cap.global": { means: "Cumulative spend in this denomination would exceed the global cap.", fix: "Raise caps.global, or the block is correct.", when: "payment" },
  "store.unverified": { means: "The spend store failed its start-up atomicity self-test; the guard refuses to operate.", fix: "Investigate the ledger directory/filesystem; the guard fails closed rather than under-enforce.", when: "payment" },
  "state.load_failed": { means: "The spend state could not be loaded; denying by default.", fix: "Investigate the ledger directory (unreadable/corrupt); the guard fails closed.", when: "payment" },
  "spend.record_failed": { means: "The spend could not be durably recorded; denying rather than proceed uncounted.", fix: "Investigate ledger writability/disk; the guard fails closed.", when: "payment" },
  "spend.contention": { means: "The spend could not be committed within the retry budget under concurrent contention.", fix: "Transient under heavy multi-process contention; retry. Persistent ⇒ investigate the store.", when: "payment" },
  "engine.error": { means: "The policy engine threw unexpectedly; denying by default.", fix: "A bug — please report it. The guard fails closed rather than allow on an internal error.", when: "payment" },
} as const;

// ── Partition 2: CONFIG reasons — carried by `Result.reason` (the parse boundary). ───────────────
// Emitted via err() in parse.ts and fail() in the loader; wire.* are Result failures from wire.ts.
export const CONFIG_REASONS = {
  "parse.amount_malformed": { means: "An amount is not a non-negative integer.", fix: "Use a base-unit integer (decimal string or bigint) — no decimals, sign, or junk.", when: "policy-load" },
  "parse.amount_negative": { means: "An amount is negative.", fix: "Amounts must be non-negative base-unit integers.", when: "policy-load" },
  "parse.time_malformed": { means: "A timestamp/duration is not a non-negative integer.", fix: "Use whole seconds as a non-negative integer.", when: "policy-load" },
  "parse.time_negative": { means: "A timestamp/duration is negative.", fix: "Durations must be non-negative whole seconds.", when: "policy-load" },
  "parse.address_malformed": { means: "An address is not a 20-byte 0x address.", fix: "Replace the placeholder/typo with a valid 0x… payee address.", when: "policy-load" },
  "parse.chain_malformed": { means: "A chain id is not CAIP-2 (namespace:reference).", fix: 'Use CAIP-2, e.g. "eip155:8453".', when: "policy-load" },
  "parse.domain_malformed": { means: "A domain is not a valid host.", fix: "Provide a bare host (no scheme, no port).", when: "payment" },
  "parse.hex_malformed": { means: "A value is not 0x-hex.", fix: "Provide 0x-prefixed hex.", when: "payment" },
  "scheme.unsupported": { means: "The payment scheme is not supported in v1 (exact only).", fix: "v1 supports the EVM exact scheme only; other schemes are refused.", when: "payment" },
  "chain.unsupported": { means: "The authorization form is not supported in v1 (EVM only).", fix: "v1 supports EVM only; SVM/other is v2.", when: "payment" },
  "config.not_an_object": { means: "The policy is not a JSON object.", fix: "The policy file must be a single JSON object.", when: "policy-load" },
  "config.halt_invalid": { means: "policy.halt is not a boolean.", fix: "Set halt to true or false.", when: "policy-load" },
  "config.require_origin_match_invalid": { means: "policy.requireOriginMatch is not a boolean.", fix: "Set requireOriginMatch to true or false.", when: "policy-load" },
  "config.allowlist_invalid": { means: "policy.allowlist is not an array of { address, chain } entries.", fix: "Provide an array; each entry needs a valid address and CAIP-2 chain.", when: "policy-load" },
  "config.caps_invalid": { means: "policy.caps is malformed (not an object, or an entry lacks perRequest/perDomain/global).", fix: "Each denomination needs perRequest, perDomain, and global base-unit caps.", when: "policy-load" },
  "config.cap_key_malformed": { means: "A caps key is not a valid chain|token coordinate.", fix: 'Use "chain|token", e.g. "eip155:8453|0x…"; build it with assetKey().', when: "policy-load" },
  "config.file_unreadable": { means: "The policy file (or its directory) could not be stat'd/read.", fix: "Check the path and permissions.", when: "policy-load" },
  "config.world_writable": { means: "The policy file is world-writable; refusing to load it.", fix: "Tighten the file mode (a world-writable policy is untrusted).", when: "policy-load" },
  "config.dir_world_writable": { means: "The policy file's directory is world-writable; refusing to load it.", fix: "Tighten the directory mode (a world-writable dir lets the file be swapped).", when: "policy-load" },
  "config.json_malformed": { means: "The policy file is not valid JSON.", fix: "Fix the JSON syntax.", when: "policy-load" },
  "wire.unsupported_typed_data": { means: "The EIP-712 typed data is not EIP-3009 TransferWithAuthorization.", fix: "v1 supports EVM exact (EIP-3009) only; other typed data is refused.", when: "payment" },
  "wire.unknown_v1_network": { means: "A v1 network has no known CAIP-2 mapping.", fix: "The network is unrecognized; it cannot be keyed to caps or cross-checked.", when: "payment" },
  "config.display_invalid": { means: "The optional `display` section is malformed (not an object, or an entry/key is bad).", fix: "display maps a `chain|token` key to { decimals, symbol }; it is display-only and never affects enforcement.", when: "policy-load" },
  "config.decimals_invalid": { means: "A display `decimals` is not a non-negative integer.", fix: "decimals is the token's base-unit exponent (e.g. 6 for USDC) — a small whole number.", when: "policy-load" },
  "config.symbol_invalid": { means: "A display `symbol` is not a string.", fix: "symbol is a display-only label (e.g. \"USDC\"); it never affects a decision.", when: "policy-load" },
} as const;

// ── The remaining codes — carried by ERROR classes / the binding abort, which legitimately pass
// through ANY code, so their carriers are typed `ReasonCode`. Registered here for the legend. ─────
export const OTHER_REASONS = {
  "adapter.concurrent_flow": { means: "Two payment flows raced through one binding; refusing to mis-attribute.", fix: "Use one binding per concurrent flow; the refusal is a safety stop.", when: "payment" },
  "adapter.context_incomplete": { means: "The payment context lacked fields needed to evaluate it.", fix: "The adapter could not build a complete evaluation; the refusal is fail-closed.", when: "payment" },
  "adapter.unguarded_signing_route": { means: "A signing route that bypasses the veto was detected.", fix: "Route all signing through the guarded signer; the veto is the sole signing path.", when: "payment" },
  "adapter.unsupported_x402_version": { means: "The x402 payload version is not supported.", fix: "v1 handles the supported x402 generations; an unknown version is refused.", when: "payment" },
  "snapshot.state_unreadable": { means: "snapshot() could not read spend state; it refuses to fabricate zeros.", fix: "Investigate the ledger; a zeroed snapshot would be a lie, so it fails loud.", when: "read-api" },
} as const;

/** Codes that may appear on a `PolicyDecision.reason`. `deny()`/`allow()` accept ONLY these. */
export type DecisionReason = keyof typeof DECISION_REASONS;
/** Codes that may appear on a parse `Result.reason`. `err()`/`fail()` accept ONLY these. */
export type ConfigReason = keyof typeof CONFIG_REASONS;

/** The flat source of truth: every code the guard can emit, with its legend metadata. */
export const REASONS: Record<string, ReasonMeta> = {
  ...DECISION_REASONS,
  ...CONFIG_REASONS,
  ...OTHER_REASONS,
};

/** Any registered code. Error classes / the binding abort carry this (they pass codes through). */
export type ReasonCode = DecisionReason | ConfigReason | keyof typeof OTHER_REASONS;

/** Runtime membership test — a code is one this guard can legitimately emit. */
export function isReasonCode(x: unknown): x is ReasonCode {
  return typeof x === "string" && Object.hasOwn(REASONS, x);
}
