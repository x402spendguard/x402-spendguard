import { describe, it, expect } from "vitest";
import {
  PaymentFlowContext,
  guardedSigner,
  PaymentBlockedError,
  type ClientEvmSigner,
} from "../src/adapters/x402-guarded-signer.js";
import type { TypedData } from "../src/adapters/x402-wire.js";
import type { Authorizer } from "../src/audit/decision-log.js";
import type { PaymentEvaluation, PolicyDecision } from "../src/types.js";
import { ORIGIN, PAYEE, USDC, NOW, challenge } from "./helpers.js";

const PAYER = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;
const ALLOW: PolicyDecision = { verdict: "allow", reason: "ok", detail: "ok" };
const DENY: PolicyDecision = { verdict: "deny", reason: "cap.per_request", detail: "over cap" };

const validTd = (over: Partial<TypedData> = {}): TypedData => ({
  primaryType: "TransferWithAuthorization",
  domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC },
  message: { from: PAYER, to: PAYEE, value: 500_000n, validAfter: 0n, validBefore: NOW + 300n, nonce: "0xdead" },
  ...over,
});

/** A guard stub that records the evaluations it was asked to decide. */
class FakeGuard implements Authorizer {
  seen: PaymentEvaluation[] = [];
  constructor(private readonly decision: PolicyDecision) {}
  async authorize(ev: PaymentEvaluation): Promise<PolicyDecision> {
    this.seen.push(ev);
    return this.decision;
  }
}

/** An inner signer that records whether it was actually asked to sign. */
function makeInner() {
  const state = { calls: 0 };
  const signer: ClientEvmSigner = {
    address: PAYER,
    async signTypedData() {
      state.calls++;
      return "0xSIGNATURE" as `0x${string}`;
    },
  };
  return { signer, state };
}

function fullContext() {
  const ctx = new PaymentFlowContext();
  ctx.observeOrigin(ORIGIN);
  ctx.observeChallenge(challenge());
  return ctx;
}

async function blocked(p: Promise<unknown>): Promise<PaymentBlockedError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PaymentBlockedError) return e;
    throw e;
  }
  throw new Error("expected the payment to be blocked, but it was not");
}

describe("guardedSigner — the veto core", () => {
  it("signs only on allow, and hands the guard the correlated (origin, challenge, struct)", async () => {
    const { signer, state } = makeInner();
    const guard = new FakeGuard(ALLOW);
    const guarded = guardedSigner(signer, guard, fullContext());

    const sig = await guarded.signTypedData(validTd());

    expect(sig).toBe("0xSIGNATURE");
    expect(state.calls).toBe(1);
    expect(guard.seen).toHaveLength(1);
    // Correlation: all three sources assembled into one evaluation.
    expect(guard.seen[0].origin).toBe(ORIGIN); // from the transport (context)
    expect(guard.seen[0].challenge.amount).toBe(500_000n); // from the offer (context)
    expect(guard.seen[0].authorization.to).toBe(PAYEE); // from the struct being signed
    expect(guard.seen[0].authorization.value).toBe(500_000n);
  });

  it("on deny, throws and NEVER produces a signature", async () => {
    const { signer, state } = makeInner();
    const guarded = guardedSigner(signer, new FakeGuard(DENY), fullContext());

    const err = await blocked(guarded.signTypedData(validTd()));
    expect(err.reason).toBe("cap.per_request");
    expect(state.calls).toBe(0); // the real signer was never reached
  });

  it("refuses unsupported typed data before the guard or signer is touched", async () => {
    const { signer, state } = makeInner();
    const guard = new FakeGuard(ALLOW);
    const guarded = guardedSigner(signer, guard, fullContext());

    const err = await blocked(guarded.signTypedData(validTd({ primaryType: "PermitWitnessTransferFrom" })));
    expect(err.reason).toBe("wire.unsupported_typed_data");
    expect(guard.seen).toHaveLength(0);
    expect(state.calls).toBe(0);
  });

  it("fails closed when the correlation context is incomplete (no origin/challenge captured)", async () => {
    const { signer, state } = makeInner();
    const guard = new FakeGuard(ALLOW); // would allow — but we cannot even evaluate
    const partial = new PaymentFlowContext();
    partial.observeChallenge(challenge()); // origin never observed
    const guarded = guardedSigner(signer, guard, partial);

    const err = await blocked(guarded.signTypedData(validTd()));
    expect(err.reason).toBe("adapter.context_incomplete");
    expect(guard.seen).toHaveLength(0); // never evaluated
    expect(state.calls).toBe(0); // never signed
  });

  it("consumes the context per signing event — a second sign without re-observing fails closed", async () => {
    const { signer } = makeInner();
    const guarded = guardedSigner(signer, new FakeGuard(ALLOW), fullContext());

    await guarded.signTypedData(validTd()); // first: allowed, context consumed
    const err = await blocked(guarded.signTypedData(validTd())); // second: context now empty
    expect(err.reason).toBe("adapter.context_incomplete");
  });

  it("preserves the inner signer's address and other properties", () => {
    const { signer } = makeInner();
    const guarded = guardedSigner(signer, new FakeGuard(ALLOW), new PaymentFlowContext());
    expect(guarded.address).toBe(PAYER);
  });
});

describe("PaymentFlowContext", () => {
  it("returns the correlated pair once both are observed, then clears", () => {
    const ctx = new PaymentFlowContext();
    ctx.observeOrigin(ORIGIN);
    ctx.observeChallenge(challenge());
    const pair = ctx.consume();
    expect(pair.origin).toBe(ORIGIN);
    expect(pair.challenge.amount).toBe(500_000n);
    // Consumed → cleared; a second take fails closed.
    expect(() => ctx.consume()).toThrow(PaymentBlockedError);
  });

  it("throws (fail-closed) if consumed while incomplete", () => {
    const ctx = new PaymentFlowContext();
    expect(() => ctx.consume()).toThrow(PaymentBlockedError); // nothing observed
    ctx.observeOrigin(ORIGIN);
    expect(() => ctx.consume()).toThrow(PaymentBlockedError); // only origin
  });
});
