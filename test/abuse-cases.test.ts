// The ABUSE-CASE axis (TEST_PLAN §5). Two things live here, deliberately together:
//
//  1. One staged attack per threat T1–T15 — the adversary's move, asserting the guard
//     DENIES for the correct reason code. This is the threat-indexed evidence surface a
//     skeptical reader looks for; the requirement tests (organized by REQ) are the other
//     axis. The two cross-cut on purpose.
//
//  2. The META-GATE that makes this axis ENFORCED rather than aspirational. Its source of
//     truth is THREAT_MODEL §5's threat→control table — NOT the test titles. It asserts
//     every threat in §5 has a staged test here, that every control §5 names for a threat
//     is a real requirement whose test exists in the suite (reusing the SAME REQUIREMENTS.md
//     parser the traceability gate and matrix generator share), and it fails closed on a
//     malformed table. The `T#` in each title below is only the human-readable anchor.
//
// Value gradient, stated honestly so effort tracks value (TEST_PLAN §5, §9):
//  - T7 (denomination confusion) and T11 (on-disk log) close a REAL gap the per-control
//    tests don't reach — composed denomination probing, and the actual FileDecisionLog write
//    path vs. the toLogEntry projection in isolation.
//  - T1/T14 (redirect) is mostly legibility with some composition (three redirect vectors).
//  - T3/T4 (runaway drain) are legibility: INV-1's property test owns the correctness
//    generatively; these are the readable, named runaway narrative.
//  - The rest are thin threat-indexed anchors over already-strong single-control coverage —
//    not re-proofs dressed up as more.

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluate } from "../src/policy/engine.js";
import { SpendGuard, emptyState } from "../src/accounting/guard.js";
import type { Clock, SpendStore, Version } from "../src/accounting/guard.js";
import { assetKey } from "../src/parse.js";
import { loadPolicyFile } from "../src/adapters/policy-file-loader.js";
import { guardedFetch, type FetchLike } from "../src/adapters/x402-transport.js";
import { PaymentFlowContext } from "../src/adapters/x402-guarded-signer.js";
import { LoggingGuard, type Authorizer } from "../src/audit/decision-log.js";
import { FileDecisionLog } from "../src/adapters/file-decision-log.js";
import { parseRequirements } from "../scripts/lib/requirements.js";
import type { Address, Domain, Policy, PolicyDecision, SpendState, UnixSeconds } from "../src/types.js";
import {
  A, T, key, ev, policy, caps, challenge, freshState, state,
  PAYEE, ATTACKER, USDC, CHAIN, NOW,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// Shared fixtures for the accounting-layer threats (T3/T4/T9/T10).
// ---------------------------------------------------------------------------
const START = 1_000_000n as UnixSeconds;
const OTHER_TOKEN = "0xffffffffffffffffffffffffffffffffffffffff" as Address;

class FakeClock implements Clock {
  constructor(public t: UnixSeconds) {}
  now(): UnixSeconds {
    return this.t;
  }
}

// An async in-memory compare-and-swap store — the `tick()` yield makes the concurrency
// guarantees real properties, not artifacts of synchronous code (mirrors accounting.test.ts).
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
class MemStore implements SpendStore {
  private version = 0;
  constructor(public stateRef: SpendState) {}
  async load(): Promise<{ state: SpendState; version: Version }> {
    await tick();
    return { state: structuredClone(this.stateRef), version: String(this.version) as Version };
  }
  async compareAndSave(expected: Version, next: SpendState): Promise<boolean> {
    await tick();
    if (String(this.version) !== expected) return false;
    this.version++;
    this.stateRef = structuredClone(next);
    return true;
  }
  async verifyAtomicity(): Promise<void> {}
}

// Per-domain-limited (1.0) and global-limited (1.0) policies for the cumulative-drain threats.
const perDomainCap1 = policy({ caps: caps({ perRequest: A(1_000_000n), perDomain: A(1_000_000n), global: A(20_000_000n) }) });
const globalCap1 = policy({ caps: caps({ perRequest: A(1_000_000n), perDomain: A(1_000_000n), global: A(1_000_000n) }) });
const pay = (amount: bigint) => ev({ amount: A(amount) }, { value: A(amount) });
const payFrom = (host: string, amount: bigint) => ({ ...pay(amount), origin: host as Domain });

// StubAuthorizer for the logging threat — LoggingGuard wraps a real FileDecisionLog around it.
const ALLOW: PolicyDecision = { verdict: "allow", reason: "ok", detail: "All checks passed." };
class StubAuthorizer implements Authorizer {
  async authorize(): Promise<PolicyDecision> {
    return ALLOW;
  }
}

// ===========================================================================
// THE STAGED ATTACKS — one per threat, T1..T15.
// ===========================================================================

it("T1 · a redirected payment is refused — at the allowlist and, independently, at binding", () => {
  // Vector A: a malicious challenge names the attacker as payTo; the honest client copies it
  // into the signed struct → the allowlist (payTo not listed) catches it.
  expect(evaluate(ev({ payTo: ATTACKER }, { to: ATTACKER }), policy(), freshState(), NOW).reason)
    .toBe("allowlist.blocked");
  // Vector B: the challenge payTo is the allowed payee, but the signed `to` is swapped to the
  // attacker AFTER the guard evaluated the allowlist → binding (signed to ≠ payTo) catches it.
  expect(evaluate(ev({ payTo: PAYEE }, { to: ATTACKER }), policy(), freshState(), NOW).reason)
    .toBe("bind.recipient_mismatch");
});

it("T2 · a single payment above the per-request cap is denied", () => {
  const p = policy({ caps: caps({ perRequest: A(500_000n) }) });
  expect(evaluate(ev({ amount: A(500_001n) }, { value: A(500_001n) }), p, freshState(), NOW).reason)
    .toBe("cap.per_request");
});

it("T3 · a runaway loop hammering one endpoint is stopped at the per-domain cap", async () => {
  // Legibility narrative (INV-1 owns the correctness generatively): fire 0.4 payments at one
  // origin against a 1.0 per-domain cap; the third (1.2 cumulative) must be refused.
  const guard = new SpendGuard(new MemStore(emptyState(START)), new FakeClock(START), perDomainCap1);
  expect((await guard.authorize(pay(400_000n))).verdict).toBe("allow"); // 0.4
  expect((await guard.authorize(pay(400_000n))).verdict).toBe("allow"); // 0.8
  const third = await guard.authorize(pay(400_000n)); // 1.2 > 1.0
  expect(third.verdict).toBe("deny");
  expect(third.reason).toBe("cap.per_domain");
});

it("T4 · a drain spread thin across many endpoints is stopped at the global cap", async () => {
  // Each endpoint stays under the per-domain cap, so only the account-wide global cap can stop it.
  const guard = new SpendGuard(new MemStore(emptyState(START)), new FakeClock(START), globalCap1);
  expect((await guard.authorize(payFrom("a.example", 400_000n))).verdict).toBe("allow"); // global 0.4
  expect((await guard.authorize(payFrom("b.example", 400_000n))).verdict).toBe("allow"); // global 0.8
  const third = await guard.authorize(payFrom("c.example", 400_000n)); // global 1.2 > 1.0
  expect(third.verdict).toBe("deny");
  expect(third.reason).toBe("cap.global");
});

it("T5 · an inflated signed value above the challenge amount is denied", () => {
  // A facilitator accepts value ≥ amount; the guard does not. Challenge asks 0.5, signed is 5.0.
  expect(evaluate(ev({ amount: A(500_000n) }, { value: A(5_000_000n) }), policy(), freshState(), NOW).reason)
    .toBe("bind.amount_mismatch");
});

it("T6 · a capability whose validBefore outlives the policy ceiling is denied", () => {
  // The malicious server claims an enormous maxTimeoutSeconds; the policy ceiling (3600 + skew)
  // is the real bound — the server can only shorten the window, never extend it.
  const huge = T(10n ** 30n);
  expect(evaluate(ev({ maxTimeoutSeconds: huge }, { validBefore: T(NOW + 3_700n) }), policy(), freshState(), NOW).reason)
    .toBe("bind.timeout_exceeded");
});

it("T7 · asset/chain confusion never lets a cap be evaluated in the wrong denomination", () => {
  // Composed probing of the denomination boundary (BIND-04 + CAP-04 + CAP-05 as one attack surface):
  // (a) a huge spend in ANOTHER denomination must not consume this asset's cap headroom.
  const otherKey = assetKey({ chain: CHAIN, token: OTHER_TOKEN });
  expect(evaluate(ev(), policy(), state({ spentByAsset: { [otherKey]: 999_000_000n } }), NOW).verdict)
    .toBe("allow");
  // (b) a payment in an UNCONFIGURED token is denied — it must never borrow the configured token's
  //     cap nor silently fall through to allow (the policy caps only USDC).
  expect(evaluate(ev({ asset: OTHER_TOKEN }, { verifyingContract: OTHER_TOKEN }), policy(), freshState(), NOW).reason)
    .toBe("cap.asset_unconfigured");
  // (c) a signed asset differing from the challenge's declared asset is denied (the cap/allowlist
  //     decision was made against the challenge; binding makes it sound).
  expect(evaluate(ev({ asset: USDC }, { verifyingContract: OTHER_TOKEN }), policy(), freshState(), NOW).reason)
    .toBe("bind.asset_mismatch");
});

it("T8 · a check that throws mid-evaluation fails closed (deny), never crashes open", () => {
  const boom = new Proxy(policy(), {
    get(_t, prop) {
      if (prop === "halt") throw new Error("boom");
      return undefined;
    },
  }) as Policy;
  const d = evaluate(ev(), boom, freshState(), NOW);
  expect(d.verdict).toBe("deny");
  expect(d.reason).toBe("engine.error");
});

it("T9 · two concurrent payments cannot both pass a cap they jointly exceed", async () => {
  const guard = new SpendGuard(new MemStore(emptyState(START)), new FakeClock(START), perDomainCap1);
  // Two 0.6 payments fired concurrently against a 1.0 cap — exactly one must win.
  const [a, b] = await Promise.all([guard.authorize(pay(600_000n)), guard.authorize(pay(600_000n))]);
  expect([a, b].filter((d) => d.verdict === "allow").length).toBe(1);
});

it("T10 · a crash after write-ahead recording never under-counts on restart", async () => {
  const store = new MemStore(emptyState(START));
  const g1 = new SpendGuard(store, new FakeClock(START), perDomainCap1);
  expect((await g1.authorize(pay(600_000n))).verdict).toBe("allow"); // 0.6 recorded write-ahead
  // "Crash" before settlement: a fresh guard over the recorded state must see the 0.6 and refuse
  // a second 0.6 that would breach the 1.0 cap (over-count safe, under-count never).
  const g2 = new SpendGuard(new MemStore(store.stateRef), new FakeClock(START), perDomainCap1);
  const second = await g2.authorize(pay(600_000n));
  expect(second.verdict).toBe("deny");
  expect(second.reason).toBe("cap.per_domain");
});

it("T11 · a decision written to the REAL on-disk log leaks no nonce, payer, or signature", async () => {
  // Stronger than the toLogEntry projection unit test: drive a full decision through the actual
  // FileDecisionLog write path and grep the bytes ON DISK. The helper ev() carries nonce
  // 0xdeadbeef and payer 0xcccc… — neither may reach the file (both are bearer-capability material).
  const dir = mkdtempSync(join(tmpdir(), "spendguard-abuse-t11-"));
  try {
    const path = join(dir, "decisions.jsonl");
    const guard = new LoggingGuard(new StubAuthorizer(), new FileDecisionLog(path), new FakeClock(NOW));
    await guard.authorize(ev());
    const bytes = readFileSync(path, "utf8").toLowerCase();
    expect(bytes).not.toContain("0xdeadbeef"); // the nonce value (half the replay tuple)
    expect(bytes).not.toContain("nonce");
    expect(bytes).not.toContain("signature");
    expect(bytes).not.toContain("0xcccccccccccccccccccccccccccccccccccccccc"); // the payer `from`
    expect(bytes).toContain("allow"); // it IS a real, non-empty log entry
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("T12 · a full decision performs no network egress at runtime (fetch is never invoked)", () => {
  // Dynamic complement to the STATIC no-egress proof (PRIV-01/03, static.test.ts, which owns the
  // real guarantee): a trip-wire fetch that throws if called. A decision that phoned home would
  // trip it; it doesn't. Cheap runtime witness that the statically-absent egress is also runtime-absent.
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = (() => {
    called = true;
    throw new Error("egress attempted");
  }) as typeof fetch;
  try {
    expect(evaluate(ev(), policy(), freshState(), NOW).verdict).toBe("allow");
    expect(called).toBe(false);
  } finally {
    globalThis.fetch = original;
  }
});

it("T13 · the kill switch denies every payment, including an otherwise-valid one", () => {
  expect(evaluate(ev(), policy({ halt: true }), freshState(), NOW).reason).toBe("halt");
});

it("T14 · a server redirect cannot mint a fresh per-domain budget bucket", async () => {
  // The client called shop.example; the server answered the 402 from a rotating subdomain.
  // The budget must key on the CLIENT-CHOSEN host (redirect-immune, DOM-01), not response.url —
  // else a payee rotates subdomains to reset its per-domain cap every call.
  const ctx = new PaymentFlowContext();
  const inner: FetchLike = async () => ({ status: 402, url: "https://sub7.evil-cdn.example/paid" });
  await guardedFetch(ctx, inner)("https://shop.example/api");
  ctx.observeChallenge(challenge());
  expect(ctx.consume().origin).toBe("shop.example"); // NOT evil-cdn.example
});

it("T15 · a world-writable policy file is refused before its bytes are trusted", () => {
  // A local user who can rewrite policy.json could disable the guard. A world-writable policy is
  // refused on load, a deterministic startup gate (POSIX; a no-op on Windows per PLAT-01).
  const dir = mkdtempSync(join(tmpdir(), "spendguard-abuse-t15-"));
  try {
    const path = join(dir, "policy.json");
    writeFileSync(path, JSON.stringify({
      halt: false,
      allowlist: [{ address: PAYEE, chain: CHAIN }],
      caps: { [`${CHAIN}|${USDC}`]: { perRequest: "500000", perDomain: "5000000", global: "20000000" } },
      clockSkewSeconds: "60", maxAuthLifetimeSeconds: "3600", windowSeconds: "86400", requireOriginMatch: false,
    }));
    chmodSync(path, 0o666);
    const r = loadPolicyFile(path);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("config.world_writable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// THE META-GATE — makes the abuse-case axis enforced, derived from THREAT_MODEL §5.
// ===========================================================================

/**
 * Parse §5's threat→control table into `T# → [REQ ids]`. The table's last column
 * ("Requirements") is the source of truth; control tokens use `PREFIX-NN/MM` shorthand
 * (e.g. `ALLOW-01/02` = ALLOW-01 + ALLOW-02) and comma separation. FAILS CLOSED: a threat
 * row with no controls, or an unparseable control token, throws — a reformatted table that
 * the regex stops matching cannot pass vacuously green.
 */
function parseThreatControls(md: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const line of md.split("\n")) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = line.split("|").map((c) => c.trim());
    const tid = cells[1] ?? "";
    if (!/^T\d+$/.test(tid)) continue; // the §5 T-table rows, uniquely
    const controlsCell = (cells[cells.length - 1] || cells[cells.length - 2] || "").replace(/`/g, "");
    const reqs: string[] = [];
    for (const tok of controlsCell.split(",").map((t) => t.trim()).filter(Boolean)) {
      const m = tok.match(/^([A-Z]+)-(\d+(?:\/\d+)*)$/);
      if (!m) throw new Error(`§5 ${tid}: unparseable control token "${tok}"`);
      for (const n of m[2].split("/")) reqs.push(`${m[1]}-${n}`);
    }
    if (reqs.length === 0) throw new Error(`§5 ${tid}: names no control requirement`);
    map.set(tid, reqs);
  }
  return map;
}

/** Every `it(...)` title across the suite — the same discovery the traceability gate uses. */
function declaredTestNames(): Set<string> {
  const dir = fileURLToPath(new URL("./", import.meta.url));
  const names = new Set<string>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".test.ts")) continue;
    const code = readFileSync(join(dir, f), "utf8");
    for (const m of code.matchAll(/\bit(?:\.todo|\.skip)?\s*\(\s*["'`]([^"'`]+)["'`]/g)) names.add(m[1]);
  }
  return names;
}

/** The threats a staged abuse test in THIS file claims to cover — parsed from its own `T# ·` titles.
 *  The tag is the human anchor; §5 (above) is what the set is checked AGAINST. */
function stagedThreatTags(): Set<string> {
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const tags = new Set<string>();
  for (const m of self.matchAll(/\bit(?:\.todo|\.skip)?\s*\(\s*["'`](T\d+)\s*·/g)) tags.add(m[1]);
  return tags;
}

describe("abuse-case axis is enforced (source of truth: THREAT_MODEL §5)", () => {
  const threatModel = readFileSync(fileURLToPath(new URL("../THREAT_MODEL.md", import.meta.url)), "utf8");
  const requirementsMd = readFileSync(fileURLToPath(new URL("../REQUIREMENTS.md", import.meta.url)), "utf8");
  const threats = parseThreatControls(threatModel);
  const requirements = new Map(parseRequirements(requirementsMd).map((r) => [r.id, r]));
  const declared = declaredTestNames();
  const staged = stagedThreatTags();

  it("the §5 threat table parses to a full set (fail-closed sanity floor)", () => {
    // If the regex silently matched nothing (a reformatted table), this is the floor that catches it.
    expect(threats.size).toBeGreaterThanOrEqual(15);
    for (const [tid, controls] of threats) expect(controls.length, `${tid} has no controls`).toBeGreaterThan(0);
  });

  it("every §5 threat has at least one staged abuse-case test in this file", () => {
    const missing = [...threats.keys()].filter((t) => !staged.has(t)).sort();
    expect(missing, `§5 threats with no staged abuse test:\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("no staged abuse test is tagged to a threat that is not in §5 (typo/orphan guard)", () => {
    const orphan = [...staged].filter((t) => !threats.has(t)).sort();
    expect(orphan, `staged tags with no matching §5 threat:\n  ${orphan.join("\n  ")}`).toEqual([]);
  });

  it("every control §5 names for a threat is a real requirement whose test exists in the suite", () => {
    // Composes the T-axis onto the REQ→test axis through the threat model's OWN declared mapping:
    // §5 claims "T7 is defended by BIND-04, CAP-04" → those must resolve to tested artifacts.
    const problems: string[] = [];
    for (const [tid, controls] of threats) {
      for (const c of controls) {
        const req = requirements.get(c);
        if (!req) {
          problems.push(`${tid} → ${c}: no such requirement in REQUIREMENTS.md`);
        } else if (req.tests.length === 0) {
          problems.push(`${tid} → ${c}: requirement names no test`);
        } else {
          const absent = req.tests.filter((t) => !declared.has(t));
          if (absent.length) problems.push(`${tid} → ${c}: test(s) not found in suite: ${absent.join(", ")}`);
        }
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});
