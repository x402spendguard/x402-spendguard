import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, statSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpendGuard, emptyState } from "../src/accounting/guard.js";
import type { Clock, SpendStore, Version } from "../src/accounting/guard.js";
import { FileSpendStore, probeConcurrentExclusiveCreate } from "../src/adapters/file-spend-store.js";
import type { UnixSeconds } from "../src/types.js";
import { NOW, policy, ev } from "./helpers.js";

const clock: Clock = { now: () => NOW };
const tmp = () => mkdtempSync(join(tmpdir(), "x402-cas-"));

describe("CAS retry loop is bounded and fail-closed (ACCT-05, spend.contention)", () => {
  it("exhausts under perpetual conflict and DENIES — never wrongly allows", async () => {
    // A store that reports a version conflict on EVERY commit (sustained contention). The payment
    // itself evaluates to allow, so it reaches compareAndSave every attempt; the guard must retry a
    // bounded number of times and then DENY (fail-closed), never admit an uncounted payment.
    let attempts = 0;
    const alwaysConflict: SpendStore = {
      load: async () => ({ state: emptyState(NOW), version: "0" as Version }),
      compareAndSave: async () => {
        attempts++;
        return false;
      },
      verifyAtomicity: async () => {},
    };
    const guard = new SpendGuard(alwaysConflict, clock, policy(), 3); // maxCasAttempts = 3
    const d = await guard.authorize(ev());
    expect(d.verdict).toBe("deny");
    expect(d.reason).toBe("spend.contention");
    expect(attempts).toBe(3); // exactly the bound — it tried, then failed closed
  });
});

describe("store atomicity is verified fail-closed (ASM6, store.unverified)", () => {
  it("denies all payments if the store fails its atomicity self-test", async () => {
    const unverifiable: SpendStore = {
      load: async () => ({ state: emptyState(NOW), version: "0" as Version }),
      compareAndSave: async () => true,
      verifyAtomicity: async () => {
        throw new Error("filesystem cannot prove concurrent exclusive-create");
      },
    };
    const guard = new SpendGuard(unverifiable, clock, policy());
    const d = await guard.authorize(ev());
    expect(d.verdict).toBe("deny");
    expect(d.reason).toBe("store.unverified"); // refuse LOUD, not silently under-enforce
  });
});

describe("concurrent exclusive-create probe (the ② vs ③ line)", () => {
  it("passes on a real local filesystem", async () => {
    const dir = tmp();
    try {
      await expect(probeConcurrentExclusiveCreate(dir)).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REFUSES a filesystem whose CONCURRENT exclusive-create both-win (not merely no-EEXIST)", async () => {
    // Simulate the NFS-class failure the sequential probe would miss: every link() "succeeds" with
    // no EEXIST, so two racers both win. The probe must catch that and refuse (throw). This is the
    // single test that keeps the CAS store from silently degrading into the lost-update lock trap.
    const dir = tmp();
    const brokenLink = async (): Promise<void> => {
      /* both concurrent links appear to succeed — the silent-under-count filesystem */
    };
    try {
      await expect(probeConcurrentExclusiveCreate(dir, brokenLink)).rejects.toThrow(
        /does not honor concurrent exclusive-create/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("FileSpendStore compare-and-swap (real link())", () => {
  it("rejects a stale-version write — the loser gets a conflict, not a silent overwrite", async () => {
    const dir = tmp();
    try {
      const store = new FileSpendStore(join(dir, "ledger"), NOW as UnixSeconds);
      const { version } = await store.load(); // "0" (no ledger yet)
      expect(await store.compareAndSave(version, emptyState(NOW))).toBe(true); // creates ledger.v1
      // A second writer still holding the stale "0" version: ledger.v1 already exists → link EEXIST
      // → conflict (false), NEVER a last-write-wins overwrite. This is the ACCT-05 fix, on disk.
      expect(await store.compareAndSave(version, emptyState(NOW))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("FileSpendStore CAS is immune to version-number reuse after cleanup (ACCT-07, ABA)", () => {
  it("cas-rejects-stale-writer-after-cleanup", async () => {
    // The ABA that caused the P0 (TEST_PLAN §9): `cleanup` deletes old version files, freeing their
    // NUMBERS. A writer that stalled while holding a now-old `expected` targets `.v{expected+1}`; if
    // cleanup reclaimed that number, a naive `link()` SUCCEEDS into the hole — so link-EEXIST stops
    // being a reliable conflict signal and the stale writer commits a spurious allow. A correct CAS
    // MUST reject it (conflict), because `expected` is no longer current. This is the deterministic
    // regression for that mechanism — no timing luck.
    const dir = tmp();
    try {
      const store = new FileSpendStore(join(dir, "ledger"), NOW as UnixSeconds);
      // A writer loads at version 1 and stalls, holding this token.
      expect(await store.compareAndSave("0" as Version, emptyState(NOW))).toBe(true); // → .v1
      const stale = "1" as Version;
      // Meanwhile the ledger advances well past it, triggering cleanup (KEEP_VERSIONS=3 → deleting
      // versions ≤ current-3): committing through .v5 reclaims the numbers 1 and 2.
      for (const e of ["1", "2", "3", "4"]) {
        expect(await store.compareAndSave(e as Version, emptyState(NOW))).toBe(true);
      }
      // Precondition: the stale writer's target (.v2) has been reclaimed by cleanup.
      const files = readdirSync(dir).filter((f) => /ledger\.v\d+$/.test(f));
      expect(files).not.toContain("ledger.v2");
      // The stale writer resumes and commits. It is 4 versions behind; a correct CAS reports a
      // CONFLICT (false), never a silent success into the reclaimed hole (which would be an
      // over-allow — authorize() would return a spurious `allow`).
      expect(await store.compareAndSave(stale, emptyState(NOW))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cas-two-stale-writers-same-reclaimed-hole-both-rejected", async () => {
    // The adversarial pair CHENG asked for: TWO writers both stalled at version 1, both targeting
    // the SAME reclaimed hole (.v2). The floor guard must reject BOTH — neither may slip through by
    // reclaiming the freed number. (The concurrent form of this runs in the depth-stress e2e; this
    // deterministic form pins that both, not just the first, are conflicts.)
    const dir = tmp();
    try {
      const store = new FileSpendStore(join(dir, "ledger"), NOW as UnixSeconds);
      expect(await store.compareAndSave("0" as Version, emptyState(NOW))).toBe(true); // → .v1
      const s1 = "1" as Version;
      const s2 = "1" as Version; // a second writer that also loaded at v1 and stalled
      for (const e of ["1", "2", "3", "4"]) {
        expect(await store.compareAndSave(e as Version, emptyState(NOW))).toBe(true); // → .v5; reclaims 1,2
      }
      expect(readdirSync(dir).filter((f) => /ledger\.v\d+$/.test(f))).not.toContain("ledger.v2");
      expect(await store.compareAndSave(s1, emptyState(NOW))).toBe(false);
      expect(await store.compareAndSave(s2, emptyState(NOW))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ledger file permissions (L2 — ACCT-06 integrity, PRIV-04 privacy)", () => {
  it("ledger-created-owner-private", async (ctx) => {
    if (process.platform === "win32") ctx.skip(); // PLAT-01: 0o600 creation is a POSIX-only guarantee
    // PRIV-04: version files hold spend amounts, origins, and the counterparty graph — created
    // owner-only (0o600), the mirror of the decision log. Not world-readable at rest.
    const dir = tmp();
    try {
      const ledger = join(dir, "ledger");
      const store = new FileSpendStore(ledger, NOW as UnixSeconds);
      const { version } = await store.load();
      expect(await store.compareAndSave(version, emptyState(NOW))).toBe(true); // creates ledger.v1
      expect(statSync(`${ledger}.v1`).mode & 0o777).toBe(0o600); // no group/other bits at all
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ledger-refuses-world-writable", async (ctx) => {
    if (process.platform === "win32") ctx.skip(); // PLAT-01: the world-writable refusal is skipped on Windows
    // ACCT-06: a world-writable ledger could be silently rewritten by any local user to reset spend
    // (→ drain). load() must REFUSE it — checking permissions BEFORE trusting the (possibly tampered)
    // bytes, the exact CONF-01 ordering. Scoped to the world-write bit only.
    const dir = tmp();
    try {
      const ledger = join(dir, "ledger");
      const store = new FileSpendStore(ledger, NOW as UnixSeconds);
      const { version } = await store.load();
      await store.compareAndSave(version, emptyState(NOW)); // creates ledger.v1 (0o600)
      chmodSync(`${ledger}.v1`, 0o666); // now world-writable — the tamper surface
      await expect(store.load()).rejects.toThrow(/world-writable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ledger-refuses-world-writable-dir", async (ctx) => {
    if (process.platform === "win32") ctx.skip(); // PLAT-01: world-writable is meaningless under synthesized win32 modes
    // ACCT-08: a 0o600 ledger file in a WORLD-WRITABLE DIRECTORY is still attackable — dir-write governs
    // create/rename, so any local user can PLANT a forged higher-version file (`ledger.v999`, itself 0o600)
    // that load() would then pick, defeating the file-level check. Refuse the directory before trusting it.
    const dir = tmp();
    try {
      const ledger = join(dir, "ledger");
      const store = new FileSpendStore(ledger, NOW as UnixSeconds);
      const { version } = await store.load();
      await store.compareAndSave(version, emptyState(NOW)); // creates ledger.v1 (0o600) — the file itself is fine
      chmodSync(dir, 0o777); // the CONTAINING DIRECTORY is world-writable — the plant surface
      await expect(store.load()).rejects.toThrow(/directory .* world-writable/);
    } finally {
      chmodSync(dir, 0o700); // restore so cleanup can remove it
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ledger-refuses-world-writable-dir-even-if-sticky", async (ctx) => {
    if (process.platform === "win32") ctx.skip(); // PLAT-01: POSIX-only
    // Sticky-blind (the design fork): the sticky bit (as on /tmp = 0o1777) stops delete/rename of
    // OTHER users' files but NOT create — so an attacker can still plant a forged `ledger.v999` in a
    // sticky world-writable dir. Sticky does not close the plant vector, so the refusal is sticky-blind.
    const dir = tmp();
    try {
      const ledger = join(dir, "ledger");
      const store = new FileSpendStore(ledger, NOW as UnixSeconds);
      const { version } = await store.load();
      await store.compareAndSave(version, emptyState(NOW));
      chmodSync(dir, 0o1777); // world-writable AND sticky
      await expect(store.load()).rejects.toThrow(/directory .* world-writable/);
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
