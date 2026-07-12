// DENY-PATH END-TO-END HARNESS — the real @x402 client, a genuine 402 over real localhost
// HTTP, driven through our `createSpendGuardBinding`, must reach a signature ONLY through our
// wrapped `signTypedData`, and on a policy DENY must throw with NO signing route touched.
//
// Why this is the gate before any funded wallet: unit tests prove the guard decides correctly
// in isolation; this proves the guard is actually WIRED into the real SDK's payment flow — that
// the real `ExactEvmScheme` (both x402 generations) hits our veto and cannot route around it.
//
// No key, no funds: the deny path never releases a signature, so the signer is a CANARY that
// records which route was reached and never produces a real signature. If any route fires on a
// deny, the canary shows it and the test fails loudly. (The funded allowed-settle path — which
// WOULD need a testnet key — is the deferred next milestone; see README.md.)
//
// Hermetic: localhost only, ephemeral port, no secrets, no external network. Runs opt-in via
// `npm run test:e2e` (its own vitest config + CI job), never the default green-main gate. Lives
// under test/e2e/ so the static no-egress proof over src/ is untouched.
import { describe, it, expect } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import type { PaymentRequired } from "@x402/core/types";
import { createSpendGuardBinding } from "../../src/adapters/x402-binding.js";
import { SpendGuard, emptyState, type Clock, type SpendStore, type Version } from "../../src/accounting/guard.js";
import { systemClock } from "../../src/adapters/system-clock.js";
import { parsePolicy } from "../../src/parse.js";
import type { ClientEvmSigner } from "../../src/adapters/x402-guarded-signer.js";
import type { FetchLike } from "../../src/adapters/x402-transport.js";
import type { Policy } from "../../src/types.js";
import { startX402Server } from "./x402-local-server.js";

// ── Fixtures: base-sepolia coordinates. v1 "base-sepolia" and v2 "eip155:84532" resolve to the
//    SAME chain id (84532), so one policy (keyed on eip155:84532) governs both generations. ──
const CHAIN = "eip155:84532";
const NET_V1 = "base-sepolia";
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"; // real base-sepolia USDC
const PAYEE = "0x1111111111111111111111111111111111111111";
const DECOY = "0x9999999999999999999999999999999999999999";
const PAYER = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const AMOUNT = "10000"; // 0.01 USDC (6 decimals)

/** Build a real branded Policy through the actual config parser (no hand-forged branded types). */
function policyOf(over: Record<string, unknown>): Policy {
  const r = parsePolicy({
    halt: false,
    requireOriginMatch: false,
    allowlist: [{ address: PAYEE, chain: CHAIN }],
    caps: { [`${CHAIN}|${USDC}`]: { perRequest: "1000000", perDomain: "5000000", global: "20000000" } },
    clockSkewSeconds: "120",
    maxAuthLifetimeSeconds: "3600",
    windowSeconds: "86400",
    ...over,
  });
  if (!r.ok) throw new Error(`bad test policy: ${r.reason} ${r.detail}`);
  return r.value;
}

/** A real SpendGuard on an in-memory ledger + the REAL system clock. The real clock matters:
 *  the live @x402 client stamps `validBefore` from wall time, so a fake clock would false-deny
 *  at the timeout binding check. Generous lifetime + skew keep that check off the deny reason.
 *
 *  SCOPE: each `attempt()` builds a FRESH guard with fresh state, so this harness deliberately
 *  does NOT exercise cumulative spend across calls (e.g. a third payment tripping the per-domain
 *  cap because earlier ones consumed budget). Cumulative-cap enforcement over a real persisted
 *  ledger is a separate e2e case — this is a deny-path *wiring* harness, not an accounting one. */
function guardWith(policy: Policy): SpendGuard {
  let state = emptyState(systemClock.now());
  let version = 0;
  const store: SpendStore = {
    async load() {
      return { state, version: String(version) as Version };
    },
    async compareAndSave(expected, next) {
      if (String(version) !== expected) return false;
      version++;
      state = next;
      return true;
    },
    async verifyAtomicity() {},
  };
  return new SpendGuard(store, systemClock, policy);
}

/** A signer that never signs: it records every route reached and returns a shape-valid dummy so
 *  an ALLOW can proceed far enough to prove `signTypedData` was the route. On a DENY our wrap
 *  throws before the inner signer is reached, so `touched` stays empty — that IS the assertion. */
function makeCanary() {
  const touched: string[] = [];
  const dummySig = ("0x" + "11".repeat(65)) as `0x${string}`;
  const route = (name: string) => async (): Promise<`0x${string}`> => {
    touched.push(name);
    return dummySig;
  };
  const signer: ClientEvmSigner & Record<string, unknown> = {
    address: PAYER,
    signTypedData: route("signTypedData"),
    sign: route("sign"),
    signMessage: route("signMessage"),
    signTransaction: route("signTransaction"),
  };
  return { signer, touched };
}

// ── The genuine 402 challenges (schema-identical to a real server's output). ──
function prV2(): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: "http://resource.local/x" }, // server-declared; requireOriginMatch is off
    accepts: [
      { scheme: "exact", network: CHAIN, asset: USDC, amount: AMOUNT, payTo: PAYEE, maxTimeoutSeconds: 600, extra: { name: "USDC", version: "2" } },
    ],
  } as unknown as PaymentRequired;
}
function prV1(): PaymentRequired {
  return {
    x402Version: 1,
    accepts: [
      { scheme: "exact", network: NET_V1, maxAmountRequired: AMOUNT, resource: "http://resource.local/x", description: "test resource", asset: USDC, payTo: PAYEE, maxTimeoutSeconds: 600, extra: { name: "USDC", version: "2" } },
    ],
  } as unknown as PaymentRequired;
}

/** Drive the REAL @x402 client through a genuine 402 with our guard binding installed. Returns
 *  the propagated error (if any), which signing routes the inner signer saw, and the 402 status.
 *  With no `signerOverride` it uses the recording canary; pass a real signer (e.g. a viem
 *  LocalAccount) to prove the allowlist-wrapped signer still satisfies the real SDK. */
async function attempt(pr: PaymentRequired, guard: SpendGuard, signerOverride?: ClientEvmSigner) {
  const binding = createSpendGuardBinding(guard);
  const canary = makeCanary();
  const client = new x402Client();
  // registerExactEvmScheme wires BOTH generations (v2 eip155:* + v1 legacy names) onto our
  // wrapped signer — the guard now sits on the one signing route the scheme can use.
  registerExactEvmScheme(client, { signer: binding.wrapSigner(signerOverride ?? canary.signer) as never });
  client.onBeforePaymentCreation(binding.hook);
  const httpClient = new x402HTTPClient(client);
  const server = await startX402Server(pr);
  try {
    // Real HTTP round-trip through our transport wrap → the client-observed origin is captured.
    const wrapped = binding.wrapFetch(((input, init) => fetch(input as string, init as RequestInit)) as FetchLike<Response>);
    const res = await wrapped(server.url);
    const headerVal = res.headers.get("PAYMENT-REQUIRED");
    const body = headerVal ? undefined : await res.json();
    const paymentRequired = httpClient.getPaymentRequiredResponse((n) => res.headers.get(n), body);
    let error: Error | undefined;
    try {
      await client.createPaymentPayload(paymentRequired);
    } catch (e) {
      error = e as Error;
    }
    return { error, touched: canary.touched, status: res.status };
  } finally {
    await server.close();
  }
}

describe("deny-path e2e — the real @x402 client cannot route around the veto", () => {
  for (const [gen, pr] of [["v2", prV2()], ["v1", prV1()]] as const) {
    it(`${gen}: kill switch — halt denies before any signing route is reached`, async () => {
      const { error, touched, status } = await attempt(pr, guardWith(policyOf({ halt: true })));
      expect(status).toBe(402);
      expect(error).toBeDefined();
      expect(error!.message).toMatch(/\bhalt\b/);
      expect(touched).toEqual([]); // no signature was ever produced
    });

    it(`${gen}: allowlist — an off-allowlist payee denies, no signature produced`, async () => {
      const guard = guardWith(policyOf({ allowlist: [{ address: DECOY, chain: CHAIN }] }));
      const { error, touched } = await attempt(pr, guard);
      expect(error).toBeDefined();
      expect(error!.message).toMatch(/allowlist\.blocked/);
      expect(touched).toEqual([]);
    });

    it(`${gen}: per-request cap — an over-cap amount denies, no signature produced`, async () => {
      const guard = guardWith(policyOf({ caps: { [`${CHAIN}|${USDC}`]: { perRequest: "5000", perDomain: "5000000", global: "20000000" } } }));
      const { error, touched } = await attempt(pr, guard);
      expect(error).toBeDefined();
      expect(error!.message).toMatch(/cap\.per_request/);
      expect(touched).toEqual([]);
    });
  }

  it("origin VALUE flows end-to-end (v2): requireOriginMatch denies when the resource origin != the request host", async () => {
    // The other tests prove origin PRESENCE is load-bearing; this proves the origin VALUE the
    // transport wrap derived (127.0.0.1 — the real request host) actually reaches the policy and
    // drives a verdict. The challenge's resource origin ("resource.local") differs from the real
    // request host, so `requireOriginMatch` denies with `origin.mismatch`. Were the wrong origin
    // captured (e.g. the server-declared resource host), the check would MATCH and this would fail.
    const { error, touched } = await attempt(prV2(), guardWith(policyOf({ requireOriginMatch: true })));
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/origin\.mismatch/);
    expect(touched).toEqual([]);
  });

  it("allowlist did not over-restrict (v2): a real viem LocalAccount signs a genuine payment through the wrap", async () => {
    // The allowlist exposes only a curated surface — this proves it still SATISFIES the real SDK.
    // A real LocalAccount, wrapped, drives the real client all the way to a created payment payload
    // on ALLOW: the account produces a genuine signature and createPaymentPayload succeeds, so the
    // wrap dropped no method the exact scheme needs. Throwaway key, never funded; the payload is
    // created but never settled or transmitted. (Guards against the allowlist over-restricting.)
    const account = privateKeyToAccount(generatePrivateKey());
    const { error } = await attempt(prV2(), guardWith(policyOf({})), account as unknown as ClientEvmSigner);
    expect(error).toBeUndefined();
  });

  for (const [gen, mk] of [["v2", prV2], ["v1", prV1]] as const) {
    it(`Finding A in the wild (${gen}): on ALLOW the real client reaches a signature ONLY via signTypedData`, async () => {
      // Guard allows (default policy permits PAYEE + generous caps). The real ExactEvmScheme must
      // reach the signature through our guarded signTypedData and NO other route — if it tried a
      // closed route, our wrap would throw `adapter.unguarded_signing_route` instead.
      //
      // SCOPE (no overreach): this proves the real CLIENT *uses* only signTypedData against our
      // wrap. It does NOT prove the wrap blocks every route of a RICHER signer — the canary
      // exposes only the four known routes. Confirming a full viem LocalAccount (which has more
      // methods) has no un-blocked escape is the blocklist→allowlist hardening residual, which the
      // deferred funded-settle path (a real signer) will exercise. See docs/roadmap.md.
      const { touched, error } = await attempt(mk(), guardWith(policyOf({})));
      expect(touched).toEqual(["signTypedData"]); // exactly the one guarded route
      // Tighter than "not the bypass string": the guard ALLOWED, so any error (the dummy sig
      // fails downstream in payload construction) must not be ANY guard deny reason — this can't
      // accidentally pass on a *different* deny that merely lacks the `unguarded_signing_route` text.
      expect(error?.message ?? "").not.toMatch(/\bhalt\b|allowlist\.|cap\.|origin\.mismatch|unguarded_signing_route/);
    });
  }
});
