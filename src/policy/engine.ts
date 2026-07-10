import type { ProposedPayment, Policy, SpendState, PolicyDecision } from "../types.js";
import { runChecks } from "./checks.js";

/**
 * Evaluate a proposed payment against policy.
 *
 * Pure and deterministic: all state is passed in, nothing is read or written here.
 * The caller persists SpendState and writes the returned decision to the log.
 *
 * SECURITY POSTURE: FAIL CLOSED. Any thrown error — a malformed policy, a bad
 * amount, a bug in a check — results in `deny`. A guard that fails open is not a guard.
 */
export function evaluate(
  payment: ProposedPayment,
  policy: Policy,
  state: SpendState,
): PolicyDecision {
  try {
    return runChecks(payment, policy, state);
  } catch (err) {
    return {
      verdict: "deny",
      reason: "engine.error",
      detail: `Policy engine threw; denying by default: ${(err as Error).message}`,
    };
  }
}
