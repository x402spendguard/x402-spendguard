// INTEGRATION E2E — the guard, wired via installSpendGuard, must veto through the REAL @x402/fetch
// high-level wrapper (`wrapFetchWithPayment`), the paid-fetch an agent developer actually uses.
//
// Why this exists beyond deny-path.e2e: that harness drives @x402/core directly with a STRING url.
// A developer uses @x402/fetch, which builds `new Request(input)` and hands the inner fetch a
// Request OBJECT — a different input shape than our unit/e2e tests ever exercised. This test proves
// the composition `wrapFetchWithPayment(ourWrapFetch(fetch), client)` actually carries the veto:
// our origin-capture is the INNER fetch (sees the 402 first, before payment creation), and the
// guard's REAL policy decision surfaces through the wrapper — not an incidental fail-closed reason.
//
// Hermetic: localhost only, no key, no funds. Runs opt-in via `npm run test:e2e`. Lives under
// test/e2e/ so the static no-egress proof over src/ is untouched.
import { describe, it, expect } from "vitest";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import type { PaymentRequired } from "@x402/core/types";
import { installSpendGuard } from "../../src/adapters/x402-binding.js";
import { SpendGuard, emptyState, type SpendStore, type Version } from "../../src/accounting/guard.js";
import { systemClock } from "../../src/adapters/system-clock.js";
import { parsePolicy } from "../../src/parse.js";
import type { ClientEvmSigner } from "../../src/adapters/x402-guarded-signer.js";
import type { FetchLike } from "../../src/adapters/x402-transport.js";
import type { Policy } from "../../src/types.js";
import { startX402Server } from "./x402-local-server.js";

const CHAIN = "eip155:84532";
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const PAYEE = "0x1111111111111111111111111111111111111111";
const DECOY = "0x9999999999999999999999999999999999999999";
const AMOUNT = "10000"; // 0.01 USDC

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

function guardWith(policy: Policy): SpendGuard {
  let state = emptyState(systemClock.now());
  let version = 0;
  const store: SpendStore = {
    async load() { return { state, version: String(version) as Version }; },
    async compareAndSave(expected, next) { if (String(version) !== expected) return false; version++; state = next; return true; },
    async verifyAtomicity() {},
  };
  return new SpendGuard(store, systemClock, policy);
}

/** A canary signer: records which route was reached, never produces a real signature. On DENY our
 *  wrap throws before it is reached (touched stays empty); on ALLOW signTypedData is the one route. */
function makeCanary() {
  const touched: string[] = [];
  const dummySig = ("0x" + "11".repeat(65)) as `0x${string}`;
  const route = (name: string) => async (): Promise<`0x${string}`> => { touched.push(name); return dummySig; };
  const signer: ClientEvmSigner & Record<string, unknown> = {
    address: "0x2222222222222222222222222222222222222222" as `0x${string}`,
    signTypedData: route("signTypedData"),
    sign: route("sign"),
    signMessage: route("signMessage"),
    signTransaction: route("signTransaction"),
  };
  return { signer, touched };
}

function prV2(): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: "http://resource.local/x" }, // server-declared; the client-chosen host is 127.0.0.1
    accepts: [
      { scheme: "exact", network: CHAIN, asset: USDC, amount: AMOUNT, payTo: PAYEE, maxTimeoutSeconds: 600, extra: { name: "USDC", version: "2" } },
    ],
  } as unknown as PaymentRequired;
}

/** Drive a genuine 402 through the REAL @x402/fetch `wrapFetchWithPayment`, with our guard installed
 *  and our origin-capture as the INNER fetch. Returns the propagated error + which routes were reached. */
async function payThroughFetch(guard: SpendGuard) {
  const canary = makeCanary();
  const client = new x402Client();
  const inst = installSpendGuard(client, {
    guard,
    signer: canary.signer,
    registerScheme: (c, signer) => registerExactEvmScheme(c, { signer: signer as never }),
  });
  const server = await startX402Server(prV2());
  try {
    const rawFetch = ((input, init) => fetch(input as string, init as RequestInit)) as FetchLike<Response>;
    // THE COMPOSITION: our origin-capturing transport is the inner fetch @x402/fetch drives.
    // No cast — the widened FetchLike (string | URL | Request) is assignable to `typeof fetch`.
    const payFetch = wrapFetchWithPayment(inst.wrapFetch(rawFetch), client);
    let error: Error | undefined;
    try {
      await payFetch(server.url);
    } catch (e) {
      error = e as Error;
    }
    return { error, touched: canary.touched };
  } finally {
    await server.close();
  }
}

describe("integration e2e — the veto fires through the REAL @x402/fetch wrapFetchWithPayment", () => {
  it("ALLOW: the full flow composes — origin captured, guard consulted, signer reached", async () => {
    // Proves the composition works end-to-end through the wrapper. If origin capture broke (Request
    // input), the guard would fail closed with context_incomplete and the signer would NEVER be
    // reached — so touched === ["signTypedData"] is the assertion that the origin actually flowed.
    const { touched, error } = await payThroughFetch(guardWith(policyOf({})));
    expect(touched).toEqual(["signTypedData"]);
    // The guard ALLOWED; any downstream error (the dummy sig failing later) must be no guard-deny reason.
    expect(error?.message ?? "").not.toMatch(/\bhalt\b|allowlist\.|cap\.|origin\.mismatch|context_incomplete|unguarded/);
  });

  it("DENY (halt): the REAL policy veto surfaces through the wrapper — not context_incomplete", async () => {
    // halt needs the origin PRESENT to pass consume() before the guard is reached — so if this
    // reports `halt` (not `context_incomplete`), origin capture through @x402/fetch genuinely worked.
    const { error, touched } = await payThroughFetch(guardWith(policyOf({ halt: true })));
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/\bhalt\b/);
    expect(touched).toEqual([]); // no signature ever produced
  });

  it("DENY (allowlist): an off-allowlist payee is vetoed through the wrapper", async () => {
    const { error, touched } = await payThroughFetch(guardWith(policyOf({ allowlist: [{ address: DECOY, chain: CHAIN }] })));
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/allowlist\.blocked/);
    expect(touched).toEqual([]);
  });

  it("DENY (requireOriginMatch): the CORRECT origin value (request host, not server resource) flows through", async () => {
    // The challenge's resource host is "resource.local"; the real request host is 127.0.0.1. With
    // requireOriginMatch on, the guard denies with origin.mismatch — which can only happen if the
    // origin captured from the Request was 127.0.0.1 (the client-chosen host), proving DOM-01 holds
    // through @x402/fetch. Were the wrong origin captured, this would MATCH and fail to deny.
    const { error, touched } = await payThroughFetch(guardWith(policyOf({ requireOriginMatch: true })));
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/origin\.mismatch/);
    expect(touched).toEqual([]);
  });
});
