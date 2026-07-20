// Adapter: a durable, cross-process-safe spend store (ACCT-05). State lives in VERSION-NAMED
// files `<path>.v<N>`. A commit is a genuine OS-atomic compare-and-swap: write the next state to a
// unique temp, fsync it, then `link()` it to `<path>.v<N+1>` — `link` is an atomic create-or-EEXIST,
// so exactly one of two racing writers wins the new version and the loser gets a real conflict
// (never a silent last-write-wins overwrite). This is an edge module; filesystem I/O belongs here.
//
// See docs/design-acct-05-cas-store.md and decisions D-031. The startup probe (verifyAtomicity)
// is CONCURRENT — it races two link()s at one target and refuses to run if both win — because a
// sequential check passes on exactly the filesystem (NFS) that silently under-counts under load.
import {
  readFileSync,
  readdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  linkSync,
  unlinkSync,
  statSync,
  statfsSync,
} from "node:fs";
import { link as linkAsync, writeFile, unlink as unlinkAsync } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, basename, join } from "node:path";
import type { SpendStore, Version } from "../accounting/guard.js";
import { emptyState, nullMap } from "../accounting/guard.js";
import { modeIsWorldWritable } from "./fs-perms.js";
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

/** How many stale version files to keep (>= 3) — widens the window between a reader picking the
 *  highest version and cleanup possibly deleting it, so the read-retry below is a rare backstop. */
const KEEP_VERSIONS = 3;
/** Bounded, fail-closed read-retry: if a chosen version file vanishes under cleanup mid-read, we
 *  re-enumerate. If it keeps vanishing this many times, we give up and DENY (throw → load_failed). */
const READ_RETRY_MAX = 8;

/**
 * Race two concurrent exclusive-creates (`link`) at one fresh target and require EXACTLY ONE to
 * win. On a filesystem that honors exclusive-create the loser gets `EEXIST`; on one that lies under
 * contention (NFS et al.) BOTH appear to win — which is the silent-under-count failure we refuse.
 * Extracted + `link`-injectable so it can be adversarially tested against a simulated-broken FS.
 */
export async function probeConcurrentExclusiveCreate(
  dir: string,
  link: (src: string, dest: string) => Promise<void> = linkAsync,
  rounds = 3,
): Promise<void> {
  for (let r = 0; r < rounds; r++) {
    const target = join(dir, `.x402probe.${process.pid}.${randomUUID()}`);
    const srcA = `${target}.a`;
    const srcB = `${target}.b`;
    await writeFile(srcA, "a");
    await writeFile(srcB, "b");
    const results = await Promise.allSettled([link(srcA, target), link(srcB, target)]);
    const wins = results.filter((x) => x.status === "fulfilled").length;
    for (const f of [srcA, srcB, target]) {
      await unlinkAsync(f).catch(() => {});
    }
    if (wins !== 1) {
      throw new Error(
        `spend ledger filesystem does not honor concurrent exclusive-create (probe round ${r + 1}: ` +
          `${wins} of 2 racing link()s to one target succeeded; expected exactly 1). Refusing to run ` +
          `(a shared ledger here could silently under-count). Use a local disk. See docs/design-acct-05-cas-store.md.`,
      );
    }
  }
}

/** Refuse a store on a known-unsafe (network) mount, where exclusive-create atomicity is not
 *  guaranteed — belt-and-suspenders with the probe (which races once, at boot, and can be fooled by
 *  timing). Best-effort: if the platform can't report the filesystem type, we rely on the probe. */
function assertSupportedMount(dir: string): void {
  if (typeof statfsSync !== "function") return;
  let type: number;
  try {
    type = statfsSync(dir).type;
  } catch {
    return; // can't determine → rely on the concurrent probe + docs
  }
  // Linux VFS statfs f_type magic numbers for filesystems without guaranteed exclusive-create.
  const UNSAFE: Record<number, string> = { 0x6969: "NFS", 0xff534d42: "SMB/CIFS", 0x517b: "SMB" };
  const name = UNSAFE[type];
  if (name) {
    throw new Error(
      `spend ledger is on a ${name} mount, where exclusive-create atomicity is not guaranteed; ` +
        `refusing to run — use a local disk or an external store. See docs/design-acct-05-cas-store.md.`,
    );
  }
}

export class FileSpendStore implements SpendStore {
  private readonly dir: string;
  private readonly prefix: string;

  constructor(
    private readonly path: string,
    private readonly initialNow: UnixSeconds,
  ) {
    this.dir = dirname(path);
    this.prefix = `${basename(path)}.v`;
  }

  private versionPath(n: number): string {
    return `${this.path}.v${n}`;
  }

  /** Highest version present, or 0 if none. */
  private highestVersion(): number {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return 0; // dir missing → no ledger yet
    }
    let max = 0;
    for (const name of entries) {
      if (!name.startsWith(this.prefix)) continue;
      const n = Number(name.slice(this.prefix.length));
      if (Number.isInteger(n) && n > max) max = n;
    }
    return max;
  }

  /**
   * ACCT-08: refuse a world-writable ledger DIRECTORY. Called at the top of EVERY trust-taking
   * operation (`load` AND `compareAndSave`) so the refusal is a property of the store itself, held
   * BY CONSTRUCTION — never resting on the caller invoking `load()` first (that would locate a
   * security invariant in caller call-order; a future adapter/refactor could reopen the door).
   *
   * Directory-write governs create/rename, so a world-writable dir lets any local user PLANT a forged
   * higher-version file that `highestVersion()` would then pick — even a `0o600` planted file passes
   * the per-file ACCT-06 check. Sticky-blind: the sticky bit stops delete/rename but NOT create, so it
   * does not close this plant vector. World-only per the single-tenant trust model; POSIX-only (PLAT-01,
   * `modeIsWorldWritable` is a no-op on win32). A missing dir (no ledger yet) is not refused; any other
   * stat error fails closed.
   */
  private assertDirTrusted(): void {
    let dirMode: number;
    try {
      dirMode = statSync(this.dir).mode;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // no dir yet → no ledger → nothing to refuse
      throw err; // a real stat error → fail-closed
    }
    if (modeIsWorldWritable(dirMode)) {
      throw new Error(
        `spend ledger directory "${this.dir}" is world-writable; refusing to trust it (a local user could plant a forged version file).`,
      );
    }
  }

  async load(): Promise<{ state: SpendState; version: Version }> {
    this.assertDirTrusted(); // ACCT-08 — by construction, before any version file is picked or read
    for (let attempt = 0; attempt < READ_RETRY_MAX; attempt++) {
      const n = this.highestVersion();
      if (n === 0) return { state: emptyState(this.initialNow), version: "0" as Version };
      try {
        // ACCT-06: refuse a world-writable ledger BEFORE trusting its bytes — the CONF-01 ordering.
        // A world-writable ledger could be silently rewritten by any local user to reset spend
        // (→ drain). Scoped to the world-write bit only (not group, not owner): mechanism, not
        // judgment. Our own version files are created 0o600 (PRIV-04), so this only ever fires on a
        // ledger a third party (or a pre-0o600 build) left loose. `statSync` ENOENT is a vanished
        // file → falls through to the ENOENT handler below and re-enumerates.
        if (modeIsWorldWritable(statSync(this.versionPath(n)).mode)) {
          throw new Error(
            `spend ledger "${this.versionPath(n)}" is world-writable; refusing to trust it (possible tampering).`,
          );
        }
        const text = readFileSync(this.versionPath(n), "utf8");
        return { state: deserialize(text), version: String(n) as Version };
      } catch (err) {
        // The chosen version vanished under cleanup between enumerate and read → re-enumerate.
        // Any OTHER error (corrupt JSON, world-writable, permissions) propagates → the guard denies.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
    }
    throw new Error("could not obtain a stable ledger read (version files kept vanishing under cleanup)");
  }

  /**
   * The floor of RECLAIMED version numbers, derived (not stored) from the max: `cleanup` deletes
   * versions `<= current - KEEP_VERSIONS` on every commit and never touches the top `KEEP_VERSIONS`,
   * so at any instant every number `<= highestVersion() - KEEP_VERSIONS` has been (or will be)
   * freed, and everything above still exists. A commit targeting a number at or below this floor is
   * a stale writer whose target `cleanup` reclaimed — reject it (ACCT-07). Deriving the floor from
   * the max means C stays correct even if `cleanup` lags, fails, or is disabled: the bound does not
   * depend on cleanup having actually run.
   */
  private reclaimedFloor(): number {
    return this.highestVersion() - KEEP_VERSIONS;
  }

  async compareAndSave(expected: Version, next: SpendState): Promise<boolean> {
    this.assertDirTrusted(); // ACCT-08 — refuse on this trust-taking op too, independent of any prior load()
    const n = Number(expected);
    const targetN = n + 1;
    const target = this.versionPath(targetN);

    // ACCT-07 floor guard (pre-link fast reject). `link`-EEXIST is only a valid CAS signal while a
    // version number is unique-forever; `cleanup` frees numbers, so a stale writer could otherwise
    // `link()` into a reclaimed hole and commit a spurious allow (the ABA). A target at or below the
    // reclaimed floor is a stale writer — reject as a conflict without touching the disk.
    if (targetN <= this.reclaimedFloor()) return false;

    // Write the full next state to a unique temp and fsync it, so the version file is COMPLETE
    // before it exists under its name (crash-safe), then atomically claim the name via link().
    const tmp = `${this.path}.tmp.${process.pid}.${randomUUID()}`;
    // PRIV-04: create owner-only (0o600) — the version file inherits this mode through link() below,
    // so spend amounts, origins, and the counterparty graph are never world-readable at rest (the
    // mirror of the decision log). Mode applies on creation; the world-write refusal in load() is
    // the integrity half (ACCT-06).
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, serialize(next));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, target); // ATOMIC create-or-EEXIST — the compare-and-swap
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best-effort */
      }
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false; // version advanced → conflict
      throw err;
    }

    // ACCT-07 floor guard (POST-link re-check — the load-bearing half). This closes the check→link
    // race: if `cleanup` advanced the max past our target while we were writing/linking, our commit
    // is an orphan far below the true max. `highestVersion()` is monotonic-nondecreasing (the top
    // KEEP_VERSIONS are never deleted), so a post-link floor that now covers our target proves we
    // reclaimed a hole. Retract it and report the conflict. This is SAFE — never a double-count —
    // because an orphan `<= max - KEEP_VERSIONS` is below what any reader's `load()` can return, so
    // no writer ever built a child on it; we only ever retract a proven orphan, never a live tip.
    if (targetN <= this.reclaimedFloor()) {
      try {
        unlinkSync(target);
      } catch {
        /* best-effort */
      }
      try {
        unlinkSync(tmp);
      } catch {
        /* best-effort */
      }
      return false;
    }

    try {
      unlinkSync(tmp); // target is now a hardlink to the content; the temp name is no longer needed
    } catch {
      /* best-effort */
    }
    this.cleanup(targetN);
    return true;
  }

  /** Delete version files older than the last KEEP_VERSIONS. Best-effort: a concurrent writer's
   *  cleanup may have already removed them, and a missing file is fine. */
  private cleanup(current: number): void {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.startsWith(this.prefix)) continue;
      const n = Number(name.slice(this.prefix.length));
      if (Number.isInteger(n) && n <= current - KEEP_VERSIONS) {
        try {
          unlinkSync(join(this.dir, name));
        } catch {
          /* best-effort */
        }
      }
    }
  }

  /** Startup self-test (fail-closed): concurrent exclusive-create must honor exactly-one-winner,
   *  AND the mount must not be a known-unsafe network filesystem. Both, per the design note. */
  async verifyAtomicity(): Promise<void> {
    assertSupportedMount(this.dir);
    await probeConcurrentExclusiveCreate(this.dir);
  }
}
