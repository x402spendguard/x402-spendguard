// Single source of truth for parsing REQUIREMENTS.md — imported by BOTH the traceability meta-test
// (test/traceability.test.ts, which enforces every requirement names an existing test) and the
// traceability-matrix generator (scripts/gen-traceability.ts, which renders TRACEABILITY.md). Sharing
// this keeps the enforced mapping and the published matrix from ever drifting apart.

export interface Requirement {
  id: string;
  /** The requirement text (markdown), as written in the table. */
  description: string;
  /** The Threat column (e.g. "T15", "(design)"). */
  threat: string;
  /** The kebab-case test name(s) named in the Test column. */
  tests: string[];
}

/**
 * Parse the requirement rows of REQUIREMENTS.md — table rows whose first cell carries a requirement
 * id like **ACCT-06**. Returns them in document order. Non-requirement table rows (headers,
 * separators, notes) are ignored.
 */
export function parseRequirements(md: string): Requirement[] {
  const reqs: Requirement[] = [];
  for (const line of md.split("\n")) {
    if (!/^\s*\|/.test(line)) continue; // table rows only
    const cells = line.split("|").map((c) => c.trim());
    // cells[0] is the empty string before the leading "|"; cells[1] is the id cell.
    const idMatch = cells[1]?.match(/\*\*([A-Z]+-\d+)\*\*/);
    if (!idMatch) continue;
    const last = (cells[cells.length - 1] || cells[cells.length - 2]) ?? "";
    const tests = [...last.matchAll(/`([a-z][a-z0-9-]+)`/g)].map((m) => m[1]);
    reqs.push({ id: idMatch[1], description: cells[2] ?? "", threat: cells[3] ?? "", tests });
  }
  return reqs;
}

/** Every distinct test name promised by a requirement — the set the traceability gate enforces. */
export function requiredTestNames(md: string): Set<string> {
  const names = new Set<string>();
  for (const r of parseRequirements(md)) for (const t of r.tests) names.add(t);
  return names;
}
