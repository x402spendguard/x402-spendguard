import { describe, it, expect } from "vitest";
import { evaluate } from "../src/policy/engine.js";
import type { Policy, ProposedPayment, SpendState } from "../src/types.js";

// Caps expressed in 6-decimal USDC micro-units: 1 / 5 / 20 USDC.
const basePolicy: Policy = {
  halt: false,
  caps: { perRequest: 1_000_000n, perDomain: 5_000_000n, global: 20_000_000n },
  allowlist: [],
};

const freshState: SpendState = { spentByDomain: {}, spentGlobal: 0n };

const payment = (over: Partial<ProposedPayment> = {}): ProposedPayment => ({
  payTo: "0xAbC123",
  domain: "weather.example",
  amount: 500_000n, // 0.50 USDC
  asset: "USDC",
  chain: "base",
  ...over,
});

describe("spend-guard policy engine", () => {
  it("allows a normal payment under all caps", () => {
    expect(evaluate(payment(), basePolicy, freshState).verdict).toBe("allow");
  });

  it("kill switch denies everything", () => {
    const d = evaluate(payment(), { ...basePolicy, halt: true }, freshState);
    expect(d.verdict).toBe("deny");
    expect(d.reason).toBe("halt");
  });

  it("denies a payTo not on a non-empty allowlist", () => {
    const d = evaluate(payment(), { ...basePolicy, allowlist: ["0xSafeWallet"] }, freshState);
    expect(d.reason).toBe("allowlist.blocked");
  });

  it("allowlist match is case-insensitive", () => {
    const d = evaluate(payment({ payTo: "0xSAFEWALLET" }), { ...basePolicy, allowlist: ["0xsafewallet"] }, freshState);
    expect(d.verdict).toBe("allow");
  });

  it("denies a single payment over the per-request cap", () => {
    const d = evaluate(payment({ amount: 2_000_000n }), basePolicy, freshState);
    expect(d.reason).toBe("cap.per_request");
  });

  it("denies when the per-domain budget would be exceeded", () => {
    const state: SpendState = { spentByDomain: { "weather.example": 4_800_000n }, spentGlobal: 4_800_000n };
    const d = evaluate(payment({ amount: 300_000n }), basePolicy, state);
    expect(d.reason).toBe("cap.per_domain");
  });

  it("allows spend right up to the per-domain cap boundary", () => {
    const state: SpendState = { spentByDomain: { "weather.example": 4_500_000n }, spentGlobal: 4_500_000n };
    const d = evaluate(payment({ amount: 500_000n }), basePolicy, state);
    expect(d.verdict).toBe("allow"); // 4.5 + 0.5 == 5.0 cap, not over
  });

  it("denies when the global budget would be exceeded", () => {
    const state: SpendState = { spentByDomain: {}, spentGlobal: 19_900_000n };
    const d = evaluate(payment({ amount: 200_000n }), basePolicy, state);
    expect(d.reason).toBe("cap.global");
  });
});
