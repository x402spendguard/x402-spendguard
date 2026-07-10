// Core domain types for the x402 spend-guard policy engine.
//
// The policy engine is deliberately pure: it takes a proposed payment + the
// current policy + the current spend state, and returns a decision. No I/O,
// no wallet access, no network. That keeps the security-critical logic small,
// deterministic, and trivially testable. Persistence and SDK interception live
// at the edges, not here.

/** A payment the agent is about to authorize, extracted from an x402 402-challenge. */
export interface ProposedPayment {
  /** Destination wallet address (the 402 `payTo`). */
  payTo: string;
  /** Origin/domain of the resource server requesting payment (e.g. "weather.example"). */
  domain: string;
  /** Amount in the asset's smallest unit (e.g. 6-decimal USDC micro-units). Integer, so we use bigint. */
  amount: bigint;
  /** Asset symbol, e.g. "USDC". */
  asset: string;
  /** Settlement chain, e.g. "base", "solana". */
  chain: string;
}

export type Verdict = "allow" | "deny";

/** The result of evaluating a proposed payment against policy. */
export interface PolicyDecision {
  verdict: Verdict;
  /** Machine-readable reason code, e.g. "cap.per_request". Stable — safe to log/alert on. */
  reason: string;
  /** Human-readable explanation for the decision log. */
  detail: string;
}

/**
 * Rolling spend state the engine reads to enforce budgets.
 * Supplied by the caller (persisted at the edge — SQLite in a later slice),
 * reset on whatever window you choose (e.g. daily). Amounts in asset smallest units.
 */
export interface SpendState {
  /** Total spent this window, keyed by domain. */
  spentByDomain: Record<string, bigint>;
  /** Total spent this window across all domains. */
  spentGlobal: bigint;
}

/** Declarative policy — this is what the user writes (policy.yaml, loaded at the edge). */
export interface Policy {
  /** Kill switch: when true, deny everything, no exceptions. */
  halt: boolean;
  /** Spend caps, in asset smallest units. */
  caps: {
    /** Max for any single payment. */
    perRequest: bigint;
    /** Max cumulative per domain, this window. */
    perDomain: bigint;
    /** Max cumulative across all domains, this window. */
    global: bigint;
  };
  /** Only these payTo addresses (compared case-insensitively) may be paid. Empty array = allow any. */
  allowlist: string[];
}
