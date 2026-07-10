import type { ProposedPayment, Policy, SpendState, PolicyDecision } from "../types.js";

const allow = (): PolicyDecision => ({
  verdict: "allow",
  reason: "ok",
  detail: "All checks passed.",
});

const deny = (reason: string, detail: string): PolicyDecision => ({
  verdict: "deny",
  reason,
  detail,
});

/**
 * Run every check in order. First deny wins; a payment must pass ALL checks to be allowed.
 * Order is deliberate: cheapest / highest-authority checks first (kill switch, allowlist),
 * then the budget arithmetic.
 */
export function runChecks(p: ProposedPayment, policy: Policy, state: SpendState): PolicyDecision {
  // 1. Kill switch — highest priority, no exceptions.
  if (policy.halt) {
    return deny("halt", "Kill switch engaged: all payments halted.");
  }

  // 2. Destination allowlist — defeats the headline attack: a prompt-injected agent
  //    redirecting payment to an attacker-controlled wallet. Empty allowlist = allow any.
  if (policy.allowlist.length > 0) {
    const to = p.payTo.toLowerCase();
    const permitted = policy.allowlist.some((a) => a.toLowerCase() === to);
    if (!permitted) {
      return deny("allowlist.blocked", `payTo ${p.payTo} is not on the allowlist.`);
    }
  }

  // 3. Per-request cap — the single-payment ceiling (defeats one oversized drain).
  if (p.amount > policy.caps.perRequest) {
    return deny(
      "cap.per_request",
      `Amount ${p.amount} exceeds per-request cap ${policy.caps.perRequest}.`,
    );
  }

  // 4. Per-domain budget — would this payment push this domain over its window budget?
  //    (defeats repeated small payments to one endpoint draining the account.)
  const domainSpent = state.spentByDomain[p.domain] ?? 0n;
  if (domainSpent + p.amount > policy.caps.perDomain) {
    return deny(
      "cap.per_domain",
      `Domain ${p.domain} would reach ${domainSpent + p.amount}, over per-domain cap ${policy.caps.perDomain}.`,
    );
  }

  // 5. Global budget — the account-wide ceiling across all domains.
  if (state.spentGlobal + p.amount > policy.caps.global) {
    return deny(
      "cap.global",
      `Global spend would reach ${state.spentGlobal + p.amount}, over global cap ${policy.caps.global}.`,
    );
  }

  return allow();
}
