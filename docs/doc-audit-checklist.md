# Doc audit checklist

Run this before tagging a release.

The automated gate — [`test/docs-integrity.test.ts`](../test/docs-integrity.test.ts), part of
`npm test` — catches the **deterministic** doc-rot classes and turns the suite red if they
reappear:

- dead internal links and anchors,
- a `## Status` version that no longer matches `package.json`,
- README property-test / invariant counts that have drifted from the suite.

It **cannot** catch the classes that need a human read. Those are this list:

- [ ] **`npm test` is green** — this includes the docs-integrity gate above.
- [ ] **Re-read the state-describing docs against current reality** — README (`## Status`,
      `## What's proven`), [SECURITY.md](../SECURITY.md), [releasing.md](releasing.md),
      [roadmap.md](roadmap.md). These describe *current* state and rot as the code advances; they
      are the docs most likely to have drifted since they were last touched. (This is the exact
      class the 2026-07 audit found: SECURITY.md said "cannot yet stop a real payment"; releasing
      said "armed but not fired / held at 0.1.4" — both two releases stale.)
- [ ] **Scan for shipped author-notes / TODOs** — prose written for *us*, not the reader:
      `grep -rnE "TODO|FIXME|XXX|belongs in|note to self|rewrite this|verbatim" -- '*.md'`, then
      read each hit and confirm it is legitimate content, not a note-to-self that shipped. (The
      audit found "This sentence belongs in the README verbatim, or the README oversells" living
      in the threat model.) Most hits are legitimate ("policy belongs in userspace"); the human
      judgment is the point — this stays a checklist item, not a machine gate.
- [ ] **Every new citation is locatable** — any "we reviewed X" / "as documented in Y" must point
      at a producible source (a file, a URL, a commit). A credit to a document that cannot be
      produced is the phantom-citation failure class; do not ship it. (The audit found one such
      credit propagated across three docs.)
- [ ] **Counts and versions in other docs match reality** — the gate checks the README's; eyeball
      any other doc that states a number or a version.

**Why this exists:** diff-scoped review cannot catch rot in prose that is never in a diff, so a
corpus-level check is needed that does not depend on someone happening to re-read. The gate
mechanizes the deterministic part; this checklist covers the judgment part.
