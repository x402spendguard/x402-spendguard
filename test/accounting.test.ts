import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpendGuard, emptyState, applyWindow } from "../src/accounting/guard.js";
import type { Clock, SpendStore } from "../src/accounting/guard.js";
import { FileSpendStore } from "../src/adapters/file-spend-store.js";
import type { SpendState, UnixSeconds } from "../src/types.js";
import { A, T, key, ORIGIN, policy, ev } from "./helpers.js";

// A controllable clock — the whole point of INJ-01 is that tests own time.
class FakeClock implements Clock {
  constructor(public t: UnixSeconds) {}
  now(): UnixSeconds {
    return this.t;
  }
}

// An async in-memory store. Async on purpose: it makes the concurrency guarantee (ACCT-02)
// a real property rather than an artifact of synchronous code.
class MemStore implements SpendStore {
  constructor(public state: SpendState) {}
  async load(): Promise<SpendState> {
    await tick();
    return structuredClone(this.state);
  }
  async save(s: SpendState): Promise<void> {
    await tick();
    this.state = structuredClone(s);
  }
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const START = 1_000_000n as UnixSeconds;
// A policy with a small per-domain cap so two 0.6 payments jointly exceed it.
const capPolicy = policy({ caps: { [key]: { perRequest: A(1_000_000n), perDomain: A(1_000_000n), global: A(20_000_000n) } } });
const pay6 = ev({ amount: A(600_000n) }, { value: A(600_000n) }); // 0.6 USDC

describe("write-ahead recording (ACCT-01)", () => {
  it("crash-between-record-and-settle-does-not-undercount", async () => {
    const store = new MemStore(emptyState(START));
    const guard = new SpendGuard(store, new FakeClock(START), capPolicy);

    const first = await guard.authorize(pay6);
    expect(first.verdict).toBe("allow");
    // The spend is durably recorded the moment authorize returns allow — BEFORE the caller
    // settles. So a crash now (we never "settle") leaves the spend counted, not lost.
    expect(store.state.spentByAsset[key]).toBe(600_000n);

    // A brand-new guard over that same recorded state (a "restart" after the crash) must
    // see the spend and refuse a second 0.6 that would breach the 1.0 cap.
    const afterCrash = new SpendGuard(new MemStore(store.state), new FakeClock(START), capPolicy);
    const second = await afterCrash.authorize(pay6);
    expect(second.verdict).toBe("deny");
    expect(second.reason).toBe("cap.per_domain");
  });
});

describe("single-writer serialization (ACCT-02)", () => {
  it("concurrent-payments-cannot-both-pass", async () => {
    const guard = new SpendGuard(new MemStore(emptyState(START)), new FakeClock(START), capPolicy);
    // Fire two 0.6 payments concurrently against a 1.0 cap. Without serialization both would
    // read pre-spend state and both pass. Exactly one must win.
    const [a, b] = await Promise.all([guard.authorize(pay6), guard.authorize(pay6)]);
    const allows = [a, b].filter((d) => d.verdict === "allow").length;
    expect(allows).toBe(1);
  });
});

describe("durable across restart (ACCT-03)", () => {
  const path = join(tmpdir(), "x402-spendguard-acct-test.json");
  beforeEach(() => rmSync(path, { force: true }));
  afterEach(() => rmSync(path, { force: true }));

  it("state-survives-restart", async () => {
    const g1 = new SpendGuard(new FileSpendStore(path, START), new FakeClock(START), capPolicy);
    expect((await g1.authorize(pay6)).verdict).toBe("allow");
    expect(existsSync(path)).toBe(true);

    // A fresh guard + fresh store instance pointed at the same file = a process restart.
    const g2 = new SpendGuard(new FileSpendStore(path, START), new FakeClock(START), capPolicy);
    const second = await g2.authorize(pay6);
    expect(second.verdict).toBe("deny"); // the persisted 0.6 constrains the second 0.6
    expect(second.reason).toBe("cap.per_domain");
  });
});

describe("clock anomaly fails closed (CLOCK-01)", () => {
  it("clock-anomaly-fails-closed", async () => {
    const store = new MemStore(emptyState(START));
    const clock = new FakeClock(START);
    const guard = new SpendGuard(store, clock, capPolicy);

    expect((await guard.authorize(pay6)).verdict).toBe("allow"); // 0.6 counted at START

    // Attacker rewinds the clock far into the past. A backward jump must never reset the
    // window or free budget — the second 0.6 must still be denied.
    clock.t = (START - 500_000n) as UnixSeconds;
    const rewound = await guard.authorize(pay6);
    expect(rewound.verdict).toBe("deny");
    expect(rewound.reason).toBe("cap.per_domain");
    // Monotonic guard held: lastSeen never went backward.
    expect(store.state.lastSeen).toBe(START);
  });

  it("window reset is monotonic (unit)", () => {
    // A backward now does not reset even a fully-elapsed-looking window.
    const s: SpendState = { spentByDomain: {}, spentByAsset: { [key]: 900_000n }, windowStart: START, lastSeen: START };
    const back = applyWindow(s, (START - 10_000n) as UnixSeconds, T(1_000n));
    expect(back.spentByAsset[key]).toBe(900_000n); // not reset
    // A genuine forward elapse of a full window DOES reset (legitimate daily rollover).
    const fwd = applyWindow(s, (START + 2_000n) as UnixSeconds, T(1_000n));
    expect(fwd.spentByAsset[key]).toBeUndefined(); // reset
  });
});

describe("spend record failure denies (FAIL-03, spend half)", () => {
  it("spend-record-failure-denies", async () => {
    // A store whose durable save fails must NOT let the payment proceed uncounted.
    const failing: SpendStore = {
      load: async () => emptyState(START),
      save: async () => {
        throw new Error("disk full");
      },
    };
    const guard = new SpendGuard(failing, new FakeClock(START), capPolicy);
    const d = await guard.authorize(pay6);
    expect(d.verdict).toBe("deny");
    expect(d.reason).toBe("spend.record_failed");
  });
});
