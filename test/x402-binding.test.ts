import { describe, it, expect } from "vitest";
import { challengeCaptureHook } from "../src/adapters/x402-binding.js";
import { PaymentFlowContext } from "../src/adapters/x402-guarded-signer.js";
// Compile-time compatibility check against the REAL @x402/core type (devDep). If @x402 renames
// or reshapes the hook, this import + assignment stops type-checking — drift is caught here.
import type { BeforePaymentCreationHook } from "@x402/core/client";
import { USDC, PAYEE } from "./helpers.js";

// The correlated allow/deny flow (transport + hook + signer → one decision) is owned by
// test/install-spend-guard.test.ts, which drives it through the atomic installer. This file keeps
// the `challengeCaptureHook` wire-dispatch unit tests — the one piece that is about the hook itself,
// independent of how it gets wired.

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

  it("dispatches on x402Version: a v1 body + v1 offer normalizes through the v1 wire path", async () => {
    // v1: x402Version 1, resource on the offer (not hoisted), maxAmountRequired, loose network.
    const ctx = new PaymentFlowContext();
    const v1Offer = { scheme: "exact", network: "base", maxAmountRequired: "500000", asset: USDC, payTo: PAYEE, maxTimeoutSeconds: 600, resource: "https://weather.example/forecast", extra: { name: "USD Coin", version: "2" } };
    const v1Body = { x402Version: 1, accepts: [v1Offer] };
    const result = await challengeCaptureHook(ctx)({ paymentRequired: v1Body, selectedRequirements: v1Offer });
    expect(result).toBeUndefined();
    ctx.observeOrigin("weather.example" as never);
    const captured = ctx.consume().challenge;
    expect(captured.amount).toBe(500_000n); // from maxAmountRequired
    expect(captured.network).toBe("eip155:8453"); // "base" → CAIP-2
  });

  it("aborts on an unknown x402Version (fail-closed)", async () => {
    const ctx = new PaymentFlowContext();
    const result = await challengeCaptureHook(ctx)({ paymentRequired: { ...paymentRequired(), x402Version: 3 }, selectedRequirements: offer() });
    expect(result).toEqual({ abort: true, reason: "adapter.unsupported_x402_version" });
  });

  it("the hook is structurally compatible with @x402/core's BeforePaymentCreationHook", () => {
    const asReal: BeforePaymentCreationHook = challengeCaptureHook(new PaymentFlowContext()); // assignability is the assertion
    expect(typeof asReal).toBe("function");
  });
});
