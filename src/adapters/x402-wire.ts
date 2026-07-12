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
//
// v1 (deprecated but deployed), verified @ 2.18.0: the SAME `@x402/core` client speaks v1
// through the SAME signer wrap and the SAME `onBeforePaymentCreation` hook — only the offer
// SHAPE differs. `maxAmountRequired` (v2 renamed it `amount`), `resource` sits ON the offer
// (v1 does not hoist it), and `network` is a LOOSE NAME ("base-sepolia") we must map to CAIP-2
// via the authoritative `@x402/evm` table. An unknown name fails closed (see `challengeFromV1`).

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

/** The 402 body as seen at the payment hook. `x402Version` is the authoritative generation
 *  discriminator (`1 | 2`); v2 hoists the resource here (`resource.url`), v1 does not. */
export interface V2PaymentRequired {
  x402Version?: unknown;
  resource?: { url?: unknown } | null;
}

/** The fields of a v1 PaymentRequirements (the selected offer) the guard reads. As with
 *  `V2Offer` these are `unknown` on purpose — untrusted server data validated by `parseChallenge`.
 *  Differs from v2: `maxAmountRequired` (not `amount`), a loose `network` name, and `resource`
 *  carried on the offer itself. */
export interface V1Offer {
  scheme?: unknown;
  network?: unknown;
  maxAmountRequired?: unknown;
  asset?: unknown;
  payTo?: unknown;
  maxTimeoutSeconds?: unknown;
  resource?: unknown;
  extra?: unknown;
}

/**
 * Authoritative v1 legacy network-name → EVM chain id, mirrored verbatim from
 * `@x402/evm`'s `EVM_NETWORK_CHAIN_ID_MAP` (2.18.0; `getEvmChainIdV1` throws on unknown). This
 * is a PROTOCOL FACT, not policy — a fixed lookup table the ecosystem defines, not a threshold
 * the guard chooses. An unknown name has no safe default: without a chain id we cannot key caps
 * or the allowlist, nor cross-check the signed struct's `chainId`, so `challengeFromV1` denies.
 * Null-prototype + `Object.hasOwn` so a `network` of "toString"/"constructor" cannot resolve.
 */
const V1_NETWORK_CHAIN_ID: Record<string, number> = Object.assign(Object.create(null), {
  ethereum: 1,
  sepolia: 11155111,
  abstract: 2741,
  "abstract-testnet": 11124,
  "base-sepolia": 84532,
  base: 8453,
  "avalanche-fuji": 43113,
  avalanche: 43114,
  iotex: 4689,
  sei: 1329,
  "sei-testnet": 1328,
  polygon: 137,
  "polygon-amoy": 80002,
  peaq: 3338,
  story: 1514,
  educhain: 41923,
  "skale-base-sepolia": 324705682,
  megaeth: 4326,
  monad: 143,
  stable: 988,
  "stable-testnet": 2201,
});

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

/**
 * Map a v1 selected offer to a branded `Challenge`. Two things differ from v2: the loose
 * `network` NAME is resolved to CAIP-2 via the authoritative table (unknown ⇒ fail closed,
 * `wire.unknown_v1_network`), and the amount comes from `maxAmountRequired`, the resource
 * from the offer itself. Everything else flows through the same `parseChallenge` boundary
 * (which already accepts `maxAmountRequired`), so the v1 and v2 paths converge on one parser.
 */
export function challengeFromV1(offer: V1Offer): Result<Challenge> {
  const name = offer.network;
  if (typeof name !== "string" || !Object.hasOwn(V1_NETWORK_CHAIN_ID, name)) {
    return {
      ok: false,
      reason: "wire.unknown_v1_network",
      detail: `v1 network "${String(name)}" is not a known EVM network (no CAIP-2 mapping; cannot key caps or cross-check the signed chainId).`,
    };
  }
  return parseChallenge({
    scheme: offer.scheme,
    network: `eip155:${V1_NETWORK_CHAIN_ID[name]}`,
    asset: offer.asset,
    payTo: offer.payTo,
    maxAmountRequired: offer.maxAmountRequired,
    maxTimeoutSeconds: intToDecimalString(offer.maxTimeoutSeconds),
    resource: typeof offer.resource === "string" ? offer.resource : "",
  });
}
