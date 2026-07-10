// Adapter: a durable, single-file spend store. Writes are atomic (write-temp +
// rename) so a crash mid-write cannot corrupt the ledger. bigints are serialized as
// decimal strings because JSON has no bigint. This is an edge module — filesystem
// I/O is expected here, not in the pure core.
import { readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { SpendStore } from "../accounting/guard.js";
import { emptyState, nullMap } from "../accounting/guard.js";
import type { SpendState, UnixSeconds } from "../types.js";

interface Serialized {
  spentByDomain: Record<string, Record<string, string>>;
  spentByAsset: Record<string, string>;
  windowStart: string;
  lastSeen: string;
}

function serialize(s: SpendState): string {
  const byDomain: Record<string, Record<string, string>> = {};
  for (const [domain, row] of Object.entries(s.spentByDomain)) {
    byDomain[domain] = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v.toString()]));
  }
  const byAsset = Object.fromEntries(Object.entries(s.spentByAsset).map(([k, v]) => [k, v.toString()]));
  const out: Serialized = {
    spentByDomain: byDomain,
    spentByAsset: byAsset,
    windowStart: s.windowStart.toString(),
    lastSeen: s.lastSeen.toString(),
  };
  return JSON.stringify(out);
}

function deserialize(text: string): SpendState {
  const raw = JSON.parse(text) as Serialized;
  // null-prototype maps so a persisted "__proto__" key is an ordinary key, never the prototype.
  const byDomain = nullMap<Record<string, bigint>>();
  for (const [domain, row] of Object.entries(raw.spentByDomain ?? {})) {
    const r = nullMap<bigint>();
    for (const [k, v] of Object.entries(row)) r[k] = BigInt(v);
    byDomain[domain] = r;
  }
  const byAsset = nullMap<bigint>();
  for (const [k, v] of Object.entries(raw.spentByAsset ?? {})) byAsset[k] = BigInt(v);
  return {
    spentByDomain: byDomain,
    spentByAsset: byAsset,
    windowStart: BigInt(raw.windowStart) as UnixSeconds,
    lastSeen: BigInt(raw.lastSeen) as UnixSeconds,
  };
}

export class FileSpendStore implements SpendStore {
  constructor(
    private readonly path: string,
    private readonly initialNow: UnixSeconds,
  ) {}

  async load(): Promise<SpendState> {
    if (!existsSync(this.path)) return emptyState(this.initialNow);
    return deserialize(readFileSync(this.path, "utf8"));
  }

  async save(state: SpendState): Promise<void> {
    // Atomic + durable: write to a UNIQUE temp file (so concurrent writers never clobber the
    // same temp), fsync it so the bytes hit disk, then rename over the target. A crash leaves
    // either the old ledger or the fully-written new one — never a truncated file.
    // NOTE: rename is atomic per-file but this store still has no CROSS-PROCESS lock; a shared
    // ledger across processes can lost-update (ACCT-05, open). Run one instance per wallet.
    const tmp = `${this.path}.tmp.${process.pid}.${randomUUID()}`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, serialize(state));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }
}
