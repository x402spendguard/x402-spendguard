import { describe, it, expect } from "vitest";
import { guardedFetch, type FetchLike, type ResponseLike } from "../src/adapters/x402-transport.js";
import { PaymentFlowContext } from "../src/adapters/x402-guarded-signer.js";
import { challenge } from "./helpers.js";

const resp = (status: number, url: string): ResponseLike => ({ status, url });

describe("guardedFetch — captures the real client-observed origin (DOM-01)", () => {
  it("observes the origin from a 402 response's URL", async () => {
    const ctx = new PaymentFlowContext();
    const inner: FetchLike = async () => resp(402, "https://weather.example/forecast");
    const res = await guardedFetch(ctx, inner)("https://weather.example/forecast");

    expect(res.status).toBe(402); // response passed through unchanged
    ctx.observeChallenge(challenge()); // complete the pair to read it back
    expect(ctx.consume().origin).toBe("weather.example");
  });

  it("uses the URL that RECEIVED the 402 after redirects (response.url), not the request input", async () => {
    const ctx = new PaymentFlowContext();
    // Request started at start.example but was redirected; the 402 came from final.example.
    const inner: FetchLike = async () => resp(402, "https://final.example/paid");
    await guardedFetch(ctx, inner)("https://start.example/x");

    ctx.observeChallenge(challenge());
    expect(ctx.consume().origin).toBe("final.example");
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
