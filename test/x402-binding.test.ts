import { describe, it, expect } from "vitest";
import { createSpendGuardBinding, challengeCaptureHook } from "../src/adapters/x402-binding.js";
import { PaymentFlowContext, type ClientEvmSigner } from "../src/adapters/x402-guarded-signer.js";
import type { TypedData } from "../src/adapters/x402-wire.js";
import type { ResponseLike } from "../src/adapters/x402-transport.js";
import type { Authorizer } from "../src/audit/decision-log.js";
import type { PaymentEvaluation, PolicyDecision } from "../src/types.js";
// Compile-time compatibility check against the REAL @x402/core type (devDep). If @x402 renames
// or reshapes the hook, this import + assignment stops type-checking — drift is caught here.
import type { BeforePaymentCreationHook } from "@x402/core/client";
import { USDC, PAYEE, NOW, challenge } from "./helpers.js";

const PAYER = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;
const ALLOW: PolicyDecision = { verdict: "allow", reason: "ok", detail: "ok" };
const DENY: PolicyDecision = { verdict: "deny", reason: "allowlist.blocked", detail: "no" };

class FakeGuard implements Authorizer {
  seen: PaymentEvaluation[] = [];
  constructor(private readonly decision: PolicyDecision) {}
  async authorize(ev: PaymentEvaluation): Promise<PolicyDecision> {
    this.seen.push(ev);
    return this.decision;
  }
}

const validTd = (): TypedData => ({
  primaryType: "TransferWithAuthorization",
  domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC },
  message: { from: PAYER, to: PAYEE, value: 500_000n, validAfter: 0n, validBefore: NOW + 300n, nonce: "0xdead" },
});
const innerSigner = (): ClientEvmSigner => ({ address: PAYER, async signTypedData() { return "0xSIGNATURE"; } });
const offer = () => ({ scheme: "exact", network: "eip155:8453", amount: "500000", asset: USDC, payTo: PAYEE, maxTimeoutSeconds: 600, extra: { name: "USD Coin", version: "2" } });
const paymentRequired = () => ({ x402Version: 2, resource: { url: "https://weather.example/forecast" }, accepts: [offer()] });

describe("challengeCaptureHook", () => {
  it("captures the challenge into the context and lets the flow proceed", async () => {
    const ctx = new PaymentFlowContext();
    const result = await challengeCaptureHook(ctx)({ paymentRequired: paymentRequired(), selectedRequirements: offer() });
    expect(result).toBeUndefined(); // void → proceed (the real veto is at the signer)
    ctx.observeOrigin("weather.example" as never); // complete the pair
    expect(ctx.consume().challenge.amount).toBe(500_000n);
  });

  it("aborts early on an unsupported offer (fail-closed with a clean reason)", async () => {
    const ctx = new PaymentFlowContext();
    const bad = { paymentRequired: paymentRequired(), selectedRequirements: { ...offer(), scheme: "upto" } };
    const result = await challengeCaptureHook(ctx)(bad);
    expect(result).toEqual({ abort: true, reason: "scheme.unsupported" });
  });
});

describe("createSpendGuardBinding — the full correlated flow", () => {
  it("threads origin (transport) + challenge (hook) + struct (signer) into one allowed decision", async () => {
    const guard = new FakeGuard(ALLOW);
    const b = createSpendGuardBinding(guard);

    // 1. transport sees the 402 → real origin captured
    const inner = async (): Promise<ResponseLike> => ({ status: 402, url: "https://weather.example/forecast" });
    await b.wrapFetch(inner)("https://weather.example/forecast");
    // 2. hook captures the offer
    await b.hook({ paymentRequired: paymentRequired(), selectedRequirements: offer() });
    // 3. signer runs the guard and, on allow, signs
    const sig = await b.wrapSigner(innerSigner()).signTypedData(validTd());

    expect(sig).toBe("0xSIGNATURE");
    expect(guard.seen).toHaveLength(1);
    // DOM-01: the origin is the client-observed transport host, NOT the server-declared resource.
    expect(guard.seen[0].origin).toBe("weather.example");
    expect(guard.seen[0].challenge.payTo).toBe(PAYEE);
    expect(guard.seen[0].authorization.value).toBe(500_000n);
  });

  it("blocks the signature when the guard denies", async () => {
    const b = createSpendGuardBinding(new FakeGuard(DENY));
    await b.wrapFetch(async (): Promise<ResponseLike> => ({ status: 402, url: "https://weather.example/forecast" }))("https://weather.example/forecast");
    await b.hook({ paymentRequired: paymentRequired(), selectedRequirements: offer() });
    await expect(b.wrapSigner(innerSigner()).signTypedData(validTd())).rejects.toThrow(/allowlist\.blocked/);
  });

  it("the hook is structurally compatible with @x402/core's BeforePaymentCreationHook", () => {
    const b = createSpendGuardBinding(new FakeGuard(ALLOW));
    const asReal: BeforePaymentCreationHook = b.hook; // assignability is the assertion
    expect(typeof asReal).toBe("function");
  });
});
