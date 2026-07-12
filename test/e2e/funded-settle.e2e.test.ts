// FUNDED SETTLE — the one test that moves real value. It proves the HAPPY path end-to-end: a
// policy-COMPLIANT payment passes our guard, a real funded viem LocalAccount signs it through our
// allowlist wrap, and a real facilitator VERIFIES and SETTLES it on base-sepolia (real USDC moves).
//
// This is the last thing the deny-path harness cannot prove: that an ALLOWED payment is not just
// un-blocked, but actually settleable — that the guard produces a valid, on-chain-acceptable
// payment. See test/e2e/FUNDED.md for the runbook (provision a throwaway wallet + faucet USDC).
//
// SAFETY / HERMETICITY: this suite SELF-SKIPS unless `TESTNET_PRIVATE_KEY` is provided (via an
// untracked test/e2e/.env or a shell export). So `npm test`, `npm run test:e2e`, and CI never move
// funds — they just skip it. It runs ONLY when an operator deliberately opts in with a funded key.
// EIP-3009 is relayed: the facilitator sponsors gas, so the wallet needs testnet USDC only, no ETH.
import { describe, it, expect } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { HTTPFacilitatorClient } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { createSpendGuardBinding } from "../../src/adapters/x402-binding.js";
import { SpendGuard, emptyState, type SpendStore } from "../../src/accounting/guard.js";
import { systemClock } from "../../src/adapters/system-clock.js";
import { parsePolicy } from "../../src/parse.js";
import type { ClientEvmSigner } from "../../src/adapters/x402-guarded-signer.js";
import type { FetchLike } from "../../src/adapters/x402-transport.js";
import { startX402Server } from "./x402-local-server.js";

const KEY = process.env.TESTNET_PRIVATE_KEY;

// base-sepolia coordinates (verified against @x402/evm constants).
const CHAIN = "eip155:84532";
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";

// SELF-SKIP unless a funded key is provided — this is what keeps the default gate and CI hermetic.
describe.skipIf(!KEY)("FUNDED settle (base-sepolia, real USDC moves) — opt-in via TESTNET_PRIVATE_KEY", () => {
  it("compliant payment: guard allows → real account signs → facilitator verifies + settles on-chain", async () => {
    const account = privateKeyToAccount(KEY as `0x${string}`);
    const payTo = (process.env.X402_PAY_TO ?? privateKeyToAccount(generatePrivateKey()).address).toLowerCase();
    const amount = process.env.X402_AMOUNT ?? "10000"; // atomic USDC (6 decimals) → 0.01 USDC
    const facilitatorUrl = process.env.X402_FACILITATOR_URL; // undefined → SDK default (x402.org)
    // eslint-disable-next-line no-console
    console.log(`[funded] payer=${account.address} → payTo=${payTo} amount=${amount} (atomic USDC)`);

    // A policy that ALLOWS exactly this payment: payTo on the allowlist, caps sized to admit it.
    const policy = parsePolicy({
      halt: false,
      requireOriginMatch: false,
      allowlist: [{ address: payTo, chain: CHAIN }],
      caps: { [`${CHAIN}|${USDC}`]: { perRequest: amount, perDomain: amount, global: amount } },
      clockSkewSeconds: "120",
      maxAuthLifetimeSeconds: "3600",
      windowSeconds: "86400",
    });
    if (!policy.ok) throw new Error(`bad funded-test policy: ${policy.reason} ${policy.detail}`);
    let state = emptyState(systemClock.now());
    const store: SpendStore = { async load() { return state; }, async save(s) { state = s; } };
    const guard = new SpendGuard(store, systemClock, policy.value);

    // Wire the real @x402 client with our binding and the REAL funded account (allowlist-wrapped).
    const binding = createSpendGuardBinding(guard);
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: binding.wrapSigner(account as unknown as ClientEvmSigner) as never });
    client.onBeforePaymentCreation(binding.hook);
    const httpClient = new x402HTTPClient(client);

    // A genuine 402 for the compliant payment (served locally; self-certified by the helper).
    const requirement = { scheme: "exact", network: CHAIN, asset: USDC, amount, payTo, maxTimeoutSeconds: 600, extra: { name: "USDC", version: "2" } };
    const pr = { x402Version: 2, resource: { url: "http://resource.local/x" }, accepts: [requirement] } as unknown as PaymentRequired;

    const server = await startX402Server(pr);
    let paymentPayload: unknown;
    try {
      const wrapped = binding.wrapFetch(((i, init) => fetch(i as string, init as RequestInit)) as FetchLike<Response>);
      const res = await wrapped(server.url);
      const header = res.headers.get("PAYMENT-REQUIRED");
      const body = header ? undefined : await res.json();
      const paymentRequired = httpClient.getPaymentRequiredResponse((n) => res.headers.get(n), body);
      // Guard runs at the signer wrap; on ALLOW the real account produces a genuine EIP-3009 sig.
      paymentPayload = await client.createPaymentPayload(paymentRequired);
    } finally {
      await server.close();
    }

    // The guard passed it through OUR gate and recorded the spend (write-ahead accounting).
    expect(state.spentByAsset[`${CHAIN}|${USDC}`]).toBe(BigInt(amount));

    // Settle FOR REAL against the facilitator (it sponsors gas; our wallet paid USDC only).
    const facilitator = new HTTPFacilitatorClient(facilitatorUrl ? { url: facilitatorUrl } : undefined);
    const verify = await facilitator.verify(paymentPayload as never, requirement as unknown as PaymentRequirements);
    expect(verify.isValid, `facilitator verify failed: ${verify.invalidReason ?? ""} ${verify.invalidMessage ?? ""}`).toBe(true);

    const settle = await facilitator.settle(paymentPayload as never, requirement as unknown as PaymentRequirements);
    expect(settle.success, `facilitator settle failed: ${settle.errorReason ?? ""} ${settle.errorMessage ?? ""}`).toBe(true);
    expect(settle.transaction, "settlement should return an on-chain tx hash").toMatch(/^0x[0-9a-fA-F]{64}$/);
    // eslint-disable-next-line no-console
    console.log(`[funded] SETTLED ${amount} atomic USDC → ${payTo}  tx=${settle.transaction}`);
  });
});
