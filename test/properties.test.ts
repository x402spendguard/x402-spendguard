// Property-based tests (fast-check) — the layer that attacks our IMAGINATION, not just our examples.
// The P0 concurrency bug (TEST_PLAN §9) is the standing proof that example tests only cover the
// interleavings a human wrote; these generate inputs nobody wrote and assert the invariants hold
// anyway. Targets the PURE engine + pure accounting (the ideal fast-check surface — no I/O, no
// mocks). The store's cross-process CAS is covered by the depth-stress e2e, not here.
//
// Invariant ids are from TEST_PLAN.md §6. A failure here is a real defect, not a flaky test:
// everything is deterministic (fast-check replays a failing seed).
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "../src/policy/engine.js";
import { isReasonCode } from "../src/reasons.js";
import { recordSpend, applyWindow, emptyState } from "../src/accounting/guard.js";
import { parsePolicy, parseChallenge, parseAuthorization, assetKey } from "../src/parse.js";
import { HashChainDecisionLog } from "../src/audit/hash-chain-log.js";
import { hmacChainHasher } from "../src/audit/chain-hasher.js";
import type { ChainedRecord } from "../src/audit/hash-chain-log.js";
import type { LogEntry } from "../src/audit/decision-log.js";
import { A, T, NOW, CHAIN, PAYEE, ATTACKER, USDC, policy, caps, ev, state, key } from "./helpers.js";
import type { Amount, Address } from "../src/types.js";

const logEntry = (i: number): LogEntry => ({
  v: 1,
  at: String(1_000_000 + i),
  verdict: "allow",
  reason: "ok",
  detail: "d",
  origin: "weather.example",
  chain: "eip155:8453",
  asset: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  amount: String(1000 + i),
});
const readLines = (path: string): string[] => readFileSync(path, "utf8").split("\n").filter(Boolean);

const HUGE = A(10n ** 15n); // a cap so large it never binds — isolates a non-cap reason for a deny
const arbAmount = fc.bigInt({ min: 0n, max: 3_000_000n });

describe("properties (fast-check) — invariants over generated inputs", () => {
  // INV-1 — the no-drain invariant, THE property. For any global cap and any sequence of otherwise
  // valid payments, the cumulative ALLOWED spend can never exceed the cap. If the engine ever admits
  // a sequence summing past the cap, that is a drain.
  it("INV-1 no-drain: cumulative allowed spend never exceeds the global cap", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1_000_000n, max: 10_000_000n }), fc.array(arbAmount, { maxLength: 40 }), (cap, amounts) => {
        const pol = policy({ caps: caps({ perRequest: A(cap), perDomain: A(cap), global: A(cap) }) });
        let st = state(); // fresh; fixed time isolates the cap logic from window resets (see CLOCK-01)
        let allowed = 0n;
        for (const amt of amounts) {
          const e = ev({ amount: A(amt) }, { value: A(amt) }); // valid binding, allowlisted payee
          const d = evaluate(e, pol, st, NOW);
          if (d.verdict === "allow") {
            allowed += amt;
            st = recordSpend(st, e);
          }
        }
        return allowed <= cap;
      }),
      { numRuns: 500 },
    );
  });

  // INV-2 — fail-closed fuzzing. The parse boundary must turn ANY input into a Result, never throw.
  // "Throw garbage at it; it must never blow up" — the single most valuable fuzz in the plan.
  it("INV-2 fail-closed: parsePolicy never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.anything(), (garbage) => {
        const r = parsePolicy(garbage);
        return r.ok === true || r.ok === false; // a Result, not an exception
      }),
      { numRuns: 1000 },
    );
  });

  it("INV-2 fail-closed: parseChallenge / parseAuthorization never throw on arbitrary object input", () => {
    const arbObj = fc.dictionary(fc.string(), fc.anything());
    fc.assert(
      fc.property(arbObj, (raw) => {
        const c = parseChallenge(raw as Record<string, unknown>);
        const a = parseAuthorization(raw as Record<string, unknown>);
        return typeof c.ok === "boolean" && typeof a.ok === "boolean";
      }),
      { numRuns: 1000 },
    );
  });

  // INV-4 — binding soundness. Any disagreement between the challenge and the signed authorization on
  // recipient or amount MUST deny — that binding is what makes the cap/allowlist decision meaningful
  // (an allow implies the signed struct matches what was quoted). Caps are huge so a deny here can
  // only be the binding, not the cap.
  it("INV-4 binding soundness: a challenge/authorization mismatch on to/value always denies", () => {
    const addr = fc.constantFrom(PAYEE, ATTACKER, USDC);
    fc.assert(
      fc.property(addr, addr, arbAmount, arbAmount, (payTo, to, cAmt, aAmt) => {
        const e = ev({ payTo, amount: A(cAmt) }, { to, value: A(aAmt) });
        const pol = policy({
          allowlist: [
            { address: payTo, chain: CHAIN },
            { address: to, chain: CHAIN },
          ],
          caps: caps({ perRequest: HUGE, perDomain: HUGE, global: HUGE }),
        });
        const d = evaluate(e, pol, state(), NOW);
        const mismatch = to !== payTo || aAmt !== cAmt;
        // Mismatch ⇒ deny. (Agreement may allow or deny for other reasons — not asserted here.)
        return mismatch ? d.verdict === "deny" : true;
      }),
      { numRuns: 500 },
    );
  });

  // CLOCK-01 — monotonic clock. `applyWindow` folds in the effective clock as max(now, lastSeen), so
  // a backward wall-clock jump can neither move `lastSeen` backwards nor be used to un-count spend or
  // reset a window early. For ANY sequence of clock readings (including jumps backward), lastSeen is
  // non-decreasing.
  it("CLOCK-01: applyWindow never moves lastSeen backwards under any clock sequence", () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 0n, max: 10n ** 8n }), { maxLength: 40 }), fc.bigInt({ min: 1n, max: 10n ** 6n }), (nows, win) => {
        let st = emptyState(T(0n));
        for (const now of nows) {
          const next = applyWindow(st, T(now), T(win));
          if (next.lastSeen < st.lastSeen) return false; // must never regress
          st = next;
        }
        return true;
      }),
      { numRuns: 500 },
    );
  });

  // Hash-chain "any-mutation-fails" — the generalization of the audit log's hand-picked tamper tests.
  // In KEYED + ANCHORED mode (the strong config), ANY single on-disk mutation — a changed field, a
  // deleted/reordered record, a truncated tail — must make verify() fail: content mutations break the
  // HMAC, structural ones break seq/linkage, tail changes break the pinned head. (Unkeyed self-verify
  // deliberately cannot catch a valid-prefix truncation or a full self-consistent rewrite — §D-036 —
  // which is exactly why the strong claim is asserted here in keyed+anchored mode.)
  it("hash-chain any-mutation-fails: keyed+anchored verify catches any single on-disk mutation", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 3, max: 8 }),
        fc.nat(),
        fc.constantFrom("content", "delete", "swap", "truncate"),
        async (n, seed, strategy) => {
          const dir = mkdtempSync(join(tmpdir(), "x402-prop-audit-"));
          try {
            const key = "anchor-key";
            const path = join(dir, "log");
            const log = new HashChainDecisionLog(path, hmacChainHasher(key));
            for (let i = 0; i < n; i++) await log.append(logEntry(i));
            const expectedHead = (await new HashChainDecisionLog(path, hmacChainHasher(key)).verify()).head;

            let ls = readLines(path);
            const idx = seed % ls.length;
            if (strategy === "content") {
              const r = JSON.parse(ls[idx]) as ChainedRecord;
              r.entry.amount = r.entry.amount + "9"; // a guaranteed-different field value
              ls[idx] = JSON.stringify(r);
            } else if (strategy === "delete") {
              ls.splice(idx, 1);
            } else if (strategy === "swap") {
              const j = (idx + 1) % ls.length;
              [ls[idx], ls[j]] = [ls[j], ls[idx]];
            } else {
              ls = ls.slice(0, ls.length - 1); // truncate the tail (a valid prefix — caught by the anchor)
            }
            writeFileSync(path, ls.join("\n") + "\n");

            const r = await new HashChainDecisionLog(path, hmacChainHasher(key)).verify({ expectedHead });
            return r.ok === false;
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 120 },
    );
    // Explicit generous timeout: 120 runs of temp-dir + keyed-HMAC + on-disk mutate/re-verify is
    // inherently ~3s locally but 5–6s on busy 2-core CI runners, crossing vitest's 5s default and
    // flaking RED on duration alone (not a counterexample). A real hang still fails at this bound.
  }, 30_000);

  // INV-5 — same-(asset,chain) accounting. A cap is keyed by (asset, chain); spend in one denomination
  // must never consume another's headroom. Cap both assets equally, spend arbitrarily in asset A, then
  // assert a full-cap payment in asset B is STILL allowed — A's spend never touched B's budget.
  it("INV-5 same-asset accounting: spend in one (asset,chain) never consumes another's cap", () => {
    const TOKEN_B = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
    const keyB = assetKey({ chain: CHAIN, token: TOKEN_B });
    const CAP = 3_000_000n;
    const capObj = { perRequest: A(CAP), perDomain: A(CAP), global: A(CAP) };
    fc.assert(
      fc.property(fc.array(arbAmount, { maxLength: 20 }), (amountsA) => {
        const pol = policy({
          allowlist: [{ address: PAYEE, chain: CHAIN }],
          caps: { [key]: capObj, [keyB]: capObj },
        });
        let st = state();
        for (const amt of amountsA) {
          const eA = ev({ amount: A(amt) }, { value: A(amt) }); // asset A (USDC default)
          if (evaluate(eA, pol, st, NOW).verdict === "allow") st = recordSpend(st, eA);
        }
        // A payment for B's FULL cap must still pass — cross-asset headroom is independent.
        const eB = ev({ asset: TOKEN_B, amount: A(CAP) }, { verifyingContract: TOKEN_B, value: A(CAP) });
        return evaluate(eB, pol, st, NOW).verdict === "allow";
      }),
      { numRuns: 300 },
    );
  });

  // INV-6 — purity/determinism. evaluate() reads no wall clock and no randomness internally, so the
  // same arguments always produce the same decision. (The direct falsifiable form of CORE-01.)
  it("INV-6 determinism: evaluate is a pure function of its arguments (same in → same out)", () => {
    fc.assert(
      fc.property(fc.constantFrom(PAYEE, ATTACKER), arbAmount, arbAmount, fc.boolean(), (to, cAmt, aAmt, halt) => {
        const e = ev({ payTo: PAYEE, amount: A(cAmt) }, { to, value: A(aAmt) });
        const pol = policy({ halt, allowlist: [{ address: PAYEE, chain: CHAIN }] });
        const st = state();
        const d1 = evaluate(e, pol, st, NOW);
        const d2 = evaluate(e, pol, st, NOW);
        return d1.verdict === d2.verdict && d1.reason === d2.reason && d1.detail === d2.detail;
      }),
      { numRuns: 300 },
    );
  });

  // INV-8 — observability. Every decision, allow or deny, carries a reason that is a REGISTERED
  // code (a member of the reason registry), not merely a non-empty string. Membership is the
  // stronger claim: it makes the deny-reason legend's completeness true by construction — a decision
  // can never surface a code the legend doesn't document. The human sentence lives in `detail`.
  it("INV-8 observability: every decision carries a registered reason code", () => {
    fc.assert(
      fc.property(fc.constantFrom(PAYEE, ATTACKER), arbAmount, arbAmount, fc.boolean(), (to, cAmt, aAmt, halt) => {
        const e = ev({ payTo: PAYEE, amount: A(cAmt) }, { to, value: A(aAmt) });
        const pol = policy({ halt, allowlist: [{ address: PAYEE, chain: CHAIN }] });
        const { reason } = evaluate(e, pol, state(), NOW);
        return isReasonCode(reason);
      }),
      { numRuns: 300 },
    );
  });
});
