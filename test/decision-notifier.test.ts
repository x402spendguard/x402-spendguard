import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HashChainDecisionLog } from "../src/audit/hash-chain-log.js";
import type { LogEntry } from "../src/audit/decision-log.js";
import type { Alert } from "../src/audit/alert.js";
import { drainOnce, renderAlert } from "../scripts/decision-notifier.js";

const tmp = () => mkdtempSync(join(tmpdir(), "x402-notify-test-"));
const entry = (i: number, over: Partial<LogEntry> = {}): LogEntry => ({
  v: 1, at: String(1_700_000_000 + i), verdict: "allow", reason: "ok", detail: "d",
  origin: "secret-counterparty.example", chain: "eip155:8453",
  asset: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", amount: "500000", ...over,
});

describe("reference notifier — redaction through the send path + cursor/resume", () => {
  it("sends REDACTED alerts: the raw counterparty tuple never reaches `send`", async () => {
    const dir = tmp();
    try {
      const logPath = join(dir, "log");
      const cursorPath = join(dir, "cur");
      const log = new HashChainDecisionLog(logPath);
      await log.append(entry(0));
      await log.append(entry(1, { verdict: "deny", reason: "cap.global" }));

      const captured: Alert[] = [];
      const messages: string[] = [];
      await drainOnce({ logPath, cursorPath, send: (a, m) => { captured.push(a); messages.push(m); } });

      // Two alerts, each redacted: only the fact of the decision + a local pointer (seq).
      expect(captured.map((a) => [a.seq, a.verdict, a.reason])).toEqual([[0, "allow", "ok"], [1, "deny", "cap.global"]]);
      for (const a of captured) {
        expect(Object.keys(a).sort()).toEqual(["at", "reason", "seq", "verdict"]);
      }
      // The rendered message — the actual bytes that would cross the wire — leaks no counterparty data.
      const all = messages.join("\n");
      expect(all).not.toContain("secret-counterparty.example"); // origin
      expect(all).not.toContain("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"); // payee
      expect(all).not.toContain("500000"); // amount
      expect(all).toContain("cap.global"); // but the reason IS there
      expect(all).toContain("#1"); // and the local pointer
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("advances the cursor and resumes — no re-send, no drop", async () => {
    const dir = tmp();
    try {
      const logPath = join(dir, "log");
      const cursorPath = join(dir, "cur");
      const log = new HashChainDecisionLog(logPath);
      await log.append(entry(0));
      await log.append(entry(1));

      const first = await drainOnce({ logPath, cursorPath, send: () => {} });
      expect(first.map((a) => a.seq)).toEqual([0, 1]);

      // Nothing new → a second drain sends nothing (the cursor was persisted).
      const again = await drainOnce({ logPath, cursorPath, send: () => {} });
      expect(again).toEqual([]);

      // A new decision arrives → only IT is sent (resumes from the cursor, never re-sends 0/1).
      await log.append(entry(2, { verdict: "deny", reason: "halt" }));
      const next = await drainOnce({ logPath, cursorPath, send: () => {} });
      expect(next.map((a) => a.seq)).toEqual([2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renderAlert carries the reason + local pointer, never the counterparty tuple", () => {
    const msg = renderAlert({ seq: 42, at: "1700000000", verdict: "deny", reason: "cap.global" });
    expect(msg).toContain("BLOCKED");
    expect(msg).toContain("cap.global");
    expect(msg).toContain("#42");
  });
});
