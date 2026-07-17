// The meta-test that makes "every requirement names a test" a fact, not a hope.
//
// It reads REQUIREMENTS.md, extracts every test name promised in a requirement
// table's Test column, and asserts each exists as an `it(...)` or `it.todo(...)`
// somewhere in the suite. A requirement whose test is missing turns this red.
// This is what keeps the requirements and the tests from silently drifting apart.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { requiredTestNames as parseRequiredTestNames } from "../scripts/lib/requirements.js";

const testDir = fileURLToPath(new URL("./", import.meta.url));
const requirementsPath = fileURLToPath(new URL("../REQUIREMENTS.md", import.meta.url));

/** Test names promised by REQUIREMENTS.md. Shared with the traceability-matrix generator
 *  (scripts/gen-traceability.ts) so the enforced mapping and the published matrix cannot diverge. */
function requiredTestNames(): Set<string> {
  return parseRequiredTestNames(readFileSync(requirementsPath, "utf8"));
}

/** Every test title declared via it(...) or it.todo(...) across the suite. */
function declaredTestNames(): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(testDir)) {
    if (!file.endsWith(".test.ts")) continue;
    const code = readFileSync(`${testDir}${file}`, "utf8");
    for (const m of code.matchAll(/\bit(?:\.todo|\.skip)?\s*\(\s*["'`]([^"'`]+)["'`]/g)) names.add(m[1]);
  }
  return names;
}

describe("traceability (every requirement names a test)", () => {
  it("every [v1] requirement has a test that exists in the suite", () => {
    const required = requiredTestNames();
    const declared = declaredTestNames();
    // Sanity: we actually found requirements to check.
    expect(required.size).toBeGreaterThan(20);
    const missing = [...required].filter((n) => !declared.has(n)).sort();
    expect(missing, `requirements with no test in the suite:\n  ${missing.join("\n  ")}`).toEqual([]);
  });
});
