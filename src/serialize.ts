// Serialize a Snapshot into a portable, human-and-machine-safe EXPORT — the file the shipped
// dashboard reads (D-040: a dump-file the guard writes, never a socket it serves).
//
// THE WIRE FORMAT'S ONE HARD JOB: never let a downstream consumer silently corrupt money. JSON has no
// bigint, and a base-unit amount routinely exceeds 2^53 (1e18-scale is normal), so a naive
// `Number(amount)` would round it into a confident lie on screen. Two defenses, both by construction:
//  1. Money is a TAGGED ENVELOPE `{ "$b": "<base-units>", "text": "<human>" }`. A naive `JSON.parse`
//     yields an OBJECT, so `Number(record.amount)` is `NaN` (loudly broken) — never a silent wrong
//     number. A programmatic consumer recovers an exact bigint via `parseSnapshotExport` (the shipped
//     reviver), which uses `BigInt`, never `Number`.
//  2. `text` is PRE-RENDERED here, in trusted Node, by the >2^53-tested `renderAmount` — so the viewer
//     (D3) displays `text` and does NO money math at all, and therefore cannot be the thing that
//     corrupts. The reference consumer is safe by construction, not by discipline.
// Timestamps are plain JSON numbers (Unix seconds, safe-range forever) — enveloping them buys nothing.
//
// SENSITIVITY: the export is the MOST sensitive artifact the tool produces — full spend posture plus
// the counterparty graph (`byDomain[].origin`), materialized into a file DESIGNED TO BE MOVED. It is
// ledger-grade sensitive; `writeSnapshotExport` writes it `0o600` (PRIV-04). Redaction of the
// counterparty origin is an OPT-IN caller option (default lossless — never hide the owner's own data
// from the owner; mechanism-not-policy).
import type { Snapshot, AssetKey } from "./types.js";
import type { Display, DisplayInfo } from "./display.js";
import { renderMoneyText } from "./display.js";

/** Bump on any breaking shape change so a viewer can evolve against a known version. */
export const SNAPSHOT_EXPORT_VERSION = 1;

/** A money value on the wire: exact base units under `$b` (for programs, via the reviver) and a
 *  pre-rendered human string under `text` (for the viewer, which does no math). */
export interface Money {
  $b: string;
  text: string;
}

export interface SnapshotExport {
  version: number;
  now: number;
  halt: boolean;
  windowStart: number;
  windowSeconds: number;
  windowEndsAt: number | null;
  byDenomination: {
    key: string;
    spent: Money;
    remaining: Money | null;
    caps: { perRequest: Money | null; global: Money | null };
  }[];
  byDomain: {
    origin: string;
    byAsset: { key: string; spent: Money; perDomainCap: Money | null; remaining: Money | null }[];
  }[];
}

export interface SerializeOptions {
  /** Declared decimals/symbol per denomination — drives the `text` rendering (never enforcement). */
  display?: Display;
  /** OPT-IN redaction of the counterparty origin. Default identity (lossless). A caller who exports
   *  to a less-trusted place can pass a hash/bucket/drop; the mechanism forms no opinion. */
  redactOrigin?: (origin: string) => string;
}

const money = (amount: bigint, info?: DisplayInfo): Money => ({ $b: amount.toString(), text: renderMoneyText(amount, info) });
const orNull = (a: bigint | null, info?: DisplayInfo): Money | null => (a === null ? null : money(a, info));
const ts = (v: bigint): number => Number(v); // Unix seconds — safe-integer range, plain number by design

/** Serialize a Snapshot into a portable, corruption-resistant export. Pure; no I/O. */
export function serializeSnapshot(snapshot: Snapshot, opts: SerializeOptions = {}): SnapshotExport {
  const display = opts.display;
  const redact = opts.redactOrigin ?? ((o) => o);
  const info = (key: string): DisplayInfo | undefined => display?.[key as AssetKey];
  return {
    version: SNAPSHOT_EXPORT_VERSION,
    now: ts(snapshot.now),
    halt: snapshot.halt,
    windowStart: ts(snapshot.windowStart),
    windowSeconds: ts(snapshot.windowSeconds),
    windowEndsAt: snapshot.windowEndsAt === null ? null : ts(snapshot.windowEndsAt),
    byDenomination: snapshot.byDenomination.map((d) => ({
      key: d.key,
      spent: money(d.spent, info(d.key)),
      remaining: orNull(d.remaining, info(d.key)),
      caps: { perRequest: orNull(d.caps.perRequest, info(d.key)), global: orNull(d.caps.global, info(d.key)) },
    })),
    byDomain: snapshot.byDomain.map((dom) => ({
      origin: redact(dom.origin),
      byAsset: dom.byAsset.map((a) => ({
        key: a.key,
        spent: money(a.spent, info(a.key)),
        perDomainCap: orNull(a.perDomainCap, info(a.key)),
        remaining: orNull(a.remaining, info(a.key)),
      })),
    })),
  };
}

/**
 * Parse an export back, recovering EXACT `bigint`s from the money envelopes — the shipped reviver, so
 * a programmatic consumer never has to (and never should) touch `Number()` on an amount. Money
 * `{ "$b": "…" }` objects become `bigint`; everything else is unchanged. Returns the revived tree
 * (money fields are `bigint`, so the runtime shape differs from `SnapshotExport` by design).
 */
export function parseSnapshotExport(json: string): unknown {
  return JSON.parse(json, (_key, value: unknown) => {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).$b === "string" &&
      /^[0-9]+$/.test((value as Record<string, string>).$b)
    ) {
      return BigInt((value as Record<string, string>).$b);
    }
    return value;
  });
}

/**
 * Write an export to `path`, owner-only. The file is ledger-grade sensitive (PRIV-04), so it is
 * created `0o600`; the write is atomic (temp + rename) so EVERY write lands owner-only regardless of
 * any prior file's mode. Overwrites a previous dump (a snapshot is regenerable, point-in-time).
 */
export async function writeSnapshotExport(path: string, snapshotExport: SnapshotExport): Promise<void> {
  const { writeFile, rename } = await import("node:fs/promises");
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(snapshotExport, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}
