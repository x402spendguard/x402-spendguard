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

// This module imports NO `@x402` package: the client's registration surface is declared STRUCTURALLY
// (`BeforeHookClientLike`) and a test asserts a real `x402Client` is assignable to it, so drift is
// caught without coupling the guard to the SDK — and the guard stays inside the no-egress core.

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

/**
 * The x402 client's registration surface `installSpendGuard` OWNS. Structural (no `@x402` import);
 * a real `x402Client` is assignable to it (asserted in a test). Only `onBeforePaymentCreation` is
 * needed here — the scheme registration goes through the injected `registerScheme` bridge, which
 * receives the concrete client type `C` so the caller's `registerExactEvmScheme(...)` type-checks.
 */
export interface BeforeHookClientLike {
  onBeforePaymentCreation(hook: BeforePaymentCreationHookLike): unknown;
}

/** What `installSpendGuard` returns. Deliberately ONLY the transport wrap: omitting it fails CLOSED
 *  (no origin → the signer refuses to sign), so — unlike a returned signer-wrapper — it cannot be a
 *  silent fail-open. There is no `wrapSigner` here to forget: the install already wrapped it. */
export interface SpendGuardInstall {
  /**
   * Wrap your x402 transport (fetch) and use the RESULT as the client's transport. This is the one
   * remaining caller step — and it is safe: if you forget it, no origin is observed and the guarded
   * signer fails closed. It never fails open.
   */
  wrapFetch: <Res extends ResponseLike>(fetch: FetchLike<Res>) => FetchLike<Res>;
}

/**
 * Atomically wire a guard into an x402 client so the veto CANNOT be forgotten. This closes the
 * Finding-D fail-open: the guard's power lived in wrapping the signer, and a caller who forgot to
 * wrap (or passed the raw signer to the scheme) got a silent, un-self-detectable fail-open.
 *
 * The fix is structural, not a warning: `installSpendGuard` OWNS the two points whose omission could
 * fail open — it registers the challenge hook itself, and it registers the payment scheme through a
 * GUARDED signer (you hand it the raw signer; it wraps it; you never hold a "wrap" step to skip).
 * The only point it cannot own — the transport — is exactly the one that fails CLOSED on omission,
 * so it is safely returned to you as `wrapFetch`.
 *
 * `registerScheme` is injected rather than imported so this core stays `@x402`-free (no-egress proof
 * + standalone install intact) and scheme-family-agnostic. It RECEIVES the guarded signer; the
 * idiomatic bridge just forwards it:
 *
 * ```ts
 * const { wrapFetch } = installSpendGuard(client, {
 *   guard,
 *   signer,                                             // your raw EVM signer — WE wrap it
 *   registerScheme: (client, signer) => registerExactEvmScheme(client, { signer }),
 * });
 * // ...then route your transport through wrapFetch and drive the client as usual.
 * ```
 *
 * The single residual footgun is a caller who deliberately IGNORES the guarded signer their bridge
 * is handed and substitutes a raw one — active circumvention by someone wiring their own code, which
 * is the "attacker owns the agent" case already outside the threat model (README / THREAT_MODEL).
 * `guard` is any `Authorizer` — a `SpendGuard`, optionally `LoggingGuard`-wrapped.
 */
export function installSpendGuard<S extends ClientEvmSigner, C extends BeforeHookClientLike>(
  client: C,
  opts: { guard: Authorizer; signer: S; registerScheme: (client: C, guardedSigner: S) => void },
): SpendGuardInstall {
  const context = new PaymentFlowContext();
  // Wrap FIRST, then register the wrapped signer — the caller's bridge only ever sees the guarded one.
  const guarded = guardedSigner(opts.signer, opts.guard, context);
  opts.registerScheme(client, guarded);
  // Own the hook so it cannot be forgotten (its omission fails closed too, but owning it is free).
  client.onBeforePaymentCreation(challengeCaptureHook(context));
  return { wrapFetch: (fetch) => guardedFetch(context, fetch) };
}
