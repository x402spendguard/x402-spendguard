// Adapter: a durable, append-only decision log as JSON Lines (one JSON object per line).
// This is the persisted seam a future viewer/dashboard reads. Append-only + fsync means a
// record, once written, survives a crash; JSONL means a reader can tail it line by line
// without parsing the whole file. Filesystem I/O belongs here at the edge, not in the core.
import { openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import type { DecisionLog, LogEntry } from "../audit/decision-log.js";

export class FileDecisionLog implements DecisionLog {
  constructor(private readonly path: string) {}

  async append(entry: LogEntry): Promise<void> {
    // O_APPEND: each write lands at end-of-file; fsync so the record is durable before we
    // return (the caller has already made the decision — this only records it). One line
    // per entry keeps the log append-only and cheap to tail.
    const line = JSON.stringify(entry) + "\n";
    const fd = openSync(this.path, "a");
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
