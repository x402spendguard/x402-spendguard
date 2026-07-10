// Placeholders for requirements whose enforcement layer does not exist yet.
// Each is a REAL requirement with a named test that is not yet written, kept here
// as `it.todo` so:
//   1. the traceability meta-test stays green (every [v1] requirement is named), and
//   2. the vitest runner lists them, honestly, as pending work.
//
// These become real tests — never deleted, never weakened — as their layer lands.
// A todo here must NEVER be used to dodge a testable requirement (D-016); it is only
// for a requirement whose layer genuinely does not exist yet.
import { describe, it } from "vitest";

describe("accounting layer — not built yet", () => {
  it.todo("crash-between-record-and-settle-does-not-undercount"); // ACCT-01
  it.todo("concurrent-payments-cannot-both-pass"); // ACCT-02
  it.todo("state-survives-restart"); // ACCT-03
  it.todo("clock-anomaly-fails-closed"); // CLOCK-01
  it.todo("spend-record-failure-denies"); // FAIL-03 (accounting half)
});

describe("audit/log layer — not built yet", () => {
  it.todo("audit-failure-preserves-decision"); // FAIL-03 (audit half)
  it.todo("log-never-contains-signature"); // PRIV-02
});

describe("adapter layer — not built yet", () => {
  it.todo("domain-derivation-ignores-redirect"); // DOM-01
});

describe("config loader — not built yet", () => {
  it.todo("rejects-world-writable-policy"); // CONF-01
});
