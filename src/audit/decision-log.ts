// The decision-log (audit) layer. It records WHAT the guard decided, for the operator
// and any downstream viewer (a future dashboard reads this log — it is the seam).
//
// Two invariants define this layer:
//  - PRIV-02 — a log entry carries only curated, safe fields. It NEVER contains a bearer
//    capability: no signature (the decision core has none by construction), no nonce (half
//    the replay tuple), no raw authorization. `toLogEntry` is that projection; the entry
//    type is a closed set of primitive strings, so an entry is safe by construction.
//  - FAIL-03 (audit half) — the audit NEVER changes the verdict. The logger only ever sees an
//    ALREADY-FINAL decision and returns it verbatim, so a failing/absent sink cannot flip an
//    allow to a deny or back. This part is STRUCTURAL. Liveness, however, is not fully
//    decoupled: `authorize` awaits the append, so a slow/stalled sink adds LATENCY to the
//    decision (never changes it). The bundled FileDecisionLog fsyncs synchronously — like the
//    spend store — so an append timeout can't bound that; true decoupling (async I/O, or
//    fire-and-forget) is a converge-first design item shared with the store (see D-025, F1).

import type { PaymentEvaluation, PolicyDecision, UnixSeconds } from "../types.js";
import type { Clock } from "../accounting/guard.js";

/** One audit record. Every field is a JSON-serializable primitive (money as a decimal string,
 *  never bigint/float) and is safe to persist — deliberately NO nonce, no payer, no signed
 *  payload. `v` versions the on-disk contract so a downstream reader/dashboard can evolve
 *  against a known shape instead of guessing. */
export interface LogEntry {
  /** Schema version of this record. Bump on any breaking shape change (F3). */
  v: number;
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
    v: 1,
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
 * write is attempted after and its failure is swallowed (FAIL-03 audit half). This makes
 * VERDICT-integrity structural — the logger physically cannot see a decision before it is
 * final, nor mutate it. It does NOT decouple liveness: the append is awaited, so a slow sink
 * only ever adds latency, never a different verdict (see the FAIL-03 note at the top, and D-025 F1).
 */
export class LoggingGuard implements Authorizer {
  constructor(
    private readonly inner: Authorizer,
    private readonly log: DecisionLog,
    private readonly clock: Clock,
    /** Surfaced (never thrown) on an audit-write failure — so a swallowed sink is not invisible
     *  to the operator (AUDIT-03). It NEVER affects the verdict (FAIL-03). */
    private readonly onAuditFailure?: (err: unknown) => void,
  ) {}

  async authorize(ev: PaymentEvaluation): Promise<PolicyDecision> {
    const decision = await this.inner.authorize(ev);
    try {
      await this.log.append(toLogEntry(ev, decision, this.clock.now()));
    } catch (err) {
      // Surface the failure so a swallowed sink is not invisible (AUDIT-03) — but the verdict stands
      // regardless (FAIL-03, structural): the notifier runs after the decision and cannot change it,
      // and its own failure is ignored so it can never turn an audit problem into a verdict change.
      try {
        this.onAuditFailure?.(err);
      } catch {
        /* a broken notifier must not flip the verdict either */
      }
    }
    return decision;
  }
}
