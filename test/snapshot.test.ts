import { describe, it, expect } from "vitest";
import { SpendGuard, emptyState, recordSpend, nullMap } from "../src/accounting/guard.js";
import type { Clock, SpendStore, Version } from "../src/accounting/guard.js";
import { projectSnapshot, SnapshotUnreadableError } from "../src/accounting/snapshot.js";
import type { SpendState, UnixSeconds } from "../src/types.js";
import { A, T, key, NOW, ORIGIN, policy, ev } from "./helpers.js";

// A controllable clock (INJ-01) and an async versioned in-memory store — the same shapes the
// accounting suite uses. Async on purpose so read-only-ness is a real property, not a sync artifact.
class FakeClock implements Clock {
  constructor(public t: UnixSeconds) {}
  now(): UnixSeconds {
    return this.t;
  }
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
class MemStore implements SpendStore {
  private version = 0;
  constructor(public state: SpendState) {}
  async load() {
    await tick();
    return { state: structuredClone(this.state), version: String(this.version) as Version };
  }
  async compareAndSave(expected: Version, next: SpendState): Promise<boolean> {
    await tick();
    if (String(this.version) !== expected) return false;
    this.version++;
    this.state = structuredClone(next);
    return true;
  }
  async verifyAtomicity(): Promise<void> {}
}

const pay = (n: bigint) => ev({ amount: A(n) }, { value: A(n) });
// A denomination key that is NOT configured in the default policy caps (to prove nothing is hidden).
const UNCONFIGURED = "eip155:8453|0xdddddddddddddddddddddddddddddddddddddddd";

describe("snapshot pure projection (projectSnapshot)", () => {
  it("projects an empty state to zeroed budget lines and correct window bounds", () => {
    const snap = projectSnapshot(emptyState(NOW), policy(), NOW);
    expect(snap.now).toBe(NOW);
    expect(snap.halt).toBe(false);
    expect(snap.windowStart).toBe(NOW);
    expect(snap.windowSeconds).toBe(86_400n);
    expect(snap.windowEndsAt).toBe(NOW + 86_400n);
    expect(snap.byDomain).toEqual([]);
    // The one configured denomination shows even at 0 spent: spent 0, remaining = the global cap.
    const d = snap.byDenomination.find((x) => x.key === key);
    expect(d).toBeDefined();
    expect(d!.spent).toBe(0n);
    expect(d!.remaining).toBe(20_000_000n);
    expect(d!.caps).toEqual({ perRequest: 1_000_000n, global: 20_000_000n });
  });

  it("reflects per-denomination and per-domain spend", () => {
    const s = recordSpend(emptyState(NOW), pay(600_000n)); // spends 0.6 in `key` under ORIGIN
    const snap = projectSnapshot(s, policy(), NOW);
    const d = snap.byDenomination.find((x) => x.key === key)!;
    expect(d.spent).toBe(600_000n);
    expect(d.remaining).toBe(20_000_000n - 600_000n);
    expect(snap.byDomain).toHaveLength(1);
    expect(snap.byDomain[0].origin).toBe(ORIGIN);
    const a = snap.byDomain[0].byAsset.find((x) => x.key === key)!;
    expect(a.spent).toBe(600_000n);
    expect(a.perDomainCap).toBe(5_000_000n);
    expect(a.remaining).toBe(5_000_000n - 600_000n);
  });

  it("windowSeconds 0 yields a null windowEndsAt (no rolling reset)", () => {
    const snap = projectSnapshot(emptyState(NOW), policy({ windowSeconds: T(0n) }), NOW);
    expect(snap.windowEndsAt).toBeNull();
  });

  it("is proto-safe for a __proto__ domain key", () => {
    const dom = nullMap<Record<string, bigint>>();
    const row = nullMap<bigint>();
    row[key] = 700n;
    dom["__proto__"] = row; // an ordinary own key on a null-prototype map, not the prototype
    const s: SpendState = { spentByDomain: dom, spentByAsset: nullMap(), windowStart: NOW, lastSeen: NOW };
    const snap = projectSnapshot(s, policy(), NOW);
    const entry = snap.byDomain.find((x) => x.origin === "__proto__");
    expect(entry).toBeDefined();
    expect(entry!.byAsset[0].spent).toBe(700n);
  });

  // SNAP-03 — honest view: every configured cap shown, unconfigured spend shown, over-count surfaced.
  it("snapshot-honest-view", () => {
    // (a) every configured cap appears even at 0 spent
    const empty = projectSnapshot(emptyState(NOW), policy(), NOW);
    expect(empty.byDenomination.find((d) => d.key === key)!.spent).toBe(0n);

    // (b) write-ahead over-count is surfaced: spent > global cap → remaining clamps at 0, raw visible
    const over: SpendState = {
      spentByDomain: {},
      spentByAsset: { [key]: 25_000_000n }, // above the 20M global cap
      windowStart: NOW,
      lastSeen: NOW,
    };
    const od = projectSnapshot(over, policy(), NOW).byDenomination.find((d) => d.key === key)!;
    expect(od.spent).toBe(25_000_000n); // raw over-count is not hidden
    expect(od.remaining).toBe(0n); // clamped, never negative
    expect(od.caps.global).toBe(20_000_000n);

    // (c) a denomination with spend but NO configured cap is shown (null caps), never omitted
    const uncfg: SpendState = {
      spentByDomain: {},
      spentByAsset: { [UNCONFIGURED]: 500n },
      windowStart: NOW,
      lastSeen: NOW,
    };
    const ud = projectSnapshot(uncfg, policy(), NOW).byDenomination.find((d) => d.key === UNCONFIGURED);
    expect(ud).toBeDefined();
    expect(ud!.spent).toBe(500n);
    expect(ud!.remaining).toBeNull();
    expect(ud!.caps).toEqual({ perRequest: null, global: null });
  });
});

describe("SpendGuard.snapshot()", () => {
  it("reflects recorded spend through the guard", async () => {
    const store = new MemStore(emptyState(NOW));
    const guard = new SpendGuard(store, new FakeClock(NOW), policy());
    await guard.authorize(pay(600_000n));
    const snap = await guard.snapshot();
    expect(snap.byDenomination.find((d) => d.key === key)!.spent).toBe(600_000n);
  });

  // SNAP-01 — read-only: never writes, and a read-only window advance is not persisted.
  it("snapshot-is-read-only", async () => {
    // (a) a store whose writes THROW: snapshot must still succeed → it calls neither compareAndSave
    //     nor verifyAtomicity (both would throw). It reads via load() only.
    const withSpend = recordSpend(emptyState(NOW), pay(600_000n));
    const noWrite: SpendStore = {
      load: async () => ({ state: withSpend, version: "5" as Version }),
      compareAndSave: async () => {
        throw new Error("snapshot must never write");
      },
      verifyAtomicity: async () => {
        throw new Error("snapshot must never verifyAtomicity");
      },
    };
    const g = new SpendGuard(noWrite, new FakeClock(NOW), policy());
    const snap = await g.snapshot(); // must NOT throw
    expect(snap.byDenomination.find((d) => d.key === key)!.spent).toBe(600_000n);

    // (b) a read-only monotonic window advance is computed for display but NOT persisted.
    const store = new MemStore(emptyState(NOW));
    const clock = new FakeClock(NOW);
    const g2 = new SpendGuard(store, clock, policy()); // windowSeconds 86400
    await g2.authorize(pay(600_000n)); // spent 0.6 at NOW → store version advances to 1
    const versionBefore = (await store.load()).version;
    clock.t = (NOW + 86_401n) as UnixSeconds; // jump a full window forward
    const rolled = await g2.snapshot();
    expect(rolled.byDenomination.find((d) => d.key === key)!.spent).toBe(0n); // fresh window in the view
    expect(rolled.windowStart).toBe(NOW + 86_400n); // advanced boundary, for display
    expect((await store.load()).version).toBe(versionBefore); // …but the advance was NOT written
  });

  // SNAP-02 — fail LOUD, not closed: an unreadable store throws, never a fabricated zeroed snapshot.
  it("snapshot-unreadable-throws-not-zeros", async () => {
    const failing: SpendStore = {
      load: async () => {
        throw new Error("disk gone");
      },
      compareAndSave: async () => true,
      verifyAtomicity: async () => {},
    };
    const g = new SpendGuard(failing, new FakeClock(NOW), policy());
    await expect(g.snapshot()).rejects.toBeInstanceOf(SnapshotUnreadableError);
    await expect(g.snapshot()).rejects.toMatchObject({ reason: "snapshot.state_unreadable" });

    // The asymmetry, pinned: on the SAME unreadable store, authorize() fails CLOSED (deny), while
    // snapshot() fails LOUD (throw). Same no-false-permissive principle, opposite direction.
    const d = await g.authorize(ev());
    expect(d.verdict).toBe("deny");
    expect(d.reason).toBe("state.load_failed");
  });
});
