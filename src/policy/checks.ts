import type { PaymentEvaluation, Policy, SpendState, PolicyDecision, UnixSeconds } from "../types.js";
import { assetKey } from "../parse.js";

const allow = (): PolicyDecision => ({ verdict: "allow", reason: "ok", detail: "All checks passed." });
const deny = (reason: string, detail: string): PolicyDecision => ({ verdict: "deny", reason, detail });

/**
 * Run every check in order; first deny wins; a payment must pass ALL to be allowed.
 *
 * Two deliberate design points:
 *  - The caps and allowlist evaluate the AUTHORIZATION (the money that actually moves) —
 *    `to`, `value`, and the `(chainId, verifyingContract)` denomination. The binding checks
 *    then assert the challenge agrees. So even if binding were bypassed, caps/allowlist would
 *    still guard the real signed values. Belt and braces.
 *  - Every threshold comes from `policy`; the clock comes in as `now`. There is no
 *    security-deciding literal here (POL-01).
 */
export function runChecks(
  ev: PaymentEvaluation,
  policy: Policy,
  state: SpendState,
  now: UnixSeconds,
): PolicyDecision {
  const { challenge: c, authorization: a, origin } = ev;

  // 1. Kill switch — highest authority, no exceptions.
  if (policy.halt) {
    return deny("halt", "Kill switch engaged: all payments halted.");
  }

  // 2. Binding — the guard evaluated `c`; ensure `a` (the thing signed) matches it.
  //    Without this, the cap/allowlist decisions below would be unsound.
  if (a.value !== c.amount) {
    return deny("bind.amount_mismatch", `Signed value ${a.value} != challenge amount ${c.amount}.`);
  }
  if (a.to !== c.payTo) {
    return deny("bind.recipient_mismatch", `Signed recipient ${a.to} != challenge payTo ${c.payTo}.`);
  }
  if (a.chainId !== c.network || a.verifyingContract !== c.asset) {
    return deny(
      "bind.asset_mismatch",
      `Signed (${a.chainId}, ${a.verifyingContract}) != challenge (${c.network}, ${c.asset}).`,
    );
  }
  // Bound the bearer-capability lifetime by the challenge's own declared timeout.
  // Nothing downstream enforces this; the guard does. Skew tolerance is user policy.
  if (a.validBefore > now + c.maxTimeoutSeconds + policy.clockSkewSeconds) {
    return deny(
      "bind.timeout_exceeded",
      `validBefore ${a.validBefore} exceeds now+maxTimeoutSeconds+skew.`,
    );
  }

  // 3. Optional cross-origin check — the challenge's stated resource origin vs the request origin.
  //    Off unless the user's policy turns it on (default lives in the default policy file).
  if (policy.requireOriginMatch) {
    const resourceOrigin = originOf(c.resource);
    if (resourceOrigin === null || resourceOrigin !== origin) {
      return deny("origin.mismatch", `Challenge resource origin does not match request origin ${origin}.`);
    }
  }

  // 4. Destination allowlist — evaluated against the SIGNED recipient + chain. Empty ⇒ deny all.
  if (policy.allowlist.length === 0) {
    return deny("allowlist.empty", "Allowlist is empty; no destination is permitted (secure by default).");
  }
  const permitted = policy.allowlist.some((e) => e.address === a.to && e.chain === a.chainId);
  if (!permitted) {
    return deny("allowlist.blocked", `Recipient ${a.to} on ${a.chainId} is not on the allowlist.`);
  }

  // 5. Spend caps — per (asset, chain) denomination. A denomination with no cap ⇒ deny.
  const key = assetKey({ chain: a.chainId, token: a.verifyingContract });
  const caps = policy.caps[key];
  if (caps === undefined) {
    return deny("cap.asset_unconfigured", `No cap configured for denomination ${key}.`);
  }
  if (a.value > caps.perRequest) {
    return deny("cap.per_request", `Amount ${a.value} exceeds per-request cap ${caps.perRequest}.`);
  }
  const domainSpent = state.spentByDomain[origin]?.[key] ?? 0n;
  if (domainSpent + a.value > caps.perDomain) {
    return deny(
      "cap.per_domain",
      `Domain ${origin} would reach ${domainSpent + a.value} in ${key}, over per-domain cap ${caps.perDomain}.`,
    );
  }
  const assetSpent = state.spentByAsset[key] ?? 0n;
  if (assetSpent + a.value > caps.global) {
    return deny(
      "cap.global",
      `Spend in ${key} would reach ${assetSpent + a.value}, over global cap ${caps.global}.`,
    );
  }

  return allow();
}

/**
 * Canonical origin of a URL: lowercased hostname, no port, no trailing dot — the same
 * form the adapter must derive `origin` in, so the two compare cleanly (a port mismatch
 * must not false-deny). Deterministic, no I/O. Returns null if it can't be determined.
 */
function originOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}
