// FOUNDATION probe for ACCT-07 (TEST_PLAN §9). Option C's floor guard rests entirely on one claim:
// `highestVersion()` never UNDER-reports the committed max under concurrent commit+cleanup (if it
// did, the derived floor would be too low and a stale writer could slip through). This worker is a
// separate OS process that hammers `load()` — whose returned `version` IS `highestVersion()` — while
// committer processes churn the ledger, and reports whether it ever observed the version go
// BACKWARDS. A decrease is a foundation violation (committed versions never un-commit; cleanup only
// removes the OLDEST, never the max). Prints exactly one RESULT line the parent aggregates.
import { FileSpendStore } from "../../src/adapters/file-spend-store.js";
import { NOW } from "../helpers.js";

const LEDGER = must("LEDGER");
const SAMPLES = Number(must("SAMPLES"));
const START_AT = Number(process.env.START_AT ?? 0);
// Pace sampling so the prober's lifetime OVERLAPS the fsync-heavy committers — otherwise it burns
// through every sample on the still-empty ledger before a single commit lands (maxSeen would be 0).
const INTERVAL_MS = Number(process.env.PROBE_INTERVAL_MS ?? 8);

function must(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`probe-worker: missing env ${name}`);
  return v;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const store = new FileSpendStore(LEDGER, NOW);
  while (Date.now() < START_AT) await sleep(5);

  let prev = -1;
  let maxSeen = 0;
  let decreases = 0;
  let firstDecrease: { from: number; to: number } | null = null;
  for (let i = 0; i < SAMPLES; i++) {
    const v = Number((await store.load()).version);
    if (v < prev) {
      decreases++;
      if (!firstDecrease) firstDecrease = { from: prev, to: v };
    }
    if (v > maxSeen) maxSeen = v;
    prev = v;
    if (INTERVAL_MS > 0) await sleep(INTERVAL_MS);
  }
  process.stdout.write(`RESULT ${JSON.stringify({ samples: SAMPLES, decreases, maxSeen, firstDecrease })}\n`);
}

main().catch((e) => {
  process.stderr.write(`probe-worker failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
