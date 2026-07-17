// A tamper-EVIDENT decision log (AUDIT-01..03): an append-only JSON-Lines chain where each record
// commits to (seq, prior hash, entry) via an injected ChainHasher. Detection, not prevention — and
// per FAIL-03 its integrity is forensic, never enforcement, so a broken chain surfaces loudly and
// NEVER gates a payment. See REQUIREMENTS.md AUDIT-* and THREAT_MODEL §3.
//
// Concurrency: in-process appends are atomic by synchronous single-threaded execution (the append
// body has no `await`), so overlapped appends serialize into a linear chain — no mutex. A
// cross-process fork (two processes, one file) is DETECTED by verify(), not silently merged;
// CAS-for-the-log is a fast-follow. Rotation is a fast-follow too.
import { openSync, writeSync, fsyncSync, closeSync, readFileSync } from "node:fs";
import type { DecisionLog, LogEntry } from "./decision-log.js";
import type { ChainHasher } from "./chain-hasher.js";
import { sha256ChainHasher } from "./chain-hasher.js";

/** The `prev` of a genesis record — a fresh chain start. A genesis at seq>0 is a visible discontinuity. */
export const GENESIS_PREV = "genesis";

/** One on-disk chained record. `entry` is the PRIV-02-clean LogEntry; the rest is chain metadata. */
export interface ChainedRecord {
  seq: number;
  prev: string;
  hash: string;
  alg: string;
  entry: LogEntry;
}

export interface VerifyResult {
  ok: boolean;
  /** The chain's computed head hash — pin this externally to catch truncation / full rewrite later. */
  head: string;
  /** The seq (0-based position) where verification first failed, if any. */
  brokenAt?: number;
  reason?: string;
}

export class HashChainDecisionLog implements DecisionLog {
  private seq = 0;
  private head = GENESIS_PREV;
  private loaded = false;
  /** Set when load() found a torn tail: the next append writes a leading newline to close the
   *  partial line, so the recovery record lands on its own line (the torn line stays as a scar). */
  private tornRecovery = false;

  constructor(
    private readonly path: string,
    private readonly hasher: ChainHasher = sha256ChainHasher,
    /** Surfaced (never thrown) on an audit-integrity failure — a bad append or a torn head at boot. */
    private readonly onAuditFailure?: (err: unknown) => void,
  ) {}

  /** Load seq+head from the existing log so the chain continues across restarts. On a TORN tail
   *  (a partial line from a crash mid-append) this surfaces LOUD and prepares a fresh-genesis restart
   *  whose discontinuity is visible in verify() — it never silently chains off broken state. */
  private load(): void {
    this.loaded = true;
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      this.seq = 0; // no log yet → fresh genesis
      this.head = GENESIS_PREV;
      return;
    }
    const rows = raw.split("\n").filter((l) => l.length > 0);
    if (rows.length === 0) {
      this.seq = 0;
      this.head = GENESIS_PREV;
      return;
    }
    try {
      const last = JSON.parse(rows[rows.length - 1]) as ChainedRecord;
      this.head = last.hash; // clean restart: continue the chain
      this.seq = last.seq + 1;
    } catch {
      // TORN HEAD: the last record is unparseable (crash mid-write; fsync can't stop process death).
      // Fail LOUD and restart as a fresh genesis — the torn line stays on disk as a visible scar, so
      // verify() reports the discontinuity rather than presenting an unbroken (attacker-friendly) log.
      this.onAuditFailure?.(
        new Error(
          "audit.torn_head: last log record is unparseable; starting a new chain segment " +
            "(the discontinuity remains visible in verify())",
        ),
      );
      this.head = GENESIS_PREV;
      this.seq = rows.length;
      this.tornRecovery = true;
    }
  }

  async append(entry: LogEntry): Promise<void> {
    if (!this.loaded) this.load();
    const seq = this.seq;
    const prev = this.head;
    const hash = this.hasher.hash({ seq, prev, entry });
    const record: ChainedRecord = { seq, prev, hash, alg: this.hasher.algorithm, entry };
    const fd = openSync(this.path, "a", 0o600); // append-only, owner-private (mirrors FileDecisionLog)
    try {
      // A leading newline after a torn tail closes the partial line so this record is on its own line.
      writeSync(fd, (this.tornRecovery ? "\n" : "") + JSON.stringify(record) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.tornRecovery = false;
    this.head = hash;
    this.seq = seq + 1;
  }

  /**
   * Walk the on-disk chain and report whether it is intact. Anchor-relative (AUDIT-01): with no
   * `expectedHead`, self-verification catches non-adversarial corruption and naive edits but NOT a
   * full self-consistent (unkeyed) rewrite — pass a pinned `expectedHead`, or use a keyed hasher.
   */
  async verify(opts?: { expectedHead?: string }): Promise<VerifyResult> {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err) {
      const head = GENESIS_PREV; // an absent log is a vacuously-intact empty chain
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return this.finalize(head, opts);
      return { ok: false, head, reason: `unreadable: ${(err as Error).message}` };
    }
    const rows = raw.split("\n").filter((l) => l.length > 0);
    let prev = GENESIS_PREV;
    let head = GENESIS_PREV;
    for (let i = 0; i < rows.length; i++) {
      let rec: ChainedRecord;
      try {
        rec = JSON.parse(rows[i]) as ChainedRecord;
      } catch {
        return { ok: false, head, brokenAt: i, reason: "unparseable record (torn or corrupt line)" };
      }
      if (rec.seq !== i) return { ok: false, head, brokenAt: i, reason: `seq gap: expected ${i}, got ${rec.seq}` };
      if (rec.prev !== prev) {
        // A genesis (prev === GENESIS_PREV) is legitimate only at position 0; anywhere else it is a
        // deliberate-looking chain reset (e.g. a torn-head recovery) — reported as a discontinuity.
        const why =
          rec.prev === GENESIS_PREV ? "unexpected genesis (chain reset / discontinuity)" : "broken link (prev mismatch)";
        return { ok: false, head, brokenAt: i, reason: why };
      }
      if (this.hasher.hash({ seq: rec.seq, prev: rec.prev, entry: rec.entry }) !== rec.hash) {
        return { ok: false, head, brokenAt: i, reason: "hash mismatch (record tampered)" };
      }
      prev = rec.hash;
      head = rec.hash;
    }
    return this.finalize(head, opts);
  }

  /** Apply the external-anchor check: an `expectedHead` mismatch catches truncation / full rewrite. */
  private finalize(head: string, opts?: { expectedHead?: string }): VerifyResult {
    if (opts?.expectedHead !== undefined && opts.expectedHead !== head) {
      return { ok: false, head, reason: "head mismatch (truncation or full rewrite)" };
    }
    return { ok: true, head };
  }
}
