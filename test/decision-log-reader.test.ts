import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HashChainDecisionLog } from "../src/audit/hash-chain-log.js";
import type { LogEntry } from "../src/audit/decision-log.js";
import { readDecisionLogAfter } from "../src/adapters/decision-log-reader.js";

const tmp = () => mkdtempSync(join(tmpdir(), "x402-reader-"));
const entry = (i: number): LogEntry => ({
  v: 1, at: String(1_000_000 + i), verdict: "allow", reason: "ok", detail: "d",
  origin: "weather.example", chain: "eip155:8453",
  asset: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", amount: String(1000 + i),
});

/** Write `n` real records (seq 0..n-1) through the actual log, so the reader is tested against
 *  genuine on-disk bytes, not a hand-forged shape. */
async function writeLog(path: string, n: number): Promise<void> {
  const log = new HashChainDecisionLog(path);
  for (let i = 0; i < n; i++) await log.append(entry(i));
}

describe("readDecisionLogAfter — the out-of-process cursor reader of the durable log", () => {
  it("reads records after a cursor, in seq order (cursor is strictly-greater-than)", async () => {
    const dir = tmp();
    try {
      const path = join(dir, "log");
      await writeLog(path, 5); // seq 0..4
      expect(readDecisionLogAfter(path, -1).map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
      expect(readDecisionLogAfter(path, 2).map((r) => r.seq)).toEqual([3, 4]);
      expect(readDecisionLogAfter(path, 4)).toEqual([]); // caught up — nothing new
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an absent log yields nothing (a reader running before the first decision)", () => {
    const dir = tmp();
    try {
      expect(readDecisionLogAfter(join(dir, "not-yet"), -1)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a partial trailing line (an in-flight append), never throws", async () => {
    const dir = tmp();
    try {
      const path = join(dir, "log");
      await writeLog(path, 3); // seq 0..2, complete + fsync'd
      // A writer mid-append leaves an unterminated, unparseable trailing line. The reader must read
      // the complete records and skip the torn tail, picking it up on a later poll once it completes.
      appendFileSync(path, '{"seq":3,"prev":"abc","ha');
      expect(readDecisionLogAfter(path, -1).map((r) => r.seq)).toEqual([0, 1, 2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on a corrupt NON-trailing line — fail-loud, never silently drop a decision", async () => {
    const dir = tmp();
    try {
      const path = join(dir, "log");
      await writeLog(path, 3);
      const ls = readFileSync(path, "utf8").split("\n").filter(Boolean);
      ls[1] = "{ this is not json"; // corrupt a MIDDLE line (real corruption, not an in-flight write)
      writeFileSync(path, ls.join("\n") + "\n");
      expect(() => readDecisionLogAfter(path, -1)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
