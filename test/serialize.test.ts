import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeSnapshot, parseSnapshotExport, writeSnapshotExport, type SnapshotExport } from "../src/serialize.js";
import { renderAmount, type Display } from "../src/display.js";
import { key } from "./helpers.js";
import type { Snapshot, Amount, UnixSeconds, AssetKey } from "../src/types.js";

const BIG = 9_007_199_254_740_993n; // 2^53 + 1 — a Number() would round this; a bigint won't

function snap(): Snapshot {
  return {
    now: 1_000_000n as UnixSeconds,
    halt: false,
    windowStart: 900_000n as UnixSeconds,
    windowSeconds: 86_400n as UnixSeconds,
    windowEndsAt: 986_400n as UnixSeconds,
    byDenomination: [
      { key, spent: BIG as Amount, remaining: 5n as Amount, caps: { perRequest: 1_000_000n as Amount, global: 20_000_000n as Amount } },
    ],
    byDomain: [
      { origin: "shop.example", byAsset: [{ key, spent: BIG as Amount, perDomainCap: 5_000_000n as Amount, remaining: 3n as Amount }] },
    ],
  };
}

const display: Display = { [key as AssetKey]: { decimals: 6, symbol: "USDC" } };

describe("snapshot export — the wire format the dashboard reads (EXPORT-01)", () => {
  it("export-is-lossless-and-corruption-loud", () => {
    const json = JSON.stringify(serializeSnapshot(snap(), { display }));

    // 1. NAIVE parse cannot silently corrupt: money is an OBJECT, so Number() is NaN (loud), never a
    //    rounded >2^53 lie. This is the whole point of the tagged envelope.
    const naive = JSON.parse(json);
    const spent = naive.byDenomination[0].spent;
    expect(typeof spent).toBe("object");
    expect(Number.isNaN(Number(spent))).toBe(true); // Number({$b,text}) → NaN, not a wrong number

    // 2. The reviver recovers the EXACT bigint (past 2^53), via BigInt, never Number.
    const revived = parseSnapshotExport(json) as { byDenomination: { spent: bigint }[]; byDomain: { byAsset: { spent: bigint }[] }[] };
    expect(revived.byDenomination[0].spent).toBe(BIG);
    expect(revived.byDomain[0].byAsset[0].spent).toBe(BIG);

    // 3. The pre-rendered `text` agrees exactly with the raw value (what the math-free viewer displays).
    expect(naive.byDenomination[0].spent.text).toBe(`${renderAmount(BIG, 6)} USDC`);
    expect(naive.byDenomination[0].spent.$b).toBe(BIG.toString());

    // 4. Timestamps are plain numbers (safe range), not envelopes.
    expect(naive.now).toBe(1_000_000);
    expect(typeof naive.windowSeconds).toBe("number");
  });

  it("export-handles-null-caps-and-no-display", () => {
    const s = snap();
    s.byDenomination[0].remaining = null;
    s.byDenomination[0].caps.global = null;
    const ex = serializeSnapshot(s); // no display → text degrades to grouped base units, never a guess
    expect(ex.byDenomination[0].remaining).toBeNull();
    expect(ex.byDenomination[0].caps.global).toBeNull();
    expect(ex.byDenomination[0].spent.text).toBe("9,007,199,254,740,993 base units");
  });

  // EXPORT-03 — redaction is an OPT-IN caller option; the default is lossless (don't hide the owner's
  // own data from the owner). The counterparty origin is the redaction target.
  it("export-redaction-is-opt-in", () => {
    const lossless = serializeSnapshot(snap(), { display });
    expect(lossless.byDomain[0].origin).toBe("shop.example"); // default: verbatim

    const redacted = serializeSnapshot(snap(), { display, redactOrigin: () => "[redacted]" });
    expect(redacted.byDomain[0].origin).toBe("[redacted]");
    // redaction touches only the counterparty field; the money is untouched
    expect(redacted.byDomain[0].byAsset[0].spent.$b).toBe(BIG.toString());
  });
});

describe("writeSnapshotExport — the dumped file is ledger-grade sensitive (EXPORT-02)", () => {
  it("export-file-is-owner-only", async (ctx) => {
    const dir = mkdtempSync(join(tmpdir(), "x402-export-"));
    try {
      const path = join(dir, "snapshot.json");
      const ex: SnapshotExport = serializeSnapshot(snap(), { display });
      await writeSnapshotExport(path, ex);

      // POSIX: owner-only 0o600 (the export carries the counterparty graph). Windows ignores mode.
      if (process.platform !== "win32") {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
      // Round-trips through the reviver to exact bigints.
      const revived = parseSnapshotExport(readFileSync(path, "utf8")) as { byDenomination: { spent: bigint }[] };
      expect(revived.byDenomination[0].spent).toBe(BIG);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("write-is-atomic-overwrite-stays-owner-only", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const dir = mkdtempSync(join(tmpdir(), "x402-export-"));
    try {
      const path = join(dir, "snapshot.json");
      await writeSnapshotExport(path, serializeSnapshot(snap(), { display }));
      await writeSnapshotExport(path, serializeSnapshot(snap(), { display })); // overwrite
      expect(statSync(path).mode & 0o777).toBe(0o600); // still owner-only after overwrite
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates-a-missing-parent-directory-owner-only-not-enoent", async (ctx) => {
    // The README's own example writes to `./export/snapshot.json`; before the fix a missing parent
    // threw a confusing `ENOENT` on the internal `.tmp-` path. The write must create the parent
    // (recursively) — and, since the export carries the counterparty graph, the auto-created dir is
    // owner-only 0o700, never world-traversable. `writeAuditExport` shares the same `atomicWrite600`.
    const base = mkdtempSync(join(tmpdir(), "x402-export-"));
    try {
      const path = join(base, "nested", "deeper", "snapshot.json"); // parents do NOT exist yet
      await writeSnapshotExport(path, serializeSnapshot(snap(), { display })); // must not throw ENOENT
      const revived = parseSnapshotExport(readFileSync(path, "utf8")) as { byDenomination: { spent: bigint }[] };
      expect(revived.byDenomination[0].spent).toBe(BIG); // file landed and round-trips
      if (process.platform !== "win32") {
        expect(statSync(path).mode & 0o777).toBe(0o600); // file owner-only
        expect(statSync(join(base, "nested", "deeper")).mode & 0o777).toBe(0o700); // auto-created dir owner-only
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
