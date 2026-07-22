// The drop-in binding: one call gives the three wiring pieces an x402 client needs, all
// sharing one correlation context. The x402 SDK requires interposition at three points
// (transport, payment hook, signer), so this is as close to "one-liner" as the SDK allows —
// honestly a small wiring, not magic.
//
// `src/` stays free of any `@x402` import: the hook/context shapes are declared STRUCTURALLY
// here (verified against @x402/core 2.18.0). A test asserts these are assignable to the real
// @x402 types, so drift is caught without coupling the guard to the SDK at build time.
import { challengeFromV2, challengeFromV1, type V1Offer, type V2Offer, type V2PaymentRequired } from "./x402-wire.js";
import { PaymentFlowContext, guardedSigner, type ClientEvmSigner } from "./x402-guarded-signer.js";
import { guardedFetch, type FetchLike, type ResponseLike } from "./x402-transport.js";
import type { Authorizer } from "../audit/decision-log.js";
import type { ReasonCode } from "../reasons.js";

/** Structural match of @x402/core's `PaymentCreationContext` (2.18.0). `selectedRequirements`
 *  is the union of both generations' offer shapes — `x402Version` on `paymentRequired` selects
 *  which fields the hook reads (v1: `maxAmountRequired` + loose network; v2: `amount` + CAIP-2). */
export interface PaymentCreationContextLike {
  paymentRequired: V2PaymentRequired;
  selectedRequirements: V1Offer & V2Offer;
}

/** Structural match of @x402/core's `BeforePaymentCreationHook`. */
export type BeforePaymentCreationHookLike = (
  context: PaymentCreationContextLike,
) => Promise<void | { abort: true; reason: string }>;

/**
 * A payment hook that captures the challenge (offer + 402 body) into the flow context. The
 * `@x402/core` client fires this hook for BOTH generations (verified 2.18.0), so it dispatches
 * on the authoritative `x402Version` discriminator — v2 takes the resource from the hoisted body,
 * v1 from the offer and maps its loose network name. An unsupported/malformed offer OR an unknown
 * version aborts early with a clean reason; otherwise it records the challenge and returns void so
 * the flow proceeds to signing, where the guarded signer makes the real, fully-correlated decision.
 */
export function challengeCaptureHook(context: PaymentFlowContext): BeforePaymentCreationHookLike {
  return async (ctx) => {
    const version = ctx.paymentRequired?.x402Version;
    let challenge;
    if (version === 2) {
      challenge = challengeFromV2(ctx.paymentRequired, ctx.selectedRequirements);
    } else if (version === 1) {
      challenge = challengeFromV1(ctx.selectedRequirements);
    } else {
      // Typed variable (not a raw literal) so the code stays anchored to the registry (reasons.ts).
      const reason: ReasonCode = "adapter.unsupported_x402_version";
      return { abort: true, reason };
    }
    if (!challenge.ok) return { abort: true, reason: challenge.reason };
    context.observeChallenge(challenge.value);
  };
}

/** The pieces the caller wires into their x402 client, all sharing one flow context. */
export interface SpendGuardBinding {
  /** The shared correlation context (usually you don't touch this directly). */
  context: PaymentFlowContext;
  /**
   * MANDATORY WIRE (Finding D). Wrap your EVM signer and pass the RESULT to the x402 EVM scheme.
   * The veto *is* this wrap — if you forget it and pass your raw signer, the guard never runs and
   * every payment is signed unchecked, SILENTLY. Unlike `wrapFetch`/`hook` (whose omission fails
   * closed via an incomplete context), a missing `wrapSigner` fails OPEN and cannot self-detect.
   * Wire this one first.
   */
  wrapSigner: <S extends ClientEvmSigner>(signer: S) => S;
  /** Register on the client: `client.onBeforePaymentCreation(binding.hook)`. */
  hook: BeforePaymentCreationHookLike;
  /** Wrap your fetch; pass the result as the x402 transport. */
  wrapFetch: <Res extends ResponseLike>(fetch: FetchLike<Res>) => FetchLike<Res>;
}

/**
 * Bind a guard (a `SpendGuard`, optionally `LoggingGuard`-wrapped) to the three x402
 * interposition points. The returned pieces share one `PaymentFlowContext`, so origin
 * (transport), challenge (hook), and struct (signer) correlate for each payment flow.
 */
export function createSpendGuardBinding(guard: Authorizer): SpendGuardBinding {
  const context = new PaymentFlowContext();
  return {
    context,
    wrapSigner: (signer) => guardedSigner(signer, guard, context),
    hook: challengeCaptureHook(context),
    wrapFetch: (fetch) => guardedFetch(context, fetch),
  };
}
