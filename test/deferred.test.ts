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

describe("cross-process accounting — not built yet", () => {
  // ACCT-05: the bundled file store has no cross-process lock. Closing this needs an
  // OS/advisory-locked or compare-and-swap store. Flagged by external review 2026-07-10.
  it.todo("cross-process-cannot-both-pass"); // ACCT-05
});

// FAIL-03 audit half (`audit-failure-preserves-decision`) and PRIV-02
// (`log-never-contains-signature`) are now REAL tests — see decision-log.test.ts.

// DOM-01 (`domain-derivation-ignores-redirect`) is now a REAL test — see x402-transport.test.ts.

// CONF-01 (`rejects-world-writable-policy`) is now a REAL test — see config.test.ts.
