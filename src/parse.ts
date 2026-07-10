// The boundary. Untrusted input is turned into trustworthy branded types HERE,
// exactly once — "parse, don't validate." Everything downstream trusts its types.
//
// Every failure returns a SPECIFIC, stable reason code (PARSE-01) — malformed
// input is *expected*, not a bug, so it must never reach the engine's generic
// error backstop. The engine never sees raw input; it only sees parsed types.

import type {
  Address,
  Amount,
  AssetId,
  AssetKey,
  ChainId,
  Challenge,
  Authorization,
  Domain,
  OpaqueHex,
  UnixSeconds,
} from "./types.js";

/** A parse result: either a trustworthy value, or a specific, stable failure. */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; detail: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T>(reason: string, detail: string): Result<T> => ({ ok: false, reason, detail });

// ── Primitives ───────────────────────────────────────────────────────────────

/** Non-negative integer, from a decimal string or a bigint. Rejects floats, signs, junk. */
export function makeAmount(raw: unknown): Result<Amount> {
  let v: bigint;
  if (typeof raw === "bigint") {
    v = raw;
  } else if (typeof raw === "string") {
    // Decimal integer only. No "0x", no ".", no "e", no "-", no whitespace.
    if (!/^[0-9]+$/.test(raw)) {
      return err("parse.amount_malformed", `Amount "${raw}" is not a non-negative integer.`);
    }
    v = BigInt(raw);
  } else {
    return err("parse.amount_malformed", `Amount must be a bigint or decimal string, got ${typeof raw}.`);
  }
  if (v < 0n) return err("parse.amount_negative", `Amount ${v} is negative.`);
  return ok(v as Amount);
}

/** Non-negative Unix seconds. bigint or decimal string; never a float/number. */
export function makeUnixSeconds(raw: unknown): Result<UnixSeconds> {
  let v: bigint;
  if (typeof raw === "bigint") {
    v = raw;
  } else if (typeof raw === "string" && /^[0-9]+$/.test(raw)) {
    v = BigInt(raw);
  } else {
    return err("parse.time_malformed", `Timestamp "${String(raw)}" is not a non-negative integer.`);
  }
  if (v < 0n) return err("parse.time_negative", `Timestamp ${v} is negative.`);
  return ok(v as UnixSeconds);
}

/** Normalized EVM address: "0x" + 40 hex, lowercased. */
export function makeAddress(raw: unknown): Result<Address> {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    return err("parse.address_malformed", `Address "${String(raw)}" is not a 20-byte 0x address.`);
  }
  return ok(raw.toLowerCase() as Address);
}

/** CAIP-2 chain id, e.g. "eip155:8453". Lowercased namespace; reference kept verbatim. */
export function makeChainId(raw: unknown): Result<ChainId> {
  if (typeof raw !== "string" || !/^[a-zA-Z0-9-]+:[a-zA-Z0-9]+$/.test(raw)) {
    return err("parse.chain_malformed", `Chain id "${String(raw)}" is not CAIP-2 (namespace:reference).`);
  }
  const [ns, ref] = raw.split(":");
  return ok(`${ns.toLowerCase()}:${ref}` as ChainId);
}

/** Canonical budget domain from the client-observed request origin (host, lowercased). */
export function makeDomain(raw: unknown): Result<Domain> {
  if (typeof raw !== "string" || raw.length === 0) {
    return err("parse.domain_malformed", `Domain "${String(raw)}" is empty.`);
  }
  return ok(raw.trim().toLowerCase() as Domain);
}

/** Opaque hex (e.g. the nonce). Shape-checked only; never interpreted in v1. */
export function makeOpaqueHex(raw: unknown): Result<OpaqueHex> {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]*$/.test(raw)) {
    return err("parse.hex_malformed", `Value "${String(raw)}" is not 0x-hex.`);
  }
  return ok(raw.toLowerCase() as OpaqueHex);
}

// ── Denomination ─────────────────────────────────────────────────────────────

/** The coordinate money is bucketed by. EVM chains are case-insensitive on the token address. */
export function assetKey(id: AssetId): AssetKey {
  return `${id.chain}|${id.token}` as AssetKey;
}

// ── Composite parsers ────────────────────────────────────────────────────────

/** Parse a raw x402 402-challenge. v1: only the `exact` scheme (BIND-05). */
export function parseChallenge(raw: Record<string, unknown>): Result<Challenge> {
  if (raw?.scheme !== "exact") {
    return err("scheme.unsupported", `Scheme "${String(raw?.scheme)}" is not supported in v1 (exact only).`);
  }
  const network = makeChainId(raw.network);
  if (!network.ok) return network;
  const asset = makeAddress(raw.asset);
  if (!asset.ok) return asset;
  const payTo = makeAddress(raw.payTo);
  if (!payTo.ok) return payTo;
  const amount = makeAmount(raw.amount ?? raw.maxAmountRequired);
  if (!amount.ok) return amount;
  const maxTimeoutSeconds = makeUnixSeconds(raw.maxTimeoutSeconds);
  if (!maxTimeoutSeconds.ok) return maxTimeoutSeconds;
  const resource = typeof raw.resource === "string" ? raw.resource : "";
  return ok({
    scheme: "exact",
    network: network.value,
    asset: asset.value,
    payTo: payTo.value,
    amount: amount.value,
    maxTimeoutSeconds: maxTimeoutSeconds.value,
    resource,
  });
}

/**
 * Parse a raw authorization into a tagged Authorization. v1 accepts exactly one
 * form — EIP-3009 on EVM. Anything else (e.g. a Solana transaction) is denied
 * HERE (SCOPE-01): the tagged union IS the EVM-only gate.
 */
export function parseAuthorization(raw: Record<string, unknown>): Result<Authorization> {
  const form = raw?.form ?? "eip3009-evm"; // default form for EVM inputs
  if (form !== "eip3009-evm") {
    return err("chain.unsupported", `Authorization form "${String(form)}" is not supported in v1 (EVM only).`);
  }
  const chainId = makeChainId(raw.chainId);
  if (!chainId.ok) return chainId;
  const verifyingContract = makeAddress(raw.verifyingContract);
  if (!verifyingContract.ok) return verifyingContract;
  const from = makeAddress(raw.from);
  if (!from.ok) return from;
  const to = makeAddress(raw.to);
  if (!to.ok) return to;
  const value = makeAmount(raw.value);
  if (!value.ok) return value;
  const validAfter = makeUnixSeconds(raw.validAfter);
  if (!validAfter.ok) return validAfter;
  const validBefore = makeUnixSeconds(raw.validBefore);
  if (!validBefore.ok) return validBefore;
  const nonce = makeOpaqueHex(raw.nonce);
  if (!nonce.ok) return nonce;
  return ok({
    form: "eip3009-evm",
    chainId: chainId.value,
    verifyingContract: verifyingContract.value,
    from: from.value,
    to: to.value,
    value: value.value,
    validAfter: validAfter.value,
    validBefore: validBefore.value,
    nonce: nonce.value,
  });
}
