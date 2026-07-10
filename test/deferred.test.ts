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
