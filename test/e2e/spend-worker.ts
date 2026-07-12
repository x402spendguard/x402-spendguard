// One WORKER PROCESS in the cross-process smoke test (cross-process-smoke.e2e.test.ts).
//
// The parent spawns several of these as GENUINELY SEPARATE OS processes (via the vite-node bin,
// so a child can import TS from src/ directly). Each builds its OWN FileSpendStore + SpendGuard
// over the SHARED on-disk ledger and hammers authorize() with ITERS identical payments, then
// prints exactly one `RESULT {allowed,denied}` line. The parent aggregates every worker's tally.
//
// This is what the in-process "two guards, one MemStore" test cannot prove: that the REAL
// file store's OS-atomic compare-and-swap holds under real inter-process contention (ACCT-05).
//
// STORE=cas   → the real FileSpendStore (the thing under test).
// STORE=unsafe→ a deliberately NON-atomic last-write-wins store, used ONLY by the opt-in teeth
//               case to show the SAME harness catches the lost-update bug the CAS store prevents.
import { writeFileSync, readFileSync } from "node:fs";
import { SpendGuard, emptyState } from "../../src/accounting/guard.js";
import type { Clock, SpendStore, Version } from "../../src/accounting/guard.js";
import { FileSpendStore } from "../../src/adapters/file-spend-store.js";
import { ev, A, policy, caps, NOW } from "../helpers.js";
import type { SpendState } from "../../src/types.js";

const LEDGER = must("LEDGER");
const STORE = process.env.STORE ?? "cas";
const ITERS = Number(must("ITERS"));
const AMOUNT = BigInt(must("AMOUNT"));
const CAP = BigInt(must("CAP"));
const START_AT = Number(process.env.START_AT ?? 0);

function must(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`spend-worker: missing env ${name}`);
  return v;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// bigint-aware (de)serialization for the UNSAFE store only. The real FileSpendStore owns its own
// (correct) format; the unsafe path is self-contained and never shares files with a cas run.
const ser = (s: SpendState) => JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
const deser = (t: string): SpendState =>
  JSON.parse(t, (_k, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));

/**
 * The lost-update bug on purpose (pre-ACCT-05 behavior): load current state, and on save just
 * OVERWRITE a single JSON file and always report success — no exclusive-create, no version check.
 * A short gap between load and save widens the window so concurrent workers reliably read the same
 * stale total and clobber each other's writes, letting more than the cap's worth of payments pass.
 */
class UnsafeStore implements SpendStore {
  constructor(private readonly path: string) {}
  async load(): Promise<{ state: SpendState; version: Version }> {
    let state: SpendState;
    try {
      state = deser(readFileSync(this.path, "utf8"));
    } catch {
      state = emptyState(NOW);
    }
    return { state, version: "0" as Version };
  }
  async compareAndSave(_expected: Version, next: SpendState): Promise<boolean> {
    await sleep(8); // widen the load→save race window; last-write-wins clobbers concurrent commits
    writeFileSync(this.path, ser(next), "utf8");
    return true; // never reports a conflict → the guard never retries → both writers "win"
  }
  async verifyAtomicity(): Promise<void> {
    /* the unsafe store makes no atomicity claim — that is the whole point */
  }
}

async function main(): Promise<void> {
  const pol = policy({ caps: caps({ perRequest: A(CAP), perDomain: A(CAP), global: A(CAP) }) });
  const clock: Clock = { now: () => NOW }; // fixed logical time: windows never roll, fully deterministic
  const store: SpendStore = STORE === "unsafe" ? new UnsafeStore(`${LEDGER}.unsafe`) : new FileSpendStore(LEDGER, NOW);
  // High CAS bound: liveness-only (exhaustion always DENIES, never over-allows), so a generous
  // bound lets the cap fill to exactly CAP under contention without spurious contention-denies.
  const guard = new SpendGuard(store, clock, pol, 200);
  const payment = ev({ amount: A(AMOUNT) }, { value: A(AMOUNT) });

  // Barrier: all workers begin the loop at the same wall-clock instant, so the race is real.
  while (Date.now() < START_AT) await sleep(5);

  let allowed = 0;
  let denied = 0;
  for (let i = 0; i < ITERS; i++) {
    const d = await guard.authorize(payment);
    if (d.verdict === "allow") allowed++;
    else denied++;
  }
  process.stdout.write(`RESULT ${JSON.stringify({ allowed, denied })}\n`);
}

main().catch((e) => {
  process.stderr.write(`spend-worker failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
