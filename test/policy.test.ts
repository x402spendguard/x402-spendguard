import { describe, it, expect } from "vitest";
import { evaluate } from "../src/policy/engine.js";
import { assetKey } from "../src/parse.js";
import type { Address, ChainId, OpaqueHex, PaymentEvaluation, Policy } from "../src/types.js";
import { A, T, key, CHAIN, USDC, PAYEE, ATTACKER, ORIGIN, NOW, caps, policy, freshState, state, ev } from "./helpers.js";

// Tests build already-parsed (trustworthy) values via the shared helpers; the
// parse boundary itself is covered in parse.test.ts.
const decide = (e: PaymentEvaluation, p = policy(), s = freshState(), now = NOW) =>
  evaluate(e, p, s, now);

describe("policy engine — happy path", () => {
  it("allows a well-formed, in-policy payment", () => {
    expect(decide(ev()).verdict).toBe("allow");
  });
});

describe("kill switch", () => {
  it("halt-denies-valid", () => {
    const d = decide(ev(), policy({ halt: true }));
    expect(d.verdict).toBe("deny");
    expect(d.reason).toBe("halt");
  });
});

describe("allowlist", () => {
  it("allowlist-blocks-unlisted", () => {
    const attacker = "0x9999999999999999999999999999999999999999" as Address;
    const d = decide(ev({ payTo: attacker }, { to: attacker }));
    expect(d.reason).toBe("allowlist.blocked");
  });

  it("empty-allowlist-denies-all", () => {
    // The hole we criticized Sentinel for: an empty allowlist must DENY, not allow.
    const d = decide(ev(), policy({ allowlist: [] }));
    expect(d.verdict).toBe("deny");
    expect(d.reason).toBe("allowlist.empty");
  });

  it("allowlist-same-address-wrong-chain-denied", () => {
    // Address is allowed on Base; the payment is on a different chain ⇒ deny.
    const other = "eip155:1" as ChainId;
    const d = decide(ev({ network: other, asset: USDC }, { chainId: other, to: PAYEE, verifyingContract: USDC }));
    // Binding passes (challenge & auth agree on the other chain); allowlist entry is Base-only.
    expect(d.reason).toBe("allowlist.blocked");
  });
});

describe("signature-integrity binding", () => {
  it("bind-rejects-overpayment", () => {
    // Challenge asks 0.5 USDC; the signed value is 5 USDC.
    const d = decide(ev({ amount: A(500_000n) }, { value: A(5_000_000n) }));
    expect(d.reason).toBe("bind.amount_mismatch");
  });

  it("bind-rejects-recipient-swap", () => {
    const attacker = "0x9999999999999999999999999999999999999999" as Address;
    const d = decide(ev({ payTo: PAYEE }, { to: attacker }));
    expect(d.reason).toBe("bind.recipient_mismatch");
  });

  it("bind-rejects-long-lived-auth", () => {
    // maxTimeoutSeconds=600, skew=60; validBefore beyond now+660 must be denied.
    const d = decide(ev({ maxTimeoutSeconds: T(600n) }, { validBefore: T(NOW + 100_000n) }));
    expect(d.reason).toBe("bind.timeout_exceeded");
  });

  it("bind-rejects-asset-mismatch", () => {
    const otherToken = "0xffffffffffffffffffffffffffffffffffffffff" as Address;
    const d = decide(ev({ asset: USDC }, { verifyingContract: otherToken }));
    expect(d.reason).toBe("bind.asset_mismatch");
  });
});

describe("spend caps (per asset,chain denomination)", () => {
  it("cap-per-request-boundary", () => {
    const p = policy({ caps: caps({ perRequest: A(500_000n) }) });
    expect(decide(ev({ amount: A(500_000n) }, { value: A(500_000n) }), p).verdict).toBe("allow"); // exactly at cap
    const over = decide(ev({ amount: A(500_001n) }, { value: A(500_001n) }), p);
    expect(over.reason).toBe("cap.per_request");
  });

  it("cap-per-domain", () => {
    const s = state({ spentByDomain: { [ORIGIN]: { [key]: 4_800_000n } }, spentByAsset: { [key]: 4_800_000n } });
    const d = decide(ev(), policy(), s);
    expect(d.reason).toBe("cap.per_domain"); // 4.8 + 0.5 = 5.3 > 5.0
  });

  it("cap-global", () => {
    const s = state({ spentByAsset: { [key]: 19_800_000n } });
    const d = decide(ev(), policy(), s);
    expect(d.reason).toBe("cap.global"); // 19.8 + 0.5 = 20.3 > 20.0
  });

  it("cap-no-cross-asset-sum", () => {
    // Huge spend recorded in a DIFFERENT denomination must not block this payment.
    const otherKey = assetKey({ chain: CHAIN, token: "0xffffffffffffffffffffffffffffffffffffffff" as Address });
    const s = state({ spentByAsset: { [otherKey]: 999_000_000n } });
    expect(decide(ev(), policy(), s).verdict).toBe("allow");
  });

  it("cap-asset-unconfigured", () => {
    // Payment in a denomination with no configured cap ⇒ deny (fail-closed).
    const d = decide(ev(), policy({ caps: {} }));
    expect(d.reason).toBe("cap.asset_unconfigured");
  });
});

describe("fail closed", () => {
  it("throwing-check-denies", () => {
    // A Proxy policy that throws when the engine reads `.halt` must yield deny, not crash.
    const boom = new Proxy(policy(), {
      get(_t, prop) {
        if (prop === "halt") throw new Error("boom");
        return undefined;
      },
    }) as Policy;
    const d = decide(ev(), boom);
    expect(d.verdict).toBe("deny");
    expect(d.reason).toBe("engine.error");
  });
});

describe("observability", () => {
  it("every-decision-has-reason", () => {
    const d = decide(ev());
    expect(typeof d.reason).toBe("string");
    expect(d.reason.length).toBeGreaterThan(0);
  });
});

describe("purity", () => {
  it("core-is-pure", () => {
    const e = ev();
    const p = policy();
    const s = freshState();
    const first = evaluate(e, p, s, NOW);
    const second = evaluate(e, p, s, NOW);
    expect(second).toEqual(first); // same inputs ⇒ same decision
    expect(s).toEqual(freshState()); // engine did not mutate state
  });
});

describe("cross-origin check (requireOriginMatch)", () => {
  it("allows when the challenge resource origin matches the request origin", () => {
    // origin "weather.example" vs resource "https://weather.example/forecast" (default) -> match
    const d = decide(ev(), policy({ requireOriginMatch: true }));
    expect(d.verdict).toBe("allow");
  });

  it("ignores a port difference (canonical origin is host-only)", () => {
    // A port on the resource URL must not false-deny against a bare-host origin.
    const d = decide(ev({ resource: "https://weather.example:8443/forecast" }), policy({ requireOriginMatch: true }));
    expect(d.verdict).toBe("allow");
  });

  it("denies when the challenge resource origin differs from the request origin", () => {
    const d = decide(ev({ resource: "https://attacker.example/forecast" }), policy({ requireOriginMatch: true }));
    expect(d.reason).toBe("origin.mismatch");
  });
});

describe("v2 seam — nonce", () => {
  it("nonce-unread-in-v1", () => {
    // Changing ONLY the nonce must not change the decision: v1 never reads it.
    const withA = decide(ev({}, { nonce: "0xaaaa" as OpaqueHex }));
    const withB = decide(ev({}, { nonce: "0xbbbb" as OpaqueHex }));
    expect(withB).toEqual(withA);
  });
});
