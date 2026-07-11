import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  toLogEntry,
  LoggingGuard,
  type Authorizer,
  type DecisionLog,
  type LogEntry,
} from "../src/audit/decision-log.js";
import { FileDecisionLog } from "../src/adapters/file-decision-log.js";
import type { Clock } from "../src/accounting/guard.js";
import type { PaymentEvaluation, PolicyDecision, UnixSeconds } from "../src/types.js";
import { A, T, NOW, ORIGIN, PAYEE, USDC, CHAIN, ev } from "./helpers.js";

// The exact, curated set of fields a log entry may carry. Anything outside this set —
// the nonce, the payer, a signature, the raw authorization — is a PRIV-02 regression.
const SAFE_KEYS = ["at", "amount", "asset", "chain", "detail", "origin", "reason", "to", "verdict"];

const ALLOW: PolicyDecision = { verdict: "allow", reason: "ok", detail: "All checks passed." };
const DENY: PolicyDecision = { verdict: "deny", reason: "halt", detail: "Kill switch engaged." };

class FakeClock implements Clock {
  constructor(public t: UnixSeconds) {}
  now(): UnixSeconds {
    return this.t;
  }
}
class StubAuthorizer implements Authorizer {
  constructor(private readonly d: PolicyDecision) {}
  async authorize(_ev: PaymentEvaluation): Promise<PolicyDecision> {
    return this.d;
  }
}
class MemLog implements DecisionLog {
  entries: LogEntry[] = [];
  async append(e: LogEntry): Promise<void> {
    this.entries.push(e);
  }
}
class ThrowingLog implements DecisionLog {
  async append(): Promise<void> {
    throw new Error("audit sink is down");
  }
}

describe("decision log — PRIV-02 (never logs a bearer capability)", () => {
  it("log-never-contains-signature", () => {
    // helpers' authorization carries nonce 0xdeadbeef and payer 0xcccc… — neither is audit
    // data, and the nonce is half of the replay tuple. The projection must exclude them.
    const entry = toLogEntry(ev(), ALLOW, NOW);
    expect(Object.keys(entry).sort()).toEqual([...SAFE_KEYS].sort());

    const serialized = JSON.stringify(entry).toLowerCase();
    expect(serialized).not.toContain("0xdeadbeef"); // the nonce value
    expect(serialized).not.toContain("nonce");
    expect(serialized).not.toContain("signature");
    expect(serialized).not.toContain("0xcccccccccccccccccccccccccccccccccccccccc"); // payer `from`

    // The safe fields ARE present and correct.
    expect(entry.verdict).toBe("allow");
    expect(entry.origin).toBe(ORIGIN);
    expect(entry.to).toBe(PAYEE);
    expect(entry.asset).toBe(USDC);
    expect(entry.chain).toBe(CHAIN);
    expect(entry.amount).toBe("500000"); // bigint serialized as a decimal string
    expect(entry.at).toBe(NOW.toString());
  });
});

describe("decision log — FAIL-03 (audit half): a log failure never flips a decision", () => {
  it("audit-failure-preserves-decision", async () => {
    // An allow whose audit write throws must remain an allow…
    const gAllow = new LoggingGuard(new StubAuthorizer(ALLOW), new ThrowingLog(), new FakeClock(NOW));
    await expect(gAllow.authorize(ev())).resolves.toEqual(ALLOW);

    // …and a deny whose audit write throws must remain a deny. The audit layer is strictly
    // off the enforcement path — it can fail in either direction and change nothing.
    const gDeny = new LoggingGuard(new StubAuthorizer(DENY), new ThrowingLog(), new FakeClock(NOW));
    await expect(gDeny.authorize(ev())).resolves.toEqual(DENY);
  });
});

describe("decision log — records the final decision (happy path)", () => {
  it("appends one safe entry per decision, verdict intact", async () => {
    const log = new MemLog();
    const guard = new LoggingGuard(new StubAuthorizer(ALLOW), log, new FakeClock(NOW));
    const d = await guard.authorize(ev({ amount: A(500_000n) }, { value: A(500_000n) }));

    expect(d).toEqual(ALLOW); // inner decision returned unchanged
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].verdict).toBe("allow");
    expect(log.entries[0].amount).toBe("500000");
    expect(log.entries[0].at).toBe(NOW.toString());
  });

  it("logs denies too — the audit trail is not allow-only", async () => {
    const log = new MemLog();
    const guard = new LoggingGuard(new StubAuthorizer(DENY), log, new FakeClock(NOW));
    await guard.authorize(ev());
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].verdict).toBe("deny");
    expect(log.entries[0].reason).toBe("halt");
  });
});

describe("FileDecisionLog — durable append-only JSONL seam", () => {
  const dir = mkdtempSync(join(tmpdir(), "spendguard-log-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("appends one parseable JSON object per line, bigint money as strings", async () => {
    const path = join(dir, "decisions.jsonl");
    const log = new FileDecisionLog(path);
    await log.append(toLogEntry(ev(), ALLOW, NOW));
    await log.append(toLogEntry(ev({}, { value: A(700_000n) }), DENY, T(NOW + 1n)));

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first.verdict).toBe("allow");
    expect(first.at).toBe(NOW.toString());

    const second = JSON.parse(lines[1]);
    expect(second.verdict).toBe("deny");
    expect(second.amount).toBe("700000");
    expect(second.at).toBe((NOW + 1n).toString());
  });
});
