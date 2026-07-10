import { describe, it, expect } from "vitest";
import { makeAmount, makeDomain, parseChallenge, parseAuthorization } from "../src/parse.js";

describe("domain canonicalization (H2)", () => {
  it("collapses host representations to one budget bucket", () => {
    const forms = ["shop.example", "shop.example:443", "shop.example.", "https://shop.example/x", "HTTPS://Shop.Example/y"];
    const hosts = forms.map((f) => {
      const r = makeDomain(f);
      return r.ok ? r.value : "PARSE_ERR";
    });
    expect(new Set(hosts)).toEqual(new Set(["shop.example"])); // all identical
  });

  it("rejects an empty or whitespace domain", () => {
    expect(makeDomain("").ok).toBe(false);
    expect(makeDomain("   ").ok).toBe(false);
  });
});

describe("money parsing (MONEY-01)", () => {
  it("money-rejects-malformed", () => {
    for (const bad of ["-1", "1.5", "0x10", "1e6", "", "abc", " 5", NaN, 1.5, {}]) {
      const r = makeAmount(bad as unknown);
      expect(r.ok, `expected reject for ${String(bad)}`).toBe(false);
    }
    // Negative bigint is rejected with the specific negative reason.
    const neg = makeAmount(-1n);
    expect(neg.ok).toBe(false);
    if (!neg.ok) expect(neg.reason).toBe("parse.amount_negative");
  });

  it("money-precision-exact", () => {
    // A value that would lose precision as an IEEE-754 double survives exactly as bigint.
    const big = "9007199254740993"; // 2^53 + 1
    const r = makeAmount(big);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(9_007_199_254_740_993n);
  });
});

describe("parse failures are specific (PARSE-01)", () => {
  it("parse-failure-specific-reason", () => {
    const r = parseChallenge({ scheme: "exact", network: "eip155:8453", asset: "0x", payTo: "0x", amount: "-5", maxTimeoutSeconds: "600" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.startsWith("parse.")).toBe(true); // specific, not "engine.error"
      expect(r.reason).not.toBe("engine.error");
    }
  });

  it("malformed-challenge-denies", () => {
    // A missing required field yields a specific deny, never a silent skip.
    const r = parseChallenge({ scheme: "exact", network: "eip155:8453", payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } as Record<string, unknown>);
    expect(r.ok).toBe(false);
  });
});

describe("scope gate (BIND-05, SCOPE-01)", () => {
  it("nonexact-scheme-denied", () => {
    const r = parseChallenge({ scheme: "upto", network: "eip155:8453", asset: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", amount: "1", maxTimeoutSeconds: "600" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("scheme.unsupported");
  });

  it("nonevm-form-denied", () => {
    // A Solana-form authorization is rejected at the boundary — v1 is EVM-only.
    const r = parseAuthorization({ form: "svm-tx", transaction: "base64..." } as Record<string, unknown>);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("chain.unsupported");
  });
});
