import type { PaymentEvaluation, Policy, SpendState, PolicyDecision, UnixSeconds } from "../types.js";
import { runChecks } from "./checks.js";

/**
 * Evaluate a proposed payment against policy.
 *
 * Pure and deterministic: all state and the clock are passed in; nothing is read
 * or written here. The caller persists SpendState, supplies `now`, and writes the
 * returned decision to the local log.
 *
 * SECURITY POSTURE: FAIL CLOSED. Any thrown error results in `deny` (FAIL-01).
 * This catch is the LAST-RESORT backstop for genuine bugs — expected malformed
 * input is turned into a specific deny at the parse boundary (PARSE-01) and never
 * reaches here as an exception.
 */
export function evaluate(
  evaluation: PaymentEvaluation,
  policy: Policy,
  state: SpendState,
  now: UnixSeconds,
): PolicyDecision {
  try {
    return runChecks(evaluation, policy, state, now);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return {
      verdict: "deny",
      reason: "engine.error",
      detail: `Policy engine threw; denying by default: ${msg}`,
    };
  }
}
