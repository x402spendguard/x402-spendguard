// The out-of-process consumption seam. The guard writes the decision log synchronously (write-ahead,
// on the payment path — `returned ⟹ recorded`); a SEPARATE reader consumes it here, never on the
// payment path, so it can be arbitrarily slow without ever adding latency to a decision. The durable
// log IS the buffer: a reader tracks a cursor (the record's monotonic `seq`), resumes across restarts,
// and can fall behind and catch up — nothing is buffered in memory, nothing is dropped, no overflow to
// bound. This is D-036's designed consumption point (the same seam a dashboard reads), read as a stream.
//
// Reads are NON-DESTRUCTIVE and cursors live with the reader (not in the log), so any number of
// readers fan out over the same log without contention — every reader sees every record. A reader
// never mutates the log; the tamper-evident chain makes that the same invariant as integrity.
//
// It uses `node:fs` (reads a local file) — no network, so the no-egress proof over src/ holds; the
// SENDING of a notification is the operator-wired notifier's job, outside src/, never the core's.
import { readFileSync } from "node:fs";
import type { ChainedRecord } from "../audit/hash-chain-log.js";

/**
 * Read decision-log records with `seq` strictly greater than `afterSeq`, in chain order. Pass
 * `afterSeq = -1` (or any value below the first seq) to read from the start; pass the last seq you
 * processed to read only what's new. An absent log yields `[]` (a reader running before the first
 * decision). A partial/unparseable TRAILING line — a writer mid-append — is skipped (picked up on a
 * later read once complete), mirroring the log's own torn-tail discipline; a non-trailing unparseable
 * line is real corruption and throws (fail-loud — a reader must not silently drop a recorded decision;
 * `HashChainDecisionLog.verify()` remains the authority on chain integrity).
 *
 * Reads the whole file per call and filters by `seq`. Correct and simple for payment-decision volumes
 * (bounded further by log rotation); a byte-offset incremental read is a later optimization if needed.
 */
export function readDecisionLogAfter(path: string, afterSeq: number): ChainedRecord[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; // no log written yet
    throw err;
  }
  const rows = raw.split("\n").filter((l) => l.length > 0);
  const out: ChainedRecord[] = [];
  for (let i = 0; i < rows.length; i++) {
    let record: ChainedRecord;
    try {
      record = JSON.parse(rows[i]) as ChainedRecord;
    } catch {
      // Only the LAST line may be a torn/in-flight append — skip it and stop; anything earlier is
      // real corruption in an append-only log, so fail loud rather than silently skip a decision.
      if (i === rows.length - 1) break;
      throw new Error(`decision-log-reader: unparseable record at line ${i} (not the trailing line) in ${path}`);
    }
    if (record.seq > afterSeq) out.push(record);
  }
  return out;
}
