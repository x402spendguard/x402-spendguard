import { describe, it, expect } from "vitest";
import { toAlert } from "../src/audit/alert.js";
import type { ChainedRecord } from "../src/audit/hash-chain-log.js";

/** A full decision-log record — carries the whole counterparty tuple (to/origin/amount), as the
 *  owner-only local log should. The alert projection must NOT carry any of it off the machine. */
const record = (): ChainedRecord => ({
  seq: 42,
  prev: "prevhash",
  hash: "thishash",
  alg: "sha256",
  entry: {
    v: 1,
    at: "1700000000",
    verdict: "deny",
    reason: "cap.global",
    detail: "cumulative spend would exceed the ceiling",
    origin: "weather.example",
    chain: "eip155:8453",
    asset: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    amount: "500000",
  },
});

describe("toAlert — the redacted-by-default notification projection (ALERT-01)", () => {
  it("alert-is-redacted-by-default", () => {
    const a = toAlert(record());
    // The FACT of the decision — enough to know something needs attention and WHERE to look
    // (`seq` points at the full record in the local, owner-only log) — and nothing more.
    expect(a).toEqual({ seq: 42, at: "1700000000", verdict: "deny", reason: "cap.global" });
    // By CONSTRUCTION the counterparty tuple never crosses into a notification. An alert is the one
    // artifact that leaves the machine, so it defaults to the minimum useful (deny-all for egress).
    expect(Object.keys(a).sort()).toEqual(["at", "reason", "seq", "verdict"]);
    for (const sensitive of ["to", "origin", "amount", "detail", "asset", "chain"]) {
      expect(a, `alert must not carry '${sensitive}'`).not.toHaveProperty(sensitive);
    }
  });

  it("carries the record's own seq/time/verdict/reason (not fabricated)", () => {
    const a = toAlert({ ...record(), seq: 7, entry: { ...record().entry, verdict: "allow", reason: "ok" } });
    expect(a.seq).toBe(7);
    expect(a.verdict).toBe("allow");
    expect(a.reason).toBe("ok");
    expect(a.at).toBe("1700000000");
  });
});
