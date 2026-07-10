// Core domain types for the x402 spend-guard policy engine.
//
// The engine is a PURE function of (evaluation, policy, state, now): it decides
// allow/deny and holds no I/O, no wallet access, no network, no clock of its own.
// Untrusted input is turned into these trustworthy types exactly once, at the
// boundary (see parse.ts) — "parse, don't validate." The interior then trusts
// its own types. Persistence, config loading, the clock, and SDK interception
// live at the edges, never here.

// ── Branded primitives ───────────────────────────────────────────────────────
// A brand is a compile-time-only marker (erased at runtime) that makes a value
// impossible to construct except through its parser. That is how classes of bug
// are made unrepresentable: an `Amount` cannot be negative, a time cannot be a
// float, an address cannot be un-normalized — because the only way to obtain one
// is through a parser that guarantees it.
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** A non-negative integer amount in an asset's smallest unit. Never a float. */
export type Amount = Brand<bigint, "Amount">;
/** A non-negative Unix timestamp in seconds. bigint, never number — validBefore is a uint256. */
export type UnixSeconds = Brand<bigint, "UnixSeconds">;
/** A normalized EVM address: lowercase, "0x" + 40 hex. */
export type Address = Brand<string, "Address">;
/** A CAIP-2 chain id, e.g. "eip155:8453". */
export type ChainId = Brand<string, "ChainId">;
/** A canonical budget domain — the client-observed request origin (never a server field). */
export type Domain = Brand<string, "Domain">;
/** Opaque hex. Carried, never interpreted, in v1 (e.g. the EIP-3009 nonce — the v2 replay seam). */
export type OpaqueHex = Brand<string, "OpaqueHex">;

// ── Denomination ─────────────────────────────────────────────────────────────
/** The denomination money is measured in: a token contract on a specific chain. */
export interface AssetId {
  chain: ChainId;
  token: Address;
}
/** Stable string key for an AssetId — the coordinate money is bucketed by. */
export type AssetKey = Brand<string, "AssetKey">;

// ── Decision ─────────────────────────────────────────────────────────────────
export type Verdict = "allow" | "deny";
export interface PolicyDecision {
  verdict: Verdict;
  /** Stable, machine-readable reason code from a closed set. Carries NO interpolated data. */
  reason: string;
  /** Human-readable explanation for the LOCAL decision log. May reference scalar money-map
   *  fields (amount, address). MUST NEVER contain the signed payload or a signature. */
  detail: string;
}

// ── The challenge (the server's ask — untrusted, but typed) ──────────────────
export interface Challenge {
  /** v1: only "exact". A non-exact scheme fails to parse (BIND-05). */
  scheme: "exact";
  network: ChainId;
  /** ERC-20 contract address, not a symbol. */
  asset: Address;
  payTo: Address;
  amount: Amount;
  maxTimeoutSeconds: UnixSeconds;
  /** Informational only. NEVER the source of the budget domain (that is the request origin). */
  resource: string;
}

// ── The authorization (what is about to be signed) ───────────────────────────
// A discriminated union tagged by payment FORM. v1 implements exactly one variant.
// The tagged dispatch *is* the EVM-only gate (D-017) and the v2 seam (D-019): a new
// chain/scheme is a new variant, not a rewrite. An unknown form is denied at parse.
//
// NOTE: the 65-byte signature is deliberately ABSENT. The engine decides on the
// message, never on the capability — so it physically cannot log the bearer token
// (PRIV-02 holds by construction, not by discipline). The signature exists only at
// the signer boundary, outside this type.
export interface Eip3009EvmAuthorization {
  form: "eip3009-evm";
  /** From the EIP-712 domain. */
  chainId: ChainId;
  /** The token contract — the EIP-712 domain's verifyingContract. */
  verifyingContract: Address;
  from: Address;
  to: Address;
  value: Amount;
  validAfter: UnixSeconds;
  validBefore: UnixSeconds;
  /** Carried, deliberately UNREAD in v1 (v2 replay seam). See test `nonce-unread-in-v1`. */
  nonce: OpaqueHex;
}
/** v1 = one variant. v2: `| SvmAuthorization | UptoAuthorization | ...`. */
export type Authorization = Eip3009EvmAuthorization;

/** What the engine decides on: client truth (origin) + the ask + the thing to be signed, correlated. */
export interface PaymentEvaluation {
  /** Client-observed request origin — the budget domain. Supplied by the adapter, never the server. */
  origin: Domain;
  challenge: Challenge;
  authorization: Authorization;
}

// ── Policy (user-authored; the ONLY source of thresholds — POL-01) ───────────
export interface Caps {
  perRequest: Amount;
  perDomain: Amount;
  global: Amount;
}
export interface AllowlistEntry {
  address: Address;
  chain: ChainId;
}
export interface Policy {
  /** Kill switch: deny everything. */
  halt: boolean;
  /** Permitted (address, chain) destinations. EMPTY ⇒ deny all (secure by default). */
  allowlist: AllowlistEntry[];
  /** Caps per (asset, chain) denomination. A denomination with no entry ⇒ deny (CAP-05). */
  caps: Record<AssetKey, Caps>;
  /** Clock-skew tolerance for the validBefore bound. Policy, not a code constant (D-018). */
  clockSkewSeconds: UnixSeconds;
  /** Absolute max authorization lifetime the USER will accept, enforced independently of the
   *  server's `maxTimeoutSeconds` (which is untrusted — a malicious server can set it huge).
   *  The effective bound is min(server maxTimeoutSeconds, this). Policy, not a code constant. */
  maxAuthLifetimeSeconds: UnixSeconds;
  /** Rolling budget window length, e.g. 86400 for a daily budget. The accounting layer
   *  zeroes cumulative spend when a window elapses. Policy, not a code constant. */
  windowSeconds: UnixSeconds;
  /** When true, require the challenge.resource origin to match the request origin. Default lives
   *  in the shipped default policy file, never as a code constant (D-018). */
  requireOriginMatch: boolean;
}

// ── Spend state (injected — INJ-01; the edge persists it) ────────────────────
export interface SpendState {
  /** domain → assetKey → cumulative spent this window. */
  spentByDomain: Record<string, Record<string, bigint>>;
  /** assetKey → cumulative spent this window across all domains (per-denomination global). */
  spentByAsset: Record<string, bigint>;
  /** Start of the current budget window. Managed by the accounting layer; the pure engine ignores it. */
  windowStart: UnixSeconds;
  /** Highest timestamp ever seen — a monotonic guard so a backward clock jump can never
   *  reset a window or un-count spend (CLOCK-01). Managed by the accounting layer. */
  lastSeen: UnixSeconds;
}
