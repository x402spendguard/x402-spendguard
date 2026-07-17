// DEPTH × CONTENTION stress for ACCT-05/07 (TEST_PLAN §9). The ABA that shipped in v0.1.4 could not
// be reached by low-count races — it only exists once the version chain advances far enough that
// `cleanup` reclaims a number a stalled writer still holds. So this runs real separate processes at
// DEPTH (many commits) under contention, and asserts BOTH:
//   1. the security property — cumulative allowed spend NEVER exceeds the cap (no over-allow / ABA);
//   2. the FOUNDATION Option C rests on — a concurrent prober's view of `highestVersion()` (via
//      load().version) never goes BACKWARDS (no under-report). CHENG's condition: prove the
//      foundation mechanically at depth, not just the symptom.
// Opt-in (real processes, seconds), CI `e2e` job. Hermetic: local temp dir, no network, no funds.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VITE_NODE = join(process.cwd(), "node_modules", ".bin", "vite-node");
const SPEND_WORKER = fileURLToPath(new URL("./spend-worker.ts", import.meta.url));
const PROBE_WORKER = fileURLToPath(new URL("./probe-worker.ts", import.meta.url));

const AMOUNT = 1_000_000n;

function runWorker(script: string, env: Record<string, string>): Promise<Record<string, number>> {
  return new Promise((resolve, reject) => {
    const child = spawn(VITE_NODE, [script], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      const m = out.match(/^RESULT (.+)$/m);
      if (code !== 0 || !m) {
        reject(new Error(`worker (${script}) exited ${code}; no RESULT.\n${err}\n${out}`));
        return;
      }
      resolve(JSON.parse(m[1]) as Record<string, number>);
    });
  });
}

/** Durable truth: sum spentByAsset at the highest version file (in AMOUNT units). */
function ledgerUnits(dir: string): number {
  const files = readdirSync(dir).filter((f) => /ledger\.v\d+$/.test(f));
  if (!files.length) return 0;
  const max = Math.max(...files.map((f) => Number(f.match(/\.v(\d+)$/)![1])));
  const raw = JSON.parse(readFileSync(join(dir, `ledger.v${max}`), "utf8")) as { spentByAsset?: Record<string, string> };
  return Number(Object.values(raw.spentByAsset ?? {}).reduce((s, v) => s + BigInt(v), 0n) / AMOUNT);
}

describe("cross-process CAS at DEPTH × contention (ACCT-05/07)", () => {
  it("never over-allows at depth — a stalled writer cannot reclaim a cleaned version (ABA)", async () => {
    const WORKERS = 6;
    const ITERS = 50; // 300 attempts → the chain advances FAR past KEEP_VERSIONS, opening the ABA window
    const CAP = 10_000_000n; // admits exactly 10; the rest deny (and their window-persists churn versions)
    const EXPECT = Number(CAP / AMOUNT); // 10
    for (let round = 0; round < 2; round++) {
      const dir = mkdtempSync(join(tmpdir(), "x402-stress-"));
      try {
        const startAt = Date.now() + 2500;
        const env = {
          LEDGER: join(dir, "ledger"),
          STORE: "cas",
          ITERS: String(ITERS),
          AMOUNT: String(AMOUNT),
          CAP: String(CAP),
          START_AT: String(startAt),
        };
        const results = await Promise.all(Array.from({ length: WORKERS }, () => runWorker(SPEND_WORKER, env)));
        const totalAllowed = results.reduce((s, r) => s + r.allowed, 0);
        // The security invariant (INV-9): NEVER over-allow. Before the ACCT-07 fix this exceeded the
        // cap at depth (the ABA); `<=` is robust to benign under-allow from CAS-retry exhaustion,
        // while still failing loudly on any over-allow.
        expect(totalAllowed, `round ${round}: over-allow`).toBeLessThanOrEqual(EXPECT);
        expect(ledgerUnits(dir), `round ${round}: ledger over cap`).toBeLessThanOrEqual(EXPECT);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("highestVersion never under-reports the committed max under concurrent commit+cleanup (foundation)", async () => {
    // Large cap → every attempt commits, maximizing version churn while a separate prober process
    // samples load().version (== highestVersion()). The floor guard's correctness rests on this
    // never going backwards; a single decrease is a foundation violation.
    const COMMITTERS = 5;
    const ITERS = 60; // 300 commits of churn
    const dir = mkdtempSync(join(tmpdir(), "x402-mono-"));
    try {
      const startAt = Date.now() + 2500;
      const base = { LEDGER: join(dir, "ledger"), START_AT: String(startAt) };
      const committerEnv = {
        ...base,
        STORE: "cas",
        ITERS: String(ITERS),
        AMOUNT: String(AMOUNT),
        CAP: String(10_000_000_000n), // admits thousands → every attempt allows → maximal churn
      };
      const probe = runWorker(PROBE_WORKER, { ...base, SAMPLES: "400" });
      const committers = Array.from({ length: COMMITTERS }, () => runWorker(SPEND_WORKER, committerEnv));
      const [probeResult] = await Promise.all([probe, ...committers]);
      // The foundation: the prober watched the max under heavy concurrent commit+cleanup and it
      // never went backwards. If this is ever > 0, Option C's derived floor can be under-computed
      // and the fix is unsound — so this asserts the load-bearing claim mechanically.
      expect(probeResult.decreases, `prober saw version go backwards: ${JSON.stringify(probeResult.firstDecrease)}`).toBe(0);
      expect(probeResult.maxSeen, "prober should have observed real churn").toBeGreaterThan(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
