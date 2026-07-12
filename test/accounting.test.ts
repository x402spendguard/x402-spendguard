import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpendGuard, emptyState, applyWindow } from "../src/accounting/guard.js";
import type { Clock, SpendStore, Version } from "../src/accounting/guard.js";
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

// An async in-memory versioned (CAS) store. Async on purpose: the `tick()` yield makes the
// concurrency guarantees (ACCT-02/05) real properties, not artifacts of synchronous code. The
// version counter is the compare-and-swap: a save whose expected version no longer matches loses.
class MemStore implements SpendStore {
  private version = 0;
  constructor(public state: SpendState) {}
  async load(): Promise<{ state: SpendState; version: Version }> {
    await tick();
    return { state: structuredClone(this.state), version: String(this.version) as Version };
  }
  async compareAndSave(expected: Version, next: SpendState): Promise<boolean> {
    await tick();
    if (String(this.version) !== expected) return false; // version advanced under us → conflict
    this.version++;
    this.state = structuredClone(next);
    return true;
  }
  async verifyAtomicity(): Promise<void> {
    /* single-process in-memory: trivially atomic */
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

describe("cross-process single-writer (ACCT-05)", () => {
  it("cross-process-cannot-both-pass", async () => {
    // Two INDEPENDENT guards (two in-process mutexes) sharing ONE ledger — the cross-process
    // situation: each "process" serializes itself, but they share the wallet's store. Fire two
    // 0.6 payments against a 1.0 cap. Without cross-process arbitration both load pre-spend state
    // and both pass (the ACCT-05 lost update). Exactly one must win. RED until the CAS store lands.
    const store = new MemStore(emptyState(START));
    const gA = new SpendGuard(store, new FakeClock(START), capPolicy);
    const gB = new SpendGuard(store, new FakeClock(START), capPolicy);
    const [a, b] = await Promise.all([gA.authorize(pay6), gB.authorize(pay6)]);
    const allows = [a, b].filter((d) => d.verdict === "allow").length;
    expect(allows).toBe(1);
  });
});

describe("durable across restart (ACCT-03)", () => {
  let dir: string;
  let ledger: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "x402-acct03-")); // isolate: the store writes version files ledger.v<N>
    ledger = join(dir, "ledger");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("state-survives-restart", async () => {
    const g1 = new SpendGuard(new FileSpendStore(ledger, START), new FakeClock(START), capPolicy);
    expect((await g1.authorize(pay6)).verdict).toBe("allow");
    expect(existsSync(`${ledger}.v1`)).toBe(true);

    // A fresh guard + fresh store instance pointed at the same ledger = a process restart.
    const g2 = new SpendGuard(new FileSpendStore(ledger, START), new FakeClock(START), capPolicy);
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

describe("corrupt ledger fails closed (H3)", () => {
  let dir: string;
  let ledger: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "x402-corrupt-"));
    ledger = join(dir, "ledger");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("corrupt-ledger-denies", async () => {
    writeFileSync(`${ledger}.v1`, "{ this is not valid json", "utf8"); // corrupt the version file the store reads
    const guard = new SpendGuard(new FileSpendStore(ledger, START), new FakeClock(START), capPolicy);
    const d = await guard.authorize(pay6);
    expect(d.verdict).toBe("deny"); // must DENY, not throw out of authorize()
    expect(d.reason).toBe("state.load_failed");
  });
});

describe("forward clock jump rolls the window (M2 — documented A5 limitation)", () => {
  // CLOCK-01 honestly guarantees only the BACKWARD/monotonic direction. A forward wall-clock
  // jump under host control (A5, out of scope) can force an early rollover = fresh budget.
  // A pure function cannot distinguish that from a legitimate window passage without a trusted
  // time source. This test PINS that behavior so the claim matches the code.
  it("forward-jump-manufactures-budget (known, out of scope)", async () => {
    const store = new MemStore(emptyState(START));
    const clock = new FakeClock(START);
    const payAt = (t: bigint) => ev({ amount: A(600_000n) }, { value: A(600_000n), validBefore: (t + 100n) as UnixSeconds });
    const guard = new SpendGuard(store, clock, capPolicy); // windowSeconds 86400, cap 1.0

    expect((await guard.authorize(payAt(START))).verdict).toBe("allow"); // 0.6
    expect((await guard.authorize(payAt(START))).reason).toBe("cap.per_domain"); // 1.2 > 1.0, denied
    clock.t = (START + 86_401n) as UnixSeconds; // jump a full window forward
    expect((await guard.authorize(payAt(clock.t))).verdict).toBe("allow"); // budget rolled over
  });
});

describe("spend record failure denies (FAIL-03, spend half)", () => {
  it("spend-record-failure-denies", async () => {
    // A store whose durable save fails must NOT let the payment proceed uncounted.
    const failing: SpendStore = {
      load: async () => ({ state: emptyState(START), version: "0" as Version }),
      compareAndSave: async () => {
        throw new Error("disk full");
      },
      verifyAtomicity: async () => {},
    };
    const guard = new SpendGuard(failing, new FakeClock(START), capPolicy);
    const d = await guard.authorize(pay6);
    expect(d.verdict).toBe("deny");
    expect(d.reason).toBe("spend.record_failed");
  });
});
