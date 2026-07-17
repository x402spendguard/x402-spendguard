import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoggingGuard } from "../src/audit/decision-log.js";
import type { DecisionLog, LogEntry } from "../src/audit/decision-log.js";
import { HashChainDecisionLog, GENESIS_PREV } from "../src/audit/hash-chain-log.js";
import type { ChainedRecord } from "../src/audit/hash-chain-log.js";
import { sha256ChainHasher, hmacChainHasher } from "../src/audit/chain-hasher.js";
import type { Clock } from "../src/accounting/guard.js";
import type { PolicyDecision, UnixSeconds } from "../src/types.js";
import { ev as makeEv } from "./helpers.js";

const tmp = () => mkdtempSync(join(tmpdir(), "x402-audit-"));
const entry = (i: number): LogEntry => ({
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
const lines = (path: string): string[] => readFileSync(path, "utf8").split("\n").filter(Boolean);
const records = (path: string): ChainedRecord[] => lines(path).map((l) => JSON.parse(l) as ChainedRecord);

describe("decision-log hash chain (AUDIT-01: tamper-evidence)", () => {
  it("chain-detects-tamper", async () => {
    const dir = tmp();
    try {
      const path = join(dir, "log");
      const log = new HashChainDecisionLog(path);
      for (let i = 0; i < 5; i++) await log.append(entry(i));
      // Naive tamper: change a middle record's entry on disk, WITHOUT recomputing its hash.
      const ls = lines(path);
      const rec = JSON.parse(ls[2]) as ChainedRecord;
      rec.entry.amount = "999999";
      ls[2] = JSON.stringify(rec);
      writeFileSync(path, ls.join("\n") + "\n");
      const r = await new HashChainDecisionLog(path).verify();
      expect(r.ok).toBe(false);
      expect(r.brokenAt).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // CHENG's rewrite attack, pinned as by-design: unkeyed self-verify CANNOT catch a full
  // self-consistent rewrite (public hash → attacker recomputes forward); an external anchor CAN.
  it("verify-is-anchor-relative", async () => {
    const dir = tmp();
    try {
      const path = join(dir, "log");
      const log = new HashChainDecisionLog(path);
      for (let i = 0; i < 4; i++) await log.append(entry(i));
      const originalHead = (await new HashChainDecisionLog(path).verify()).head;

      // Attacker rewrites the WHOLE log (zeroed amounts), recomputing every hash with public SHA-256.
      let prev = GENESIS_PREV;
      const rewritten = [0, 1, 2, 3].map((seq) => {
        const e = { ...entry(seq), amount: "0" };
        const hash = sha256ChainHasher.hash({ seq, prev, entry: e });
        const rec: ChainedRecord = { seq, prev, hash, alg: "sha256", entry: e };
        prev = hash;
        return JSON.stringify(rec);
      });
      writeFileSync(path, rewritten.join("\n") + "\n");
      const fresh = new HashChainDecisionLog(path);

      // Self-verify PASSES — the honest limit, pinned so nobody files it as a bug or claims it's caught.
      expect((await fresh.verify()).ok).toBe(true);
      // Anchored verify CATCHES it (rewritten head != the externally pinned original head).
      const anchored = await fresh.verify({ expectedHead: originalHead });
      expect(anchored.ok).toBe(false);
      expect(anchored.reason).toMatch(/head/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("decision-log hash chain (AUDIT-02: keyed seam)", () => {
  it("keyed-chain-detects-forgery", async () => {
    const dir = tmp();
    try {
      const path = join(dir, "log");
      const key = "operator-held-secret";
      const log = new HashChainDecisionLog(path, hmacChainHasher(key));
      for (let i = 0; i < 4; i++) await log.append(entry(i));
      // Attacker (no key) edits an entry; they cannot forge a valid HMAC for it.
      const ls = lines(path);
      const rec = JSON.parse(ls[1]) as ChainedRecord;
      rec.entry.amount = "0";
      ls[1] = JSON.stringify(rec);
      writeFileSync(path, ls.join("\n") + "\n");
      // Keyed self-verify detects it WITHOUT an external anchor (forgery-resistant).
      const r = await new HashChainDecisionLog(path, hmacChainHasher(key)).verify();
      expect(r.ok).toBe(false);
      expect(r.brokenAt).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("decision-log hash chain (AUDIT-03: fail-loud, forensic-not-enforcement)", () => {
  it("audit-failure-surfaced-not-swallowed", async () => {
    const failures: unknown[] = [];
    const failingLog: DecisionLog = {
      append: async () => {
        throw new Error("disk full");
      },
    };
    const inner = { authorize: async (): Promise<PolicyDecision> => ({ verdict: "allow", reason: "ok", detail: "" }) };
    const clock: Clock = { now: () => 1_000_000n as UnixSeconds };
    const guard = new LoggingGuard(inner, failingLog, clock, (err) => failures.push(err));

    const decision = await guard.authorize(makeEv());
    expect(decision.verdict).toBe("allow"); // verdict preserved despite the audit failure (FAIL-03)
    expect(failures).toHaveLength(1); // …but the failure is SURFACED, not silently swallowed
  });

  // CHENG's torn-head attack: a crash mid-write leaves a torn head; recovery must fail loud AND the
  // discontinuity must be VISIBLE in verify() — not a silent clean slate that hides a truncation.
  it("torn-head-fails-loud", async () => {
    const dir = tmp();
    try {
      const path = join(dir, "log");
      const log = new HashChainDecisionLog(path);
      for (let i = 0; i < 3; i++) await log.append(entry(i));
      appendFileSync(path, '{"seq":3,"prev":"'); // torn partial line, no newline (crash mid-write)

      const failures: unknown[] = [];
      const restarted = new HashChainDecisionLog(path, sha256ChainHasher, (e) => failures.push(e));
      await restarted.append(entry(99)); // keep logging (enforcement never blocked)

      expect(failures.length).toBeGreaterThan(0); // (a) the torn head surfaced loud, not silently chained
      const r = await restarted.verify();
      expect(r.ok).toBe(false); // (b) the discontinuity is VISIBLE — recovery is not a clean slate
      expect(r.brokenAt).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // CHENG's race: genuinely OVERLAP the appends (fire all, then await) — a broken/absent serialization
  // would let two appends read the same head → duplicate seq → forked chain. Sync append must not.
  it("concurrent-appends-linear-chain", async () => {
    const dir = tmp();
    try {
      const path = join(dir, "log");
      const log = new HashChainDecisionLog(path);
      await Promise.all(Array.from({ length: 20 }, (_, i) => log.append(entry(i))));

      const recs = records(path).sort((a, b) => a.seq - b.seq);
      expect(recs.map((r) => r.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i)); // no dup/missing seq
      for (let i = 1; i < recs.length; i++) expect(recs[i].prev).toBe(recs[i - 1].hash); // linear linkage
      expect((await new HashChainDecisionLog(path).verify()).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
