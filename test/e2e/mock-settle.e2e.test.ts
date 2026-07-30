// MOCK SETTLE — the offline, always-on sibling of funded-settle.e2e.test.ts. It proves the SAME
// happy path (policy-compliant payment → guard allows → real account signs → facilitator verifies +
// settles) but WITHOUT a chain: the real @x402 `ExactEvmScheme` runs against a chain-faking
// `FacilitatorEvmSigner` (see mock-facilitator-signer.ts). No key, no faucet, no funds — so this
// runs in the DEFAULT suite, turning the previously CI-skipped happy path into a CI-proven one.
//
// FIDELITY (what this proves vs. what funded-settle uniquely still proves):
//   - Real EIP-712/EIP-3009 signature recovery + authorization checks (IN the @x402 library).
//   - SHAPE-acceptance: the guard produces a payload the facilitator protocol accepts.
//   It does NOT prove CHAIN-acceptance (a real chain with real balance/gas includes the tx) — that
//   remains funded-settle's job. Two honest rungs of fidelity, not a replacement.
//
// The DIFFERENTIATOR test is the one a rubber-stamp mock (xpaysh/x402-local) would flunk: a tampered
// signature must be REJECTED, because the real library recovers the signer itself.
import { describe, it, expect } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme as registerClientScheme } from "@x402/evm/exact/client";
import { registerExactEvmScheme as registerFacilitatorScheme } from "@x402/evm/exact/facilitator";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { installSpendGuard } from "../../src/adapters/x402-binding.js";
import { SpendGuard, emptyState, type SpendStore, type Version } from "../../src/accounting/guard.js";
import { systemClock } from "../../src/adapters/system-clock.js";
import { parsePolicy } from "../../src/parse.js";
import type { ClientEvmSigner } from "../../src/adapters/x402-guarded-signer.js";
import type { FetchLike } from "../../src/adapters/x402-transport.js";
import { startX402Server } from "./x402-local-server.js";
import { makeMockFacilitatorSigner } from "./mock-facilitator-signer.js";

// base-sepolia coordinates (mirrors funded-settle; here they are just consistent labels — no chain).
const CHAIN = "eip155:84532";
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const AMOUNT = "10000"; // atomic USDC (6 decimals) → 0.01 USDC

// Build the whole client+guard stack and produce a REAL signed payment payload for `AMOUNT` to
// `payTo`, driven through the real @x402 client and our guard. Returns the payload + the guard state
// so a test can assert the write-ahead accounting. A throwaway account signs (real crypto, no funds).
async function makeCompliantPayment(payTo: string): Promise<{ payload: PaymentPayload; requirement: PaymentRequirements; spent: bigint }> {
  const account = privateKeyToAccount(generatePrivateKey());
  const policy = parsePolicy({
    halt: false,
    requireOriginMatch: false,
    allowlist: [{ address: payTo, chain: CHAIN }],
    caps: { [`${CHAIN}|${USDC}`]: { perRequest: AMOUNT, perDomain: AMOUNT, global: AMOUNT } },
    clockSkewSeconds: "120",
    maxAuthLifetimeSeconds: "3600",
    windowSeconds: "86400",
  });
  if (!policy.ok) throw new Error(`bad mock-test policy: ${policy.reason} ${policy.detail}`);
  let state = emptyState(systemClock.now());
  let version = 0;
  const store: SpendStore = {
    async load() { return { state, version: String(version) as Version }; },
    async compareAndSave(expected, next) { if (String(version) !== expected) return false; version++; state = next; return true; },
    async verifyAtomicity() {},
  };
  const guard = new SpendGuard(store, systemClock, policy.value);

  const client = new x402Client();
  const inst = installSpendGuard(client, {
    guard,
    signer: account as unknown as ClientEvmSigner,
    registerScheme: (c, signer) => registerClientScheme(c, { signer: signer as never }),
  });
  const httpClient = new x402HTTPClient(client);

  const requirement = { scheme: "exact", network: CHAIN, asset: USDC, amount: AMOUNT, payTo, maxTimeoutSeconds: 600, extra: { name: "USDC", version: "2" } };
  const pr = { x402Version: 2, resource: { url: "http://resource.local/x" }, accepts: [requirement] } as unknown as PaymentRequired;

  const server = await startX402Server(pr);
  try {
    const wrapped = inst.wrapFetch(((i, init) => fetch(i as string, init as RequestInit)) as FetchLike<Response>);
    const res = await wrapped(server.url);
    const header = res.headers.get("PAYMENT-REQUIRED");
    const body = header ? undefined : await res.json();
    const paymentRequired = httpClient.getPaymentRequiredResponse((n) => res.headers.get(n), body);
    const payload = (await client.createPaymentPayload(paymentRequired)) as PaymentPayload;
    return { payload, requirement: requirement as unknown as PaymentRequirements, spent: state.spentByAsset[`${CHAIN}|${USDC}`] };
  } finally {
    await server.close();
  }
}

// A real facilitator (real ExactEvmScheme) backed by the chain-faking signer. `faults` drives
// chain-state failure injection; the crypto/authorization checks always run for real.
function mockFacilitator(faults?: Parameters<typeof makeMockFacilitatorSigner>[0]["faults"]): x402Facilitator {
  const signer = makeMockFacilitatorSigner({ deployedContracts: [USDC], token: { name: "USDC", version: "2" }, faults });
  const facilitator = new x402Facilitator();
  registerFacilitatorScheme(facilitator, { signer, networks: CHAIN });
  return facilitator;
}

describe("mock settle (offline, no chain, always-on) — real crypto, faked chain", () => {
  it("HAPPY: guard allows → real account signs → facilitator verifies + settles (synthetic tx)", async () => {
    const payTo = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const { payload, requirement, spent } = await makeCompliantPayment(payTo);

    // The guard passed it through OUR gate and recorded the spend (write-ahead accounting).
    expect(spent).toBe(BigInt(AMOUNT));

    const facilitator = mockFacilitator();
    const verify = await facilitator.verify(payload, requirement);
    expect(verify.isValid, `verify failed: ${verify.invalidReason ?? ""} ${verify.invalidMessage ?? ""}`).toBe(true);

    const settle = await facilitator.settle(payload, requirement);
    expect(settle.success, `settle failed: ${settle.errorReason ?? ""}`).toBe(true);
    expect(settle.transaction, "settle returns a well-formed synthetic tx hash").toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("DIFFERENTIATOR: the SAME payload is accepted untampered but REJECTED after one flipped byte", async () => {
    const payTo = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const { payload, requirement } = await makeCompliantPayment(payTo);
    const facilitator = mockFacilitator();

    // NON-VACUOUS: the untouched payload IS accepted — we are not simply rejecting everything.
    expect((await facilitator.verify(payload, requirement)).isValid).toBe(true);

    // Flip ONE hex nibble of the signature so it no longer recovers to `authorization.from`.
    // This is the exact payload a rubber-stamp mock (xpaysh/x402-local) waves through green; the
    // real @x402 ECDSA recovery — which the injected signer cannot reach — flips it to rejected.
    const bad = structuredClone(payload) as PaymentPayload & { payload: { signature: string } };
    const sig = bad.payload.signature;
    bad.payload.signature = sig.slice(0, 12) + (sig[12] === "a" ? "b" : "a") + sig.slice(13);
    const verify = await facilitator.verify(bad, requirement);
    expect(verify.isValid).toBe(false);
    expect(String(verify.invalidReason ?? "")).toContain("signature");
  });

  it("FAULT: injecting a reverting transfer flips a PASSING payment to REJECTED", async () => {
    const payTo = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const { payload, requirement } = await makeCompliantPayment(payTo);

    // The very same payload the happy path accepts…
    expect((await mockFacilitator().verify(payload, requirement)).isValid).toBe(true);
    // …is rejected once a chain-state fault is injected. (The reason is the facilitator's generic
    // simulation-failure code at this fidelity; precise insufficient_balance/nonce diagnosis is a
    // deferred rung — see MockFacilitatorFaults.)
    const verify = await mockFacilitator({ transferReverts: true }).verify(payload, requirement);
    expect(verify.isValid).toBe(false);
    expect(verify.invalidReason, "a rejection reason is surfaced").toBeTruthy();
  });

  it("FAULT: settleReverts flips a SETTLING payment to a loud, labeled settle failure", async () => {
    const payTo = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const { payload, requirement } = await makeCompliantPayment(payTo);

    // Baseline: with no fault, the same payload settles successfully…
    expect((await mockFacilitator().settle(payload, requirement)).success).toBe(true);

    // …and injecting a mined-but-reverted receipt flips settle to a labeled failure (not a silent
    // pass). The fault-injection knob is the tool's controllable "make settlement fail" lever, so it
    // must demonstrably change the outcome — an untested knob that never fires would be worthless.
    const settle = await mockFacilitator({ settleReverts: true }).settle(payload, requirement);
    expect(settle.success).toBe(false);
    expect(String(settle.errorReason ?? ""), "a settle failure reason is surfaced").toContain("transaction_failed");
  });
});
