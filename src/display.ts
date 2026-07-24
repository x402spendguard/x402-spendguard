// Display metadata + the policy ECHO — the fat-finger control for the config on-ramp.
//
// A base-unit cap like "50000000" is unreadable; a human can't tell it from "5000000" at a glance,
// and that off-by-a-zero is the ONE authoring error that fails OPEN relative to intent (the guard
// faithfully enforces the wrong, larger ceiling). The mitigation is to render every cap back in human
// units so the mistake is visible: "50.000000 USDC — is that what you meant?". That is `describePolicy`.
//
// THREE hard rules, all on the safe side of the mechanism-not-policy razor:
//  1. RENDER FROM DECLARED DATA ONLY. The decimals come from the USER's own `display` declaration —
//     never a shipped token registry (a registry is curation + staleness, and a wrong entry would
//     render a confident LIE about money; a check that can lie is worse than no check) and never a
//     network lookup (that is the egress this tool refuses to add).
//  2. DEGRADE TO TRUTH, NEVER TO A LIE. No declared decimals ⇒ show raw (digit-grouped) base units and
//     SAY SO — never guess a rendering. Fail to silence, never to a confident wrong number.
//  3. DISPLAY-ONLY, STRUCTURALLY. `display` lives OUTSIDE `Policy` (parsePolicy ignores it; the
//     enforcement types never carry it), so decimals/symbol CANNOT affect a decision by construction.
//     A wrong or misleading symbol changes nothing but the label (DISP-01, proven by test).
//
// This module RENDERS base-units → human (safe: exact integer-string math, no float). It does NOT
// accept human decimal-string INPUT ("5.00" → base units); that would put security-critical money
// math in the tool and make `decimals` enforcement-load-bearing — a separate, converge-first slice.

import type { Policy, AssetKey, Address, ChainId } from "./types.js";
import type { ConfigReason } from "./reasons.js";
import { makeChainId, makeAddress, assetKey } from "./parse.js";
import type { Result } from "./parse.js";

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
// `reason` carried as a variable (never a raw literal) + typed to the CONFIG partition (reasons.ts).
const err = <T>(reason: ConfigReason, detail: string): Result<T> => ({ ok: false, reason, detail });

/** Upper bound on token decimals. Real tokens top out near 18 (ether-scale); 36 is a generous
 *  ceiling that still rejects absurd input. Both `renderAmount` and `parseDisplay` enforce it, so a
 *  huge/garbage `decimals` can neither be authored nor rendered. */
const MAX_DECIMALS = 36;

/** Display metadata for one denomination — a USER declaration, never enforced on. `decimals` is the
 *  token's base-unit exponent (6 for USDC, 18 for ether-scale); `symbol` is a display-only label. */
export interface DisplayInfo {
  decimals: number;
  symbol?: string;
}

/** Optional per-denomination display metadata, keyed by the same `chain|token` AssetKey as caps. */
export type Display = Record<AssetKey, DisplayInfo>;

/**
 * Parse the OPTIONAL top-level `display` section of a policy file. Absent ⇒ an empty `Display`.
 * Never affects `parsePolicy` (which ignores it) — display is a separate, non-enforcing concern.
 * Fail-closed on a malformed section, same as the policy parse: a specific reason, never a silent skip.
 */
export function parseDisplay(raw: unknown): Result<Display> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return err("config.display_invalid", "Policy must be a JSON object.");
  }
  const section = (raw as Record<string, unknown>).display;
  if (section === undefined) return ok(Object.create(null) as Display);
  if (section === null || typeof section !== "object" || Array.isArray(section)) {
    return err("config.display_invalid", "Policy.display must be an object mapping a chain|token key to { decimals, symbol }.");
  }

  const display = Object.create(null) as Display;
  for (const [rawKey, rawInfo] of Object.entries(section as Record<string, unknown>)) {
    const key = parseAssetKeyString(rawKey);
    if (!key.ok) return err("config.display_invalid", `display key "${rawKey}" is not a "chain|token" coordinate.`);
    if (rawInfo === null || typeof rawInfo !== "object") {
      return err("config.display_invalid", `display["${rawKey}"] must be an object with a numeric decimals (and optional symbol).`);
    }
    const info = rawInfo as Record<string, unknown>;
    if (typeof info.decimals !== "number" || !Number.isInteger(info.decimals) || info.decimals < 0 || info.decimals > MAX_DECIMALS) {
      return err("config.decimals_invalid", `display["${rawKey}"].decimals must be an integer in [0, ${MAX_DECIMALS}].`);
    }
    let symbol: string | undefined;
    if (info.symbol !== undefined) {
      if (typeof info.symbol !== "string") {
        return err("config.symbol_invalid", `display["${rawKey}"].symbol must be a string.`);
      }
      symbol = info.symbol;
    }
    display[key.value] = symbol === undefined ? { decimals: info.decimals } : { decimals: info.decimals, symbol };
  }
  return ok(display);
}

/** Parse a raw `chain|token` string into a canonical AssetKey (the same coordinate caps are keyed by). */
function parseAssetKeyString(rawKey: string): Result<AssetKey> {
  const sep = rawKey.indexOf("|");
  if (sep <= 0 || sep === rawKey.length - 1) return err("config.display_invalid", "not a chain|token coordinate");
  const chain: Result<ChainId> = makeChainId(rawKey.slice(0, sep));
  if (!chain.ok) return chain;
  const token: Result<Address> = makeAddress(rawKey.slice(sep + 1));
  if (!token.ok) return token;
  return ok(assetKey({ chain: chain.value, token: token.value }));
}

/**
 * Render a base-unit amount into a human decimal string, EXACTLY — no float, ever. Money touched by
 * a float is money made wrong. Pure integer-string arithmetic: place the decimal point `decimals`
 * digits from the right, zero-padding as needed. e.g. (50000000n, 6) → "50.000000"; (1234n, 6) → "0.001234".
 */
export function renderAmount(base: bigint, decimals: number): string {
  // Self-defending: an exported money-render primitive must REFUSE bad input, never emit a malformed
  // string (a direct caller doesn't have parseDisplay's boundary in front of it). Fail loud.
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new RangeError(`renderAmount: decimals must be an integer in [0, ${MAX_DECIMALS}], got ${decimals}.`);
  }
  if (base < 0n) throw new RangeError(`renderAmount: base must be non-negative, got ${base}.`);
  const s = base.toString();
  if (decimals === 0) return s;
  const padded = s.padStart(decimals + 1, "0");
  const cut = padded.length - decimals;
  return `${padded.slice(0, cut)}.${padded.slice(cut)}`;
}

/** Group an integer string with thousands separators for readability (raw base-unit display only). */
function group(s: string): string {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** One cap's value: the raw base-unit string, and a human rendering IFF decimals were declared. */
export interface AmountView {
  /** The exact base-unit amount, as a decimal string. Always present — the source of truth. */
  base: string;
  /** Human units ("50.000000 USDC") when decimals are DECLARED; null otherwise (no guessing). */
  human: string | null;
  /** Digit-grouped base units ("50,000,000") — the honest fallback when `human` is null. */
  baseGrouped: string;
}

/** One denomination's caps, described for a human to eyeball against intent. */
export interface DenominationView {
  key: string;
  /** Declared decimals, or null (⇒ human renderings are withheld rather than guessed). */
  decimals: number | null;
  /** Declared symbol, or null. Display-only — never keyed on, never enforced. */
  symbol: string | null;
  perRequest: AmountView;
  perDomain: AmountView;
  global: AmountView;
}

/** A faithful, human-facing description of a policy — the ECHO. Every number is present as exact base
 *  units; a human rendering is added only where the user DECLARED the decimals to render it with. */
export interface PolicyDescription {
  halt: boolean;
  requireOriginMatch: boolean;
  clockSkewSeconds: string;
  maxAuthLifetimeSeconds: string;
  windowSeconds: string;
  allowlist: { address: string; chain: string }[];
  denominations: DenominationView[];
}

/**
 * Describe a policy for a human to check against intent — the fat-finger control. Renders each cap in
 * human units WHEN (and only when) the caller supplies declared `display` decimals; otherwise it shows
 * exact, digit-grouped base units and marks them as such. Forms no opinion and looks nothing up: it is
 * arithmetic on the user's own declarations. `display` is never consulted for any decision — it reaches
 * this function only, never the enforcement path.
 */
export function describePolicy(policy: Policy, display?: Display): PolicyDescription {
  const view = (base: bigint, info: DisplayInfo | undefined): AmountView => {
    const baseStr = base.toString();
    const baseGrouped = group(baseStr);
    if (info === undefined) return { base: baseStr, human: null, baseGrouped };
    const rendered = renderAmount(base, info.decimals);
    return { base: baseStr, human: info.symbol ? `${rendered} ${info.symbol}` : rendered, baseGrouped };
  };

  const denominations: DenominationView[] = [];
  for (const [key, caps] of Object.entries(policy.caps)) {
    const info = display?.[key as AssetKey];
    denominations.push({
      key,
      decimals: info?.decimals ?? null,
      symbol: info?.symbol ?? null,
      perRequest: view(caps.perRequest, info),
      perDomain: view(caps.perDomain, info),
      global: view(caps.global, info),
    });
  }

  return {
    halt: policy.halt,
    requireOriginMatch: policy.requireOriginMatch,
    clockSkewSeconds: policy.clockSkewSeconds.toString(),
    maxAuthLifetimeSeconds: policy.maxAuthLifetimeSeconds.toString(),
    windowSeconds: policy.windowSeconds.toString(),
    allowlist: policy.allowlist.map((e) => ({ address: e.address, chain: e.chain })),
    denominations,
  };
}
