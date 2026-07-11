// The veto core. This is where the guard actually stops a payment: by wrapping the x402
// client's EVM signer so that `signTypedData` runs the guard FIRST and only reaches the real
// signer on an allow. It is the last gate before a signature exists — the hardest point to
// bypass by accident, and it works on both x402 generations (see the ground-truth notes).
//
// The signer sees only the EIP-712 struct — not the request origin, not the offer. So the
// full evaluation is CORRELATED here from three sources captured across one payment flow:
//   struct    ← this signer wrap (the exact thing about to be signed)
//   origin    ← the transport wrapper (the real client-observed request origin — DOM-01)
//   challenge ← the payment hook / 402 body (the offer)
// The transport/hook feed a `PaymentFlowContext`; this wrap consumes it at signing time.
//
// Fail-closed throughout: unsupported struct, incomplete correlation, or a deny all THROW
// before the real signer is reached, so no signature is ever produced on anything but a
// clean allow. Throwing from `signTypedData` aborts x402 payload creation (verified).
//
// v1 assumption: one payment flow at a time per context (serial). Interleaved concurrent
// flows on one client can mis-correlate; a mismatch fails closed via the binding checks,
// but per-domain attribution assumes serial use — documented, like one-instance-per-wallet.

import { authorizationFromTypedData, type TypedData } from "./x402-wire.js";
import type { Authorizer } from "../audit/decision-log.js";
import type { Challenge, Domain } from "../types.js";

/** Thrown to abort signing. Carries the guard's stable reason + human detail (never a payload). */
export class PaymentBlockedError extends Error {
  constructor(
    readonly reason: string,
    readonly detail: string,
  ) {
    super(`x402 payment blocked [${reason}]: ${detail}`);
    this.name = "PaymentBlockedError";
  }
}

/** The x402 EVM signer surface we wrap (a viem LocalAccount satisfies it). Extra methods on a
 *  concrete signer are preserved by `guardedSigner` via spread. */
export interface ClientEvmSigner {
  readonly address: `0x${string}`;
  signTypedData(td: TypedData): Promise<`0x${string}`>;
}

/**
 * Holds the origin + challenge captured for the current payment flow so the signer wrap can
 * assemble a full evaluation. Consuming CLEARS it, so a stale context can never be reused for
 * a later, unrelated signature — the next signing must observe its own origin + challenge.
 */
export class PaymentFlowContext {
  private origin?: Domain;
  private challenge?: Challenge;

  /** Record the real client-observed request origin (from the transport wrapper, DOM-01). */
  observeOrigin(origin: Domain): void {
    this.origin = origin;
  }

  /** Record the challenge parsed from the offer / 402 body (from the payment hook). */
  observeChallenge(challenge: Challenge): void {
    this.challenge = challenge;
  }

  /** Take the correlated pair for a signing event and clear it. Throws (fail-closed) if either
   *  half is missing — we will not sign a payment we cannot fully evaluate. */
  consume(): { origin: Domain; challenge: Challenge } {
    const origin = this.origin;
    const challenge = this.challenge;
    this.origin = undefined;
    this.challenge = undefined;
    if (!origin || !challenge) {
      const missing = !origin ? "no client-observed origin" : "no observed challenge";
      throw new PaymentBlockedError("adapter.context_incomplete", `Cannot evaluate the payment: ${missing}.`);
    }
    return { origin, challenge };
  }
}

/**
 * Wrap an EVM signer so the guard vets every `signTypedData` before it is honored. On allow
 * the real signer runs and its signature is returned unchanged; on anything else a
 * `PaymentBlockedError` is thrown and the real signer is never reached.
 *
 * `guard` is any `Authorizer` — a `SpendGuard` (optionally wrapped in a `LoggingGuard`).
 */
export function guardedSigner<S extends ClientEvmSigner>(
  inner: S,
  guard: Authorizer,
  context: PaymentFlowContext,
): S {
  return {
    ...inner,
    async signTypedData(td: TypedData): Promise<`0x${string}`> {
      // Build the authorization from the EXACT struct about to be signed — bind reality,
      // not the offer. An unsupported struct (e.g. a Permit2 witness) is refused here.
      const authorization = authorizationFromTypedData(td);
      if (!authorization.ok) {
        throw new PaymentBlockedError(authorization.reason, authorization.detail);
      }
      // Correlate with the origin + challenge captured earlier in this flow (throws if incomplete).
      const { origin, challenge } = context.consume();
      const decision = await guard.authorize({ origin, challenge, authorization: authorization.value });
      if (decision.verdict === "deny") {
        throw new PaymentBlockedError(decision.reason, decision.detail);
      }
      return inner.signTypedData(td);
    },
  };
}
