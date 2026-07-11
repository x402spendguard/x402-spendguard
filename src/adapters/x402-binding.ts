// The drop-in binding: one call gives the three wiring pieces an x402 client needs, all
// sharing one correlation context. The x402 SDK requires interposition at three points
// (transport, payment hook, signer), so this is as close to "one-liner" as the SDK allows —
// honestly a small wiring, not magic.
//
// `src/` stays free of any `@x402` import: the hook/context shapes are declared STRUCTURALLY
// here (verified against @x402/core 2.18.0). A test asserts these are assignable to the real
// @x402 types, so drift is caught without coupling the guard to the SDK at build time.
import { challengeFromV2, type V2Offer, type V2PaymentRequired } from "./x402-wire.js";
import { PaymentFlowContext, guardedSigner, type ClientEvmSigner } from "./x402-guarded-signer.js";
import { guardedFetch, type FetchLike, type ResponseLike } from "./x402-transport.js";
import type { Authorizer } from "../audit/decision-log.js";

/** Structural match of @x402/core's `PaymentCreationContext` (2.18.0). */
export interface PaymentCreationContextLike {
  paymentRequired: V2PaymentRequired;
  selectedRequirements: V2Offer;
}

/** Structural match of @x402/core's `BeforePaymentCreationHook`. */
export type BeforePaymentCreationHookLike = (
  context: PaymentCreationContextLike,
) => Promise<void | { abort: true; reason: string }>;

/**
 * A payment hook that captures the challenge (offer + 402 body) into the flow context. On an
 * unsupported/malformed offer it aborts early with a clean reason; otherwise it records the
 * challenge and returns void so the flow proceeds to signing, where the guarded signer makes
 * the real, fully-correlated decision.
 */
export function challengeCaptureHook(context: PaymentFlowContext): BeforePaymentCreationHookLike {
  return async (ctx) => {
    const challenge = challengeFromV2(ctx.paymentRequired, ctx.selectedRequirements);
    if (!challenge.ok) return { abort: true, reason: challenge.reason };
    context.observeChallenge(challenge.value);
  };
}

/** The pieces the caller wires into their x402 client, all sharing one flow context. */
export interface SpendGuardBinding {
  /** The shared correlation context (usually you don't touch this directly). */
  context: PaymentFlowContext;
  /** Wrap your EVM signer; pass the result to the x402 EVM scheme. */
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
