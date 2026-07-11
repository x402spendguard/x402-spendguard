// The decision-log (audit) layer. It records WHAT the guard decided, for the operator
// and any downstream viewer (a future dashboard reads this log — it is the seam).
//
// Two invariants define this layer:
//  - PRIV-02 — a log entry carries only curated, safe fields. It NEVER contains a bearer
//    capability: no signature (the decision core has none by construction), no nonce (half
//    the replay tuple), no raw authorization. `toLogEntry` is that projection; the entry
//    type is a closed set of primitive strings, so an entry is safe by construction.
//  - FAIL-03 (audit half) — observability is strictly OFF the enforcement path. The logger
//    only ever sees an ALREADY-FINAL decision and returns it verbatim; a failing/slow/absent
//    audit sink can never flip an allow to a deny or vice versa (`LoggingGuard`).

import type { PaymentEvaluation, PolicyDecision, UnixSeconds } from "../types.js";
import type { Clock } from "../accounting/guard.js";

/** One audit record. Every field is a primitive string (JSON/JSONL-serializable, no bigint,
 *  no float) and is safe to persist — deliberately NO nonce, no payer, no signed payload. */
export interface LogEntry {
  /** Decision time, decimal Unix seconds as a string (bigint has no JSON form). */
  at: string;
  verdict: "allow" | "deny";
  /** Stable machine reason code. Carries no interpolated capability. */
  reason: string;
  /** Human explanation for the local log. May reference scalar money-map fields; never a payload. */
  detail: string;
  /** The budget domain (client-observed request origin). */
  origin: string;
  /** CAIP-2 chain id of the denomination. */
  chain: string;
  /** Token contract (the denomination's asset). */
  asset: string;
  /** Payee (the signed recipient). */
  to: string;
  /** Amount in the asset's smallest unit, decimal string. */
  amount: string;
}

/**
 * Project a decision into a safe log entry. This is the ONE place the audit boundary is
 * drawn: only these fields cross it. Adding the raw authorization here would be the PRIV-02
 * regression the test guards against — so keep this a hand-listed, minimal projection.
 */
export function toLogEntry(ev: PaymentEvaluation, decision: PolicyDecision, at: UnixSeconds): LogEntry {
  const a = ev.authorization;
  return {
    at: at.toString(),
    verdict: decision.verdict,
    reason: decision.reason,
    detail: decision.detail,
    origin: ev.origin,
    chain: a.chainId,
    asset: a.verifyingContract,
    to: a.to,
    amount: a.value.toString(),
  };
}

/** Anything that decides on a payment. `SpendGuard` satisfies this structurally. */
export interface Authorizer {
  authorize(ev: PaymentEvaluation): Promise<PolicyDecision>;
}

/** A durable sink for decision records. The file adapter is one implementation. */
export interface DecisionLog {
  append(entry: LogEntry): Promise<void>;
}

/**
 * Wrap an `Authorizer` so every decision is recorded — WITHOUT the audit ever affecting the
 * decision. The inner guard runs first and its verdict is what we return, unchanged; the log
 * write is attempted after and its failure is swallowed (FAIL-03 audit half). This decorator
 * is what makes "observability is off the enforcement path" structural rather than a promise:
 * the logger physically cannot see a decision before it is final, nor mutate it.
 */
export class LoggingGuard implements Authorizer {
  constructor(
    private readonly inner: Authorizer,
    private readonly log: DecisionLog,
    private readonly clock: Clock,
  ) {}

  async authorize(ev: PaymentEvaluation): Promise<PolicyDecision> {
    const decision = await this.inner.authorize(ev);
    try {
      await this.log.append(toLogEntry(ev, decision, this.clock.now()));
    } catch {
      // An audit failure must never flip an allow/deny. The decision stands.
    }
    return decision;
  }
}
