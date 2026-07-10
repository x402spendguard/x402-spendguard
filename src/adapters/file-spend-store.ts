// Adapter: a durable, single-file spend store. Writes are atomic (write-temp +
// rename) so a crash mid-write cannot corrupt the ledger. bigints are serialized as
// decimal strings because JSON has no bigint. This is an edge module — filesystem
// I/O is expected here, not in the pure core.
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import type { SpendStore } from "../accounting/guard.js";
import { emptyState } from "../accounting/guard.js";
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
  const byDomain: Record<string, Record<string, bigint>> = {};
  for (const [domain, row] of Object.entries(raw.spentByDomain ?? {})) {
    byDomain[domain] = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, BigInt(v)]));
  }
  const byAsset: Record<string, bigint> = Object.fromEntries(
    Object.entries(raw.spentByAsset ?? {}).map(([k, v]) => [k, BigInt(v)]),
  );
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
    // Atomic: write to a temp file then rename over the target. A crash leaves either
    // the old ledger or the new one intact — never a half-written file.
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, serialize(state), "utf8");
    renameSync(tmp, this.path);
  }
}
