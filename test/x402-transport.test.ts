import { describe, it, expect } from "vitest";
import { guardedFetch, type FetchLike, type ResponseLike } from "../src/adapters/x402-transport.js";
import { PaymentFlowContext } from "../src/adapters/x402-guarded-signer.js";
import { challenge } from "./helpers.js";

const resp = (status: number, url: string): ResponseLike => ({ status, url });

describe("guardedFetch — captures the real client-observed origin (DOM-01)", () => {
  it("observes the origin from the client's 402 request", async () => {
    const ctx = new PaymentFlowContext();
    const inner: FetchLike = async () => resp(402, "https://weather.example/forecast");
    const res = await guardedFetch(ctx, inner)("https://weather.example/forecast");

    expect(res.status).toBe(402); // response passed through unchanged
    ctx.observeChallenge(challenge()); // complete the pair to read it back
    expect(ctx.consume().origin).toBe("weather.example");
  });

  it("domain-derivation-ignores-redirect", async () => {
    // The client called shop.example; the server answered the 402 from a rotating subdomain
    // (response.url = evil-cdn). The budget must key on the CLIENT-CHOSEN host — redirect-immune
    // — not the server-controlled response.url, or a payee could mint a fresh bucket each call.
    const ctx = new PaymentFlowContext();
    const inner: FetchLike = async () => resp(402, "https://sub7.evil-cdn.example/paid");
    await guardedFetch(ctx, inner)("https://shop.example/api");

    ctx.observeChallenge(challenge());
    expect(ctx.consume().origin).toBe("shop.example"); // NOT evil-cdn.example
  });

  it("reads the origin from a URL input (not just a string)", async () => {
    const ctx = new PaymentFlowContext();
    const inner: FetchLike = async () => resp(402, "https://weather.example/forecast");
    await guardedFetch(ctx, inner)(new URL("https://weather.example/forecast"));
    ctx.observeChallenge(challenge());
    expect(ctx.consume().origin).toBe("weather.example");
  });

  it("reads the origin from a Request-shaped input (what @x402/fetch hands the transport)", async () => {
    // The fetch API and high-level wrappers call the transport with a `Request` OBJECT, whose
    // String() is "[object Request]" — not the URL. Origin must be read from `.url`, or capture
    // silently breaks and every payment fails closed on context_incomplete. Regression guard for
    // the integration-fetch e2e (which caught this against the real wrapFetchWithPayment).
    const ctx = new PaymentFlowContext();
    const inner: FetchLike = async () => resp(402, "https://weather.example/forecast");
    await guardedFetch(ctx, inner)({ url: "https://weather.example/forecast" });
    ctx.observeChallenge(challenge());
    expect(ctx.consume().origin).toBe("weather.example");
  });

  it("does NOT observe an origin on a non-402 response", async () => {
    const ctx = new PaymentFlowContext();
    const inner: FetchLike = async () => resp(200, "https://x.example/y");
    await guardedFetch(ctx, inner)("https://x.example/y");

    ctx.observeChallenge(challenge());
    // origin never observed → context incomplete → fail-closed
    expect(() => ctx.consume()).toThrow();
  });

  it("does not observe when the origin can't be derived (fail-closed, not a bad guess)", async () => {
    const ctx = new PaymentFlowContext();
    const inner: FetchLike = async () => resp(402, "not a url");
    await guardedFetch(ctx, inner)("not a url");

    ctx.observeChallenge(challenge());
    expect(() => ctx.consume()).toThrow(); // no origin observed
  });
});
