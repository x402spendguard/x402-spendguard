// The policy LINTER — an advisory, pure check for STRUCTURAL CONTRADICTIONS in a parsed policy.
//
// Mechanism-not-policy (the razor): this NEVER judges the user's CHOICES ("your cap is too high") —
// only their CONTRADICTIONS ("this cap is structurally inert: a tighter cap always denies first, so
// it can never be the binding limit"). It forms no opinion about what a policy SHOULD be; it reports
// where a policy does not do what its author almost certainly intended. Advisory-only: it never
// blocks, never changes enforcement, and returns findings the caller may render or ignore.
// `parsePolicy` remains the gate (trustworthiness); this is the layer above the `describePolicy`
// human-units echo (ONBOARD-03) — the echo catches an off-by-a-zero VALUE; the linter catches DEAD
// STRUCTURE. LINT-01.
//
// Pure: no I/O, no clock, no egress. Operates on an already-parsed, trustworthy `Policy`.
import type { Policy } from "./types.js";

/** The kind of structural contradiction found. camelCase (NOT a dotted reason code) — these are
 *  authoring advisories, a different family from the guard's enforcement reason codes (reasons.ts). */
export type PolicyLintKind =
  | "deadCap" // a cap that can never bind because a tighter cap always denies first
  | "unpayableAllowlistEntry" // an allowlisted destination whose chain has no caps denomination (CAP-05 ⇒ always denied)
  | "unreachableDenomination"; // a caps denomination for a chain with no allowlisted destination

export interface PolicyLintFinding {
  kind: PolicyLintKind;
  /** The coordinate the finding concerns — an AssetKey (caps) or `address@chain` (allowlist). */
  subject: string;
  /** A plain-language statement of the CONTRADICTION (never a value judgment). */
  message: string;
}

/** The chain component of a `chain|token` AssetKey (chain ids carry no `|`; tokens are `0x…`). */
function chainOf(key: string): string {
  const i = key.indexOf("|");
  return i < 0 ? key : key.slice(0, i);
}

/**
 * Lint a parsed policy for structural contradictions. Returns an empty array for a policy whose caps
 * are ordered (perRequest <= perDomain <= global) and whose allowlist and caps cover the same chains.
 * Findings are advisory — render them, never gate on them.
 */
export function lintPolicy(policy: Policy): PolicyLintFinding[] {
  const findings: PolicyLintFinding[] = [];

  // 1. DEAD CAPS — the intended order is perRequest <= perDomain <= global. Any inversion of an
  //    adjacent link makes the outer cap structurally inert (the inner, tighter cap denies first).
  //    Checking the two adjacent links is complete: an unsorted triple has some adjacent pair out
  //    of order. (perRequest > global cannot occur without also tripping one of these two.)
  for (const [key, caps] of Object.entries(policy.caps)) {
    if (caps.perRequest > caps.perDomain) {
      findings.push({
        kind: "deadCap",
        subject: key,
        message:
          `perRequest cap (${caps.perRequest}) exceeds perDomain cap (${caps.perDomain}) for ${key}: ` +
          `a single payment above the perDomain total is denied by perDomain first, so this perRequest ` +
          `cap can never be the binding limit. Did you mean perRequest <= perDomain?`,
      });
    }
    if (caps.perDomain > caps.global) {
      findings.push({
        kind: "deadCap",
        subject: key,
        message:
          `perDomain cap (${caps.perDomain}) exceeds global cap (${caps.global}) for ${key}: cumulative ` +
          `domain spend is bounded by the global cap first, so this perDomain cap can never be the ` +
          `binding limit. Did you mean perDomain <= global?`,
      });
    }
  }

  const cappedChains = new Set<string>();
  for (const key of Object.keys(policy.caps)) cappedChains.add(chainOf(key));
  const allowedChains = new Set<string>();
  for (const entry of policy.allowlist) allowedChains.add(entry.chain);

  // 2. UNPAYABLE ALLOWLIST ENTRY — a destination you permitted but can never actually pay, because
  //    no caps denomination exists for its chain (a denomination with no entry ⇒ deny, CAP-05).
  for (const entry of policy.allowlist) {
    if (!cappedChains.has(entry.chain)) {
      findings.push({
        kind: "unpayableAllowlistEntry",
        subject: `${entry.address}@${entry.chain}`,
        message:
          `allowlisted ${entry.address} on ${entry.chain} can never be paid: no caps denomination ` +
          `covers ${entry.chain}, so every payment to it is denied (CAP-05). Add a caps entry for its ` +
          `asset on ${entry.chain}, or remove the allowlist entry.`,
      });
    }
  }

  // 3. UNREACHABLE DENOMINATION — the mirror: a caps denomination guarding a chain with no
  //    allowlisted destination, so no payment can ever use it. Harmless, but signals confusion.
  for (const key of Object.keys(policy.caps)) {
    if (!allowedChains.has(chainOf(key))) {
      findings.push({
        kind: "unreachableDenomination",
        subject: key,
        message:
          `caps denomination ${key} has no allowlisted destination on ${chainOf(key)}: no payment can ` +
          `use it (the allowlist is empty for that chain). Add an allowlist entry, or remove the caps entry.`,
      });
    }
  }

  return findings;
}
