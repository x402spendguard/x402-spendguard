import { describe, it, expect } from "vitest";
import {
  installSpendGuard,
  challengeCaptureHook,
  type BeforeHookClientLike,
} from "../src/adapters/x402-binding.js";
import { PaymentFlowContext, type ClientEvmSigner } from "../src/adapters/x402-guarded-signer.js";
import type { TypedData } from "../src/adapters/x402-wire.js";
import type { ResponseLike } from "../src/adapters/x402-transport.js";
import type { Authorizer } from "../src/audit/decision-log.js";
import type { PaymentEvaluation, PolicyDecision } from "../src/types.js";
// Compile-time drift guards against the REAL @x402/core client (devDep): if the SDK reshapes the
// hook or the client, these assignments stop type-checking. The atomic installer's whole promise
// rests on it OWNING the real client's registration surface, so we pin that surface here.
import type { BeforePaymentCreationHook, x402Client } from "@x402/core/client";
import { USDC, PAYEE, NOW } from "./helpers.js";

// A real x402Client must satisfy the structural client shape installSpendGuard accepts — otherwise
// the e2e wiring (and every real user) would fail to type-check. Type-only; erased at runtime.
const _clientIsAssignable = (c: x402Client): BeforeHookClientLike => c;
void _clientIsAssignable;

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

// The SAME valid fixtures the binding tests use (proven valid there). Fail-closed tests mutate
// exactly ONE piece of this — never hand-build a garbage struct that trips an earlier gate.
const validTd = (): TypedData => ({
  primaryType: "TransferWithAuthorization",
  domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC },
  message: { from: PAYER, to: PAYEE, value: 500_000n, validAfter: 0n, validBefore: NOW + 300n, nonce: "0xdead" },
});
const innerSigner = (): ClientEvmSigner => ({ address: PAYER, async signTypedData() { return "0xSIGNATURE"; } });
const offer = () => ({ scheme: "exact", network: "eip155:8453", amount: "500000", asset: USDC, payTo: PAYEE, maxTimeoutSeconds: 600, extra: { name: "USD Coin", version: "2" } });
const paymentRequired = () => ({ x402Version: 2, resource: { url: "https://weather.example/forecast" }, accepts: [offer()] });
const seesA402 = async (): Promise<ResponseLike> => ({ status: 402, url: "https://weather.example/forecast" });

/**
 * Wire the guard through the REAL installSpendGuard against a minimal stand-in for the x402 client's
 * registration surface. The install OWNS the hook (we only capture what it registered so a test can
 * fire it as the SDK would) and the scheme registration (we capture the signer it hands our
 * registerScheme bridge — that signer must be the GUARDED one, never the raw input).
 */
function install(guard: Authorizer, signer: ClientEvmSigner) {
  let registeredHook: ((ctx: unknown) => Promise<void | { abort: true; reason: string }>) | undefined;
  let registeredSigner: ClientEvmSigner | undefined;
  const client: BeforeHookClientLike = {
    onBeforePaymentCreation(hook) {
      registeredHook = hook as never;
      return client;
    },
  };
  const result = installSpendGuard(client, {
    guard,
    signer,
    registerScheme: (_c, guarded) => {
      registeredSigner = guarded;
    },
  });
  return {
    result,
    fireHook: (arg: unknown) => registeredHook!(arg),
    registeredSigner: () => registeredSigner!,
  };
}

describe("installSpendGuard — atomic wiring; the veto cannot be forgotten", () => {
  it("owns the hook + registers the GUARDED signer + threads a full correlated allow", async () => {
    const guard = new FakeGuard(ALLOW);
    const h = install(guard, innerSigner());

    // The transport wrap (the one remaining caller responsibility) sees the 402 → real origin captured.
    await h.result.wrapFetch(seesA402)("https://weather.example/forecast");
    // The hook install registered — NOT one the caller wired — captures the offer.
    await h.fireHook({ paymentRequired: paymentRequired(), selectedRequirements: offer() });
    // The signer registerScheme received is the GUARDED one: it runs the guard and, on allow, signs.
    const sig = await h.registeredSigner().signTypedData(validTd());

    expect(sig).toBe("0xSIGNATURE");
    expect(guard.seen).toHaveLength(1);
    // DOM-01: origin is the client-observed transport host, not the server-declared resource.
    expect(guard.seen[0].origin).toBe("weather.example");
    expect(guard.seen[0].challenge.payTo).toBe(PAYEE);
    expect(guard.seen[0].authorization.value).toBe(500_000n);
  });

  it("exposes ONLY wrapFetch — no free-floating wrapSigner to forget or mis-thread", () => {
    const h = install(new FakeGuard(ALLOW), innerSigner());
    // The whole point: the caller is never handed a signer wrapper they must remember to apply and
    // thread into registration. The only thing they get back is the fail-closed transport wrap.
    expect(Object.keys(h.result)).toEqual(["wrapFetch"]);
  });

  it("blocks the signature when the guard denies (the registered signer is really guarded)", async () => {
    const h = install(new FakeGuard(DENY), innerSigner());
    await h.result.wrapFetch(seesA402)("https://weather.example/forecast");
    await h.fireHook({ paymentRequired: paymentRequired(), selectedRequirements: offer() });
    await expect(h.registeredSigner().signTypedData(validTd())).rejects.toThrow(/allowlist\.blocked/);
  });

  // ── The owed FAIL-CLOSED execution proofs. Each mutates ONE piece of the known-valid allow flow
  //    so the resulting deny isolates exactly the gate under test — not an incidental earlier one. ──

  it("omit wrapFetch → the signer fails CLOSED (context_incomplete: no origin ever observed)", async () => {
    // Identical to the allow flow EXCEPT the transport wrap is never used, so observeOrigin never
    // fires. The guard WOULD allow, so a deny here can only be the missing-origin gate, not policy.
    const guard = new FakeGuard(ALLOW);
    const h = install(guard, innerSigner());
    await h.fireHook({ paymentRequired: paymentRequired(), selectedRequirements: offer() });
    await expect(h.registeredSigner().signTypedData(validTd())).rejects.toThrow(/context_incomplete/);
    expect(guard.seen).toHaveLength(0); // failed closed BEFORE the guard was ever consulted
  });

  it("the owned hook aborts on an unsupported offer → the signer fails CLOSED (no challenge observed)", async () => {
    // Origin IS observed; only the challenge is missing because the owned hook refused the offer.
    // Proves that when the install-owned hook aborts, the signer still cannot sign.
    const guard = new FakeGuard(ALLOW);
    const h = install(guard, innerSigner());
    await h.result.wrapFetch(seesA402)("https://weather.example/forecast");
    const abort = await h.fireHook({ paymentRequired: paymentRequired(), selectedRequirements: { ...offer(), scheme: "upto" } });
    expect(abort).toEqual({ abort: true, reason: "scheme.unsupported" });
    await expect(h.registeredSigner().signTypedData(validTd())).rejects.toThrow(/context_incomplete/);
    expect(guard.seen).toHaveLength(0);
  });

  it("the owned hook stays structurally compatible with @x402/core's BeforePaymentCreationHook", () => {
    // The hook installSpendGuard registers must remain assignable to the real @x402 hook type.
    const asReal: BeforePaymentCreationHook = challengeCaptureHook(new PaymentFlowContext());
    expect(typeof asReal).toBe("function");
  });

  it("installer-owns-the-veto-no-fail-open-wire", async () => {
    // WIRE-01: the public surface cannot EXPRESS a silent fail-open. Three facts together:
    //   (1) the installer registers a GUARDED signer, never the raw one the caller passed;
    //   (2) it returns ONLY the transport wrap — no free-floating signer-wrap to omit;
    //   (3) the barrel exposes no `createSpendGuardBinding` (the removed footgun that handed one out).
    const raw = innerSigner();
    let registered: ClientEvmSigner | undefined;
    const client: BeforeHookClientLike = { onBeforePaymentCreation: () => client };
    const result = installSpendGuard(client, {
      guard: new FakeGuard(ALLOW),
      signer: raw,
      registerScheme: (_c, guarded) => { registered = guarded; },
    });
    expect(registered).not.toBe(raw); // the guarded signer was registered, not the raw input
    expect(Object.keys(result)).toEqual(["wrapFetch"]); // nothing signer-shaped handed back to forget

    const api = await import("../src/index.js");
    expect(api).not.toHaveProperty("createSpendGuardBinding"); // the fail-open footgun is gone
    expect(api).toHaveProperty("installSpendGuard"); // the atomic replacement is the blessed path
  });
});
