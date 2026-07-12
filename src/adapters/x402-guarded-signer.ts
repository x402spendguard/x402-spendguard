// The veto core. This is where the guard actually stops a payment: by wrapping the x402
// client's EVM signer so that `signTypedData` runs the guard FIRST and only reaches the real
// signer on an allow. It is the last gate before a signature exists, and it works on both x402
// generations (see the ground-truth notes). Crucially, because the SAME EIP-712 digest can be
// produced by ANY signing route the signer exposes, the wrap must be the SOLE path to a
// signature: `guardedSigner` returns an ALLOWLIST of the signer surface (guarded `signTypedData`
// + non-signing reads), never a spread of the inner object — so present and future alternate
// signing routes (`sign`, `signAuthorization`, …) are absent, not merely a blocked subset.
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

/** The x402 EVM signer surface we wrap (a viem LocalAccount satisfies it). `guardedSigner`
 *  exposes an ALLOWLIST of this surface, not the whole inner object — see its doc. */
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
    this.assertNoInterleave(this.origin, origin, "origin");
    this.origin = origin;
  }

  /** Record the challenge parsed from the offer / 402 body (from the payment hook). */
  observeChallenge(challenge: Challenge): void {
    this.assertNoInterleave(this.challenge, challenge, "challenge");
    this.challenge = challenge;
  }

  /** Enforce the serial-flow invariant instead of merely documenting it (Finding B): a second,
   *  DIFFERENT observation before the prior flow is consumed means two payment flows are
   *  interleaving on one binding. Fail closed rather than silently mis-attribute spend — binding
   *  checks catch a struct/challenge mismatch, but they cannot see origin, so an interleaved
   *  origin would otherwise mis-charge the per-domain bucket with no error. */
  private assertNoInterleave<T>(existing: T | undefined, incoming: T, what: string): void {
    if (existing !== undefined && existing !== incoming) {
      throw new PaymentBlockedError(
        "adapter.concurrent_flow",
        `A second, different ${what} was observed before the prior payment flow signed; concurrent flows on one binding are unsupported (use one binding per flow).`,
      );
    }
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
 * The NON-signing capabilities of the x402 `ClientEvmSigner` contract that the SDK may legitimately
 * call. These carry no signing power, so they are forwarded to the inner signer if present. Any
 * signing method (and everything not on this list) is deliberately NOT forwarded — see below.
 */
const NON_SIGNING_PASSTHROUGH = ["readContract", "getTransactionCount", "estimateFeesPerGas"] as const;

/**
 * Wrap an EVM signer so the guard vets every `signTypedData` before it is honored. On allow
 * the real signer runs and its signature is returned unchanged; on anything else a
 * `PaymentBlockedError` is thrown and the real signer is never reached.
 *
 * ALLOWLIST, not a spread (blocklist→allowlist hardening). The EIP-3009 authorization IS an
 * EIP-712 signature, reproducible by ANY signing route the signer exposes — so the wrap must be
 * the sole path to a signature. A `{...inner}` spread that then blocked the *known* routes
 * (`sign`/`signMessage`/`signTransaction`) re-exposed any route it didn't enumerate: a real viem
 * `LocalAccount`, for instance, also ships `signAuthorization` (EIP-7702), which leaked through
 * unguarded. So instead of copying the inner object and subtracting, we BUILD a fresh object that
 * exposes ONLY: `address`, the guarded `signTypedData`, explicit throwers for the known signing
 * routes (for a clear error), and the non-signing passthroughs above. Every other property —
 * present or future signing method, or anything else on the inner signer — is simply absent, so
 * the whole *class* of alternate signing routes is closed, not an enumerated subset.
 *
 * `guard` is any `Authorizer` — a `SpendGuard` (optionally wrapped in a `LoggingGuard`).
 */
export function guardedSigner<S extends ClientEvmSigner>(
  inner: S,
  guard: Authorizer,
  context: PaymentFlowContext,
): S {
  const blockSigningRoute = (method: string) => async (): Promise<never> => {
    throw new PaymentBlockedError(
      "adapter.unguarded_signing_route",
      `Refused '${method}': the guard vets only signTypedData; no other signing route is permitted.`,
    );
  };
  const guarded: Record<string, unknown> = {
    address: inner.address,
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
    // Known signing routes get explicit throwers for a clear error; unknown ones are simply absent.
    sign: blockSigningRoute("sign"),
    signMessage: blockSigningRoute("signMessage"),
    signTransaction: blockSigningRoute("signTransaction"),
    signAuthorization: blockSigningRoute("signAuthorization"),
  };
  // Forward ONLY the non-signing contract capabilities, and only if the inner signer provides them.
  for (const cap of NON_SIGNING_PASSTHROUGH) {
    const fn = (inner as Record<string, unknown>)[cap];
    if (typeof fn === "function") {
      guarded[cap] = (fn as (...args: unknown[]) => unknown).bind(inner);
    }
  }
  return guarded as unknown as S;
}
