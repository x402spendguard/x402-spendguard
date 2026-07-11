// Transport capture: the ONLY place the real client-observed request origin is visible.
// The x402 payment hook's resource URL is server-declared (the payee's self-report), which
// DOM-01 forbids as a budget key. So we wrap the fetch transport the x402 client uses and,
// when a response is a 402, record the host of the URL that ACTUALLY returned it — after
// redirects (`response.url` is the final URL). That host becomes the budget domain.
//
// Pure and dependency-free: it decorates an injected fetch-like function and reads only
// `status` and `url` off the response, so it needs no DOM lib types and no @x402 import.
import { makeDomain } from "../parse.js";
import type { PaymentFlowContext } from "./x402-guarded-signer.js";

/** The part of a fetch Response the origin capture reads. */
export interface ResponseLike {
  readonly status: number;
  readonly url: string;
}

/** A fetch-like transport, structural so the guard needs no DOM lib types. A real `fetch` is
 *  assignable to it. */
export type FetchLike<Res extends ResponseLike = ResponseLike> = (input: string | URL, init?: unknown) => Promise<Res>;

/**
 * Wrap a transport so the guard learns the real origin. On a 402, observe the host of the
 * response URL (post-redirect) into the flow context. If no origin can be derived, observe
 * nothing — the context stays incomplete and the signer fails closed, rather than attributing
 * spend to a guessed domain. Every response is passed through unchanged.
 */
export function guardedFetch<Res extends ResponseLike>(
  context: PaymentFlowContext,
  innerFetch: FetchLike<Res>,
): FetchLike<Res> {
  return async (input, init) => {
    const response = await innerFetch(input, init);
    if (response.status === 402) {
      const source = response.url && response.url.length > 0 ? response.url : String(input);
      const origin = makeDomain(source);
      if (origin.ok) context.observeOrigin(origin.value);
    }
    return response;
  };
}
