// Wire adapter: turn the x402 SDK's on-the-wire shapes into the raw records our parse
// boundary brands. This is the PRE-parse edge — it knows the protocol's field layout
// (which differs across v1/v2 and across interposition points); `parse.ts` then turns the
// normalized record into a trustworthy branded type. Kept pure: no I/O, no SDK imports,
// just shape mapping, so it is exhaustively testable against fixtures.
//
// v2, verified @ @x402/core 2.18.0 (2026-07-11):
//  - The signed struct reaches us at the SIGNER-WRAP as EIP-712 typed data
//    `{domain, types, primaryType, message}` — never a base64 header. `chainId` and
//    `verifyingContract` live in the DOMAIN (not the message), so we read them there.
//  - The v2 offer (PaymentRequirements) carries no `resource`; it is hoisted to the 402
//    body's top-level `resource: {url}`. We take the resource from the body ONLY.

import { parseAuthorization, parseChallenge } from "../parse.js";
import type { Result } from "../parse.js";
import type { Authorization, Challenge } from "../types.js";

/** The EIP-712 typed-data object a wrapped `signTypedData` receives. */
export interface TypedData {
  primaryType: string;
  domain?: Record<string, unknown>;
  types?: Record<string, unknown>;
  message?: Record<string, unknown>;
}

/** The fields of a v2 PaymentRequirements (the selected offer) the guard reads. Values are
 *  `unknown` on purpose — this is untrusted server data; `parseChallenge` validates/brands it. */
export interface V2Offer {
  scheme?: unknown;
  network?: unknown;
  amount?: unknown;
  asset?: unknown;
  payTo?: unknown;
  maxTimeoutSeconds?: unknown;
  extra?: unknown;
}

/** The v2 402 body, of which the guard needs the top-level resource info. */
export interface V2PaymentRequired {
  resource?: { url?: unknown } | null;
}

/**
 * SDK objects use JS `number` for small integers (e.g. `maxTimeoutSeconds`, EIP-712
 * `chainId`), but our parse primitives take bigint/decimal-string and deliberately REJECT
 * numbers — so the config path can't silently lose precision above 2^53. Normalize only a
 * SAFE INTEGER to its decimal string here at the wire edge; a float or anything else passes
 * through unchanged and the parser rejects it (fail-closed).
 */
function intToDecimalString(x: unknown): unknown {
  return typeof x === "number" && Number.isSafeInteger(x) ? String(x) : x;
}

/**
 * Map the signer-wrap's EIP-712 typed data to a branded `Authorization`. The `primaryType`
 * IS the scheme discriminator: only EIP-3009 `TransferWithAuthorization` is EVM-exact (v1
 * scope). A Permit2 witness ("PermitWitnessTransferFrom") or any other type is refused here.
 */
export function authorizationFromTypedData(td: TypedData): Result<Authorization> {
  if (td.primaryType !== "TransferWithAuthorization") {
    return {
      ok: false,
      reason: "wire.unsupported_typed_data",
      detail: `primaryType "${td.primaryType}" is not EIP-3009 TransferWithAuthorization (v1 supports EVM exact only).`,
    };
  }
  const domain = td.domain ?? {};
  const message = td.message ?? {};
  // EIP-712 domain chainId is an EVM numeric chain id → CAIP-2. A safe-integer or bigint
  // becomes "eip155:<n>"; anything else is passed through for makeChainId to reject.
  const cid = domain.chainId;
  const chainId =
    typeof cid === "number" && Number.isSafeInteger(cid)
      ? `eip155:${cid}`
      : typeof cid === "bigint"
        ? `eip155:${cid.toString()}`
        : cid;
  return parseAuthorization({
    form: "eip3009-evm",
    chainId,
    verifyingContract: domain.verifyingContract,
    from: message.from,
    to: message.to,
    value: message.value,
    validAfter: message.validAfter,
    validBefore: message.validBefore,
    nonce: message.nonce,
  });
}

/**
 * Map a v2 selected offer + the 402 body to a branded `Challenge`. The resource is taken
 * from the BODY's top-level `resource.url` (v2 hoisted it there); a `resource` on the offer
 * is ignored. Note the resource here is still server-declared — DOM-01's real origin comes
 * from the transport wrapper, not from this field (see the ground-truth notes).
 */
export function challengeFromV2(paymentRequired: V2PaymentRequired, offer: V2Offer): Result<Challenge> {
  const url = paymentRequired?.resource?.url;
  return parseChallenge({
    scheme: offer.scheme,
    network: offer.network,
    asset: offer.asset,
    payTo: offer.payTo,
    amount: offer.amount,
    maxTimeoutSeconds: intToDecimalString(offer.maxTimeoutSeconds),
    resource: typeof url === "string" ? url : "",
  });
}
