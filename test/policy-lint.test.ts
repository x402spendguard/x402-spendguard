// LINT-01 — the advisory policy linter. It flags STRUCTURAL CONTRADICTIONS (a cap that can never
// bind; a destination you permitted but made unpayable) without ever judging the user's CHOICES.
// The clean-policy-is-empty test is the non-vacuity anchor: if lint always returned findings it goes
// red; if it always returned [] every other test goes red.
import { describe, it, expect } from "vitest";
import { parsePolicy } from "../src/parse.js";
import { lintPolicy } from "../src/policy-lint.js";
import type { Policy } from "../src/types.js";

const CHAIN = "eip155:84532";
const OTHER_CHAIN = "eip155:137"; // deliberately NOT a substring of CHAIN (avoids .includes false-matches)
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const PAYEE = "0x1111111111111111111111111111111111111111";

type CapInput = { perRequest: string; perDomain: string; global: string };
const HEALTHY_CAP: CapInput = { perRequest: "1000", perDomain: "5000", global: "10000" };

function policy(over: {
  caps?: Record<string, CapInput>;
  allowlist?: { address: string; chain: string }[];
}): Policy {
  const parsed = parsePolicy({
    halt: false,
    requireOriginMatch: false,
    allowlist: over.allowlist ?? [{ address: PAYEE, chain: CHAIN }],
    caps: over.caps ?? { [`${CHAIN}|${USDC}`]: HEALTHY_CAP },
    clockSkewSeconds: "120",
    maxAuthLifetimeSeconds: "3600",
    windowSeconds: "86400",
  });
  if (!parsed.ok) throw new Error(`test policy invalid: ${parsed.reason} ${parsed.detail}`);
  return parsed.value;
}

describe("policy linter (advisory; structural contradictions, never value judgments) — LINT-01", () => {
  it("lint-clean-policy-has-no-findings", () => {
    // perRequest <= perDomain <= global, and the one allowlisted chain has a caps denomination.
    expect(lintPolicy(policy({}))).toEqual([]);
  });

  it("lint-flags-a-dead-cap-when-perRequest-exceeds-perDomain", () => {
    const p = policy({ caps: { [`${CHAIN}|${USDC}`]: { perRequest: "9000", perDomain: "5000", global: "10000" } } });
    const found = lintPolicy(p);
    expect(found.some((f) => f.kind === "deadCap" && f.subject === `${CHAIN}|${USDC}`)).toBe(true);
  });

  it("lint-flags-a-dead-cap-when-perDomain-exceeds-global", () => {
    const p = policy({ caps: { [`${CHAIN}|${USDC}`]: { perRequest: "1000", perDomain: "9000", global: "5000" } } });
    expect(lintPolicy(p).some((f) => f.kind === "deadCap")).toBe(true);
  });

  it("lint-flags-an-unpayable-allowlist-entry-with-no-caps-for-its-chain", () => {
    // Allowlisted on OTHER_CHAIN, but caps only cover CHAIN -> every payment to it denies (CAP-05).
    const p = policy({
      allowlist: [
        { address: PAYEE, chain: OTHER_CHAIN },
        { address: PAYEE, chain: CHAIN },
      ],
      caps: { [`${CHAIN}|${USDC}`]: HEALTHY_CAP },
    });
    const found = lintPolicy(p);
    expect(found.some((f) => f.kind === "unpayableAllowlistEntry" && f.subject.includes(OTHER_CHAIN))).toBe(true);
    // The CHAIN entry IS payable -> must NOT be flagged (non-vacuous: we don't flag everything).
    expect(found.some((f) => f.kind === "unpayableAllowlistEntry" && f.subject.includes(CHAIN))).toBe(false);
  });

  it("lint-flags-an-unreachable-denomination-with-no-allowlisted-destination", () => {
    // Caps for OTHER_CHAIN, but the allowlist only covers CHAIN -> the denomination has no key.
    const p = policy({
      allowlist: [{ address: PAYEE, chain: CHAIN }],
      caps: {
        [`${CHAIN}|${USDC}`]: HEALTHY_CAP,
        [`${OTHER_CHAIN}|${USDC}`]: HEALTHY_CAP,
      },
    });
    expect(lintPolicy(p).some((f) => f.kind === "unreachableDenomination" && f.subject === `${OTHER_CHAIN}|${USDC}`)).toBe(true);
  });
});
