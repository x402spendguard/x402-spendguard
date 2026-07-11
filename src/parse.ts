// The boundary. Untrusted input is turned into trustworthy branded types HERE,
// exactly once — "parse, don't validate." Everything downstream trusts its types.
//
// Every failure returns a SPECIFIC, stable reason code (PARSE-01) — malformed
// input is *expected*, not a bug, so it must never reach the engine's generic
// error backstop. The engine never sees raw input; it only sees parsed types.

import type {
  Address,
  AllowlistEntry,
  Amount,
  AssetId,
  AssetKey,
  Caps,
  ChainId,
  Challenge,
  Authorization,
  Domain,
  OpaqueHex,
  Policy,
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

/**
 * Canonical budget domain from the client-observed request origin. Accepts a bare host or a
 * full URL and reduces both to the lowercased hostname — no scheme, port, path, or trailing
 * dot — so "shop.example", "shop.example:443", "shop.example.", and "https://shop.example/x"
 * all key the SAME budget bucket. Without this, per-domain spend splits across representations
 * and the per-domain cap is only backstopped by the global cap.
 */
export function makeDomain(raw: unknown): Result<Domain> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return err("parse.domain_malformed", `Domain "${String(raw)}" is empty.`);
  }
  const s = raw.trim();
  let host: string;
  try {
    host = new URL(s.includes("://") ? s : `x://${s}`).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return err("parse.domain_malformed", `Domain "${String(raw)}" is not a valid host.`);
  }
  if (host.length === 0) return err("parse.domain_malformed", `Domain "${String(raw)}" has no host.`);
  return ok(host as Domain);
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
  // ADAPTER CONTRACT: the adapter must tag `form` explicitly. We default a MISSING tag to
  // eip3009-evm for EVM inputs, but a present-and-unrecognized form (e.g. "svm-tx") denies
  // with the clean `chain.unsupported` reason. (An untagged Solana payload still fails
  // closed — its non-0x addresses reject at makeAddress — just with a less specific reason;
  // tagging form removes that ambiguity. See OBS-01.)
  const form = raw?.form ?? "eip3009-evm";
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

/**
 * Parse a raw (already JSON-decoded) policy into a trustworthy `Policy`. This is the
 * config trust boundary: user-authored file contents become branded types exactly once.
 *
 * Fail-closed and opinion-free:
 *  - EVERY field is required. There are NO code-side defaults — a default threshold baked
 *    in here would be the guard deciding policy (POL-01). Defaults live in a shipped policy
 *    file the user can read, never as a constant in this function.
 *  - Money is re-parsed through `makeAmount` (rejects floats/signs/junk) and times through
 *    `makeUnixSeconds`, so the interior can trust every value is a non-negative integer.
 *  - Each cap key is re-derived from its `(chain, token)` and re-canonicalized via `assetKey`,
 *    so a token address written in mixed case still resolves to the coordinate the engine
 *    looks up — a silently-never-matching cap would fail OPEN toward the global cap.
 *  - The caps map is null-prototype: an own "__proto__" key (as JSON.parse can produce) is an
 *    ordinary — and here, rejected — coordinate, never a path to prototype pollution.
 */
export function parsePolicy(raw: unknown): Result<Policy> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return err("config.not_an_object", "Policy must be a JSON object.");
  }
  const o = raw as Record<string, unknown>;

  if (typeof o.halt !== "boolean") {
    return err("config.halt_invalid", "Policy.halt must be a boolean.");
  }
  if (typeof o.requireOriginMatch !== "boolean") {
    return err("config.require_origin_match_invalid", "Policy.requireOriginMatch must be a boolean.");
  }

  if (!Array.isArray(o.allowlist)) {
    return err("config.allowlist_invalid", "Policy.allowlist must be an array.");
  }
  const allowlist: AllowlistEntry[] = [];
  for (const entry of o.allowlist) {
    if (typeof entry !== "object" || entry === null) {
      return err("config.allowlist_invalid", "Each allowlist entry must be an object with address and chain.");
    }
    const e = entry as Record<string, unknown>;
    const address = makeAddress(e.address);
    if (!address.ok) return address;
    const chain = makeChainId(e.chain);
    if (!chain.ok) return chain;
    allowlist.push({ address: address.value, chain: chain.value });
  }

  if (typeof o.caps !== "object" || o.caps === null || Array.isArray(o.caps)) {
    return err("config.caps_invalid", "Policy.caps must be an object.");
  }
  const caps = Object.create(null) as Record<AssetKey, Caps>;
  for (const [rawKey, rawCaps] of Object.entries(o.caps as Record<string, unknown>)) {
    const sep = rawKey.indexOf("|");
    if (sep <= 0 || sep === rawKey.length - 1) {
      return err("config.cap_key_malformed", `Cap key "${rawKey}" is not a "chain|token" coordinate.`);
    }
    const chain = makeChainId(rawKey.slice(0, sep));
    if (!chain.ok) return err("config.cap_key_malformed", `Cap key "${rawKey}" has a malformed chain.`);
    const token = makeAddress(rawKey.slice(sep + 1));
    if (!token.ok) return err("config.cap_key_malformed", `Cap key "${rawKey}" has a malformed token address.`);
    const key = assetKey({ chain: chain.value, token: token.value });

    if (typeof rawCaps !== "object" || rawCaps === null) {
      return err("config.caps_invalid", `Caps for "${key}" must be an object with perRequest, perDomain, global.`);
    }
    const c = rawCaps as Record<string, unknown>;
    const perRequest = makeAmount(c.perRequest);
    if (!perRequest.ok) return perRequest;
    const perDomain = makeAmount(c.perDomain);
    if (!perDomain.ok) return perDomain;
    const global = makeAmount(c.global);
    if (!global.ok) return global;
    caps[key] = { perRequest: perRequest.value, perDomain: perDomain.value, global: global.value };
  }

  const clockSkewSeconds = makeUnixSeconds(o.clockSkewSeconds);
  if (!clockSkewSeconds.ok) return clockSkewSeconds;
  const maxAuthLifetimeSeconds = makeUnixSeconds(o.maxAuthLifetimeSeconds);
  if (!maxAuthLifetimeSeconds.ok) return maxAuthLifetimeSeconds;
  const windowSeconds = makeUnixSeconds(o.windowSeconds);
  if (!windowSeconds.ok) return windowSeconds;

  return ok({
    halt: o.halt,
    allowlist,
    caps,
    clockSkewSeconds: clockSkewSeconds.value,
    maxAuthLifetimeSeconds: maxAuthLifetimeSeconds.value,
    windowSeconds: windowSeconds.value,
    requireOriginMatch: o.requireOriginMatch,
  });
}
