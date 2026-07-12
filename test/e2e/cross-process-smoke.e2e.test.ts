// CROSS-PROCESS SMOKE TEST (ACCT-05 honesty gate) — the real thing the in-process
// "two guards, one MemStore" unit test cannot prove.
//
// We spawn several GENUINELY SEPARATE OS processes (spend-worker.ts, one per process, via the
// vite-node bin), each with its OWN FileSpendStore + SpendGuard, all racing on ONE shared on-disk
// ledger. With a global cap sized to admit exactly N payments and far more demand than that, the
// real OS-atomic compare-and-swap must let EXACTLY N through — never more (the drain the
// pre-CAS lost-update bug would cause) — and the durable ledger must reflect exactly what was
// allowed (no clobbered writes). This is the gate before softening the README's "one instance
// per wallet" claim: cross-process integrity, proven across real processes on a real disk.
//
// Hermetic: a local temp dir, no network, no funds. Runs under the opt-in e2e gate.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileSpendStore } from "../../src/adapters/file-spend-store.js";
import { NOW, key } from "../helpers.js";

const WORKERS = 4;
const ITERS = 25; // 4 × 25 = 100 attempts of demand …
const AMOUNT = 1_000_000n; // 1 USDC (6 decimals)
const CAP = 10_000_000n; // … competing for a cap that admits exactly 10 (strict `>` in the engine)
const EXPECT_ALLOWED = Number(CAP / AMOUNT); // 10

const VITE_NODE = join(process.cwd(), "node_modules", ".bin", "vite-node");
const WORKER = fileURLToPath(new URL("./spend-worker.ts", import.meta.url));

interface Tally {
  allowed: number;
  denied: number;
}

/** Run one worker as a real child process; resolve its parsed RESULT line, reject on nonzero exit. */
function runWorker(env: Record<string, string>): Promise<Tally> {
  return new Promise((resolve, reject) => {
    const child = spawn(VITE_NODE, [WORKER], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      const m = out.match(/^RESULT (.+)$/m);
      if (code !== 0 || !m) {
        reject(new Error(`worker exited ${code}; no RESULT.\n--- stderr ---\n${err}\n--- stdout ---\n${out}`));
        return;
      }
      resolve(JSON.parse(m[1]) as Tally);
    });
  });
}

/** Spawn all workers to start their loop at the same wall-clock instant (a real, overlapping race). */
async function race(dir: string, store: "cas" | "unsafe"): Promise<Tally[]> {
  const ledger = join(dir, "ledger");
  const startAt = Date.now() + 3000; // headroom for every vite-node child to boot before the barrier
  const env = {
    LEDGER: ledger,
    STORE: store,
    ITERS: String(ITERS),
    AMOUNT: String(AMOUNT),
    CAP: String(CAP),
    START_AT: String(startAt),
  };
  return Promise.all(Array.from({ length: WORKERS }, () => runWorker(env)));
}

const sum = (rs: Tally[], k: keyof Tally) => rs.reduce((s, r) => s + r[k], 0);

describe("cross-process spend integrity (ACCT-05, real separate processes)", () => {
  it("N processes racing on one FileSpendStore admit EXACTLY the cap, and the ledger records every allow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-smoke-cas-"));
    try {
      const results = await race(dir, "cas");
      const totalAllowed = sum(results, "allowed");
      const totalDenied = sum(results, "denied");

      // The invariant: never over-allow. With demand far exceeding the cap, exactly the cap's
      // worth of payments pass — the pre-CAS lost update would let MORE than this through.
      expect(totalAllowed).toBe(EXPECT_ALLOWED);
      // Every attempt resolved to a verdict (authorize never throws — fail-closed).
      expect(totalAllowed + totalDenied).toBe(WORKERS * ITERS);

      // The durable ledger reflects EXACTLY what was allowed — no clobbered writes (the direct
      // no-lost-update assertion). Equals the cap because the cap was filled to the brim.
      const { state } = await new FileSpendStore(join(dir, "ledger"), NOW).load();
      expect(state.spentByAsset[key]).toBe(BigInt(totalAllowed) * AMOUNT);
      expect(state.spentByAsset[key]).toBe(CAP);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // TEETH: prove the harness above is not vacuous — the SAME setup, pointed at a deliberately
  // non-atomic last-write-wins store, OVER-allows. If this ever stopped over-allowing, the
  // honesty-gate test could be passing for the wrong reason (a rotted spawn/barrier/race).
  //
  // skipIf keeps it OFF for local `npm run test:e2e` (fast, deterministic); CI turns it on via
  // SMOKE_TEETH=1 so the gate's non-vacuousness is machine-verified on every push. `retry` absorbs
  // the timing tail: cross-process scheduling makes the *degree* of over-allow variable, but the
  // *direction* (over-allow > cap) is robust with the 8ms unsafe-store window + barrier — so a
  // retry only ever papers over jitter, never a real regression (a broken harness fails all 3).
  describe.skipIf(!process.env.SMOKE_TEETH)("teeth — a non-CAS store lets the drain through", () => {
    it("last-write-wins store over-allows beyond the cap (the bug ACCT-05 closes)", { retry: 3 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), "x402-smoke-unsafe-"));
      try {
        const results = await race(dir, "unsafe");
        const totalAllowed = sum(results, "allowed");
        // The lost update: concurrent workers read the same stale total and clobber each other,
        // so MORE than the cap's worth of payments are admitted. That is the drain, reproduced.
        expect(totalAllowed).toBeGreaterThan(EXPECT_ALLOWED);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
