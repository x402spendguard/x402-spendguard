import { describe, it, expect } from "vitest";
import { authorizationFromTypedData, challengeFromV2, challengeFromV1 } from "../src/adapters/x402-wire.js";
import { USDC, PAYEE, CHAIN, NOW } from "./helpers.js";

// A payer (our own wallet) — deliberately NOT logged/kept elsewhere, but present on the struct.
const PAYER = "0xcccccccccccccccccccccccccccccccccccccccc";

// The EIP-712 typed data a wrapped `signTypedData` receives for an EIP-3009 payment.
// domain.chainId is a JS number (viem), value/validAfter/validBefore are bigint (viem uint256).
const typedData = (over: Record<string, unknown> = {}) => ({
  primaryType: "TransferWithAuthorization",
  domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC },
  types: { TransferWithAuthorization: [] }, // present for realism; the guard never reads it
  message: {
    from: PAYER,
    to: PAYEE,
    value: 500_000n,
    validAfter: 0n,
    validBefore: NOW + 300n,
    nonce: "0xDEADBEEF",
    ...(over.message as Record<string, unknown>),
  },
  ...over,
});

// A v2 selected offer (PaymentRequirements) — note maxTimeoutSeconds is a JS number, amount a
// string, and there is NO `resource` on the offer in v2 (it's hoisted to the 402 body).
const offer = (over: Record<string, unknown> = {}) => ({
  scheme: "exact",
  network: "eip155:8453",
  amount: "500000",
  asset: USDC,
  payTo: PAYEE,
  maxTimeoutSeconds: 600,
  extra: { name: "USD Coin", version: "2" },
  ...over,
});

// The v2 402 body: resource is a top-level ResourceInfo object.
const paymentRequired = (over: Record<string, unknown> = {}) => ({
  x402Version: 2,
  resource: { url: "https://weather.example/forecast" },
  accepts: [offer()],
  ...over,
});

describe("x402 wire → Authorization (from the signer-wrap typed data)", () => {
  it("maps EIP-3009 TransferWithAuthorization typed data to a branded Authorization", () => {
    const r = authorizationFromTypedData(typedData());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.form).toBe("eip3009-evm");
      expect(r.value.chainId).toBe(CHAIN); // domain.chainId 8453 (number) → "eip155:8453"
      expect(r.value.verifyingContract).toBe(USDC);
      expect(r.value.to).toBe(PAYEE);
      expect(r.value.from).toBe(PAYER);
      expect(r.value.value).toBe(500_000n); // viem bigint → branded Amount
      expect(r.value.validBefore).toBe(NOW + 300n);
      expect(r.value.nonce).toBe("0xdeadbeef"); // lowercased at the parse boundary
    }
  });

  it("rejects non-EIP-3009 typed data (e.g. a Permit2 witness) — v1 EVM exact only", () => {
    const permit2 = typedData({ primaryType: "PermitWitnessTransferFrom" });
    const r = authorizationFromTypedData(permit2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wire.unsupported_typed_data");
  });

  it("fails closed when the struct is malformed (value as a JS number, not bigint/string)", () => {
    const bad = typedData({ message: { from: PAYER, to: PAYEE, value: 500000, validAfter: 0n, validBefore: NOW + 300n, nonce: "0xab" } });
    const r = authorizationFromTypedData(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("parse.amount_malformed");
  });
});

describe("x402 wire → Challenge (from the v2 offer + top-level resource)", () => {
  it("maps a v2 offer and the 402 body's resource.url to a branded Challenge", () => {
    const r = challengeFromV2(paymentRequired(), offer());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.scheme).toBe("exact");
      expect(r.value.network).toBe(CHAIN);
      expect(r.value.asset).toBe(USDC);
      expect(r.value.payTo).toBe(PAYEE);
      expect(r.value.amount).toBe(500_000n);
      expect(r.value.maxTimeoutSeconds).toBe(600n); // JS number → branded UnixSeconds
      // The resource comes from the 402 body's top-level ResourceInfo, NOT the offer (v2).
      expect(r.value.resource).toBe("https://weather.example/forecast");
    }
  });

  it("takes resource ONLY from the 402 body — a resource on the offer is ignored (v2 shape)", () => {
    // Even if a server smuggles a `resource` onto the offer, v2's real resource is top-level.
    const r = challengeFromV2(paymentRequired({ resource: { url: "https://real.example/x" } }), offer({ resource: "https://spoofed.example/y" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.resource).toBe("https://real.example/x");
  });

  it("rejects a non-exact scheme (bubbles up from the parse boundary)", () => {
    const r = challengeFromV2(paymentRequired(), offer({ scheme: "upto" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("scheme.unsupported");
  });

  it("fails closed on a malformed amount", () => {
    const r = challengeFromV2(paymentRequired(), offer({ amount: "1.5" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("parse.amount_malformed");
  });
});

// v1 (deprecated but deployed): the SAME @x402/core client speaks v1 through the same signer
// and the same onBeforePaymentCreation hook — ONLY the offer shape differs. `maxAmountRequired`
// (not `amount`), `resource` on the offer (v2 hoists it to the body), and a LOOSE network name
// ("base-sepolia") we must map to CAIP-2 via the authoritative @x402/evm table. Unknown network
// fails closed — we cannot key caps/allowlist or cross-check the struct's chainId without it.
const v1Offer = (over: Record<string, unknown> = {}) => ({
  scheme: "exact",
  network: "base", // loose v1 name, not "eip155:8453"
  maxAmountRequired: "500000", // v1 field name (v2 renamed to `amount`)
  asset: USDC,
  payTo: PAYEE,
  maxTimeoutSeconds: 600,
  resource: "https://weather.example/forecast", // on the offer in v1 (not hoisted)
  extra: { name: "USD Coin", version: "2" },
  ...over,
});

describe("x402 wire → Challenge (v1 offer)", () => {
  it("maps a v1 offer (maxAmountRequired, loose network, offer-level resource) to a branded Challenge", () => {
    const r = challengeFromV1(v1Offer());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.scheme).toBe("exact");
      expect(r.value.network).toBe(CHAIN); // "base" → "eip155:8453"
      expect(r.value.asset).toBe(USDC);
      expect(r.value.payTo).toBe(PAYEE);
      expect(r.value.amount).toBe(500_000n); // from maxAmountRequired
      expect(r.value.maxTimeoutSeconds).toBe(600n);
      expect(r.value.resource).toBe("https://weather.example/forecast");
    }
  });

  it("maps the testnet network name base-sepolia → eip155:84532 (the live-harness target)", () => {
    const r = challengeFromV1(v1Offer({ network: "base-sepolia" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.network).toBe("eip155:84532");
  });

  it("fails closed on an unknown v1 network name (cannot key caps or cross-check chainId)", () => {
    const r = challengeFromV1(v1Offer({ network: "base-goerli" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wire.unknown_v1_network");
  });

  it("does not resolve a network name via the prototype chain (Object.hasOwn guard)", () => {
    for (const evil of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      const r = challengeFromV1(v1Offer({ network: evil }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("wire.unknown_v1_network");
    }
  });

  it("rejects a non-exact scheme (bubbles up from the parse boundary)", () => {
    const r = challengeFromV1(v1Offer({ scheme: "upto" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("scheme.unsupported");
  });

  it("fails closed on a malformed maxAmountRequired", () => {
    const r = challengeFromV1(v1Offer({ maxAmountRequired: "1.5" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("parse.amount_malformed");
  });
});
