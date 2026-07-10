// Static / build-time checks. These assert properties of the SOURCE, not runtime
// behavior — the kind of guarantee ("no egress", "zero deps", "no hidden opinion")
// that is only meaningful if proven against the code itself.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
const root = fileURLToPath(new URL("../", import.meta.url));

/** Read every .ts file under src/ (recursively), returning [path, contents]. */
function srcFiles(dir = srcDir): [string, string][] {
  const out: [string, string][] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}${entry.name}`;
    if (entry.isDirectory()) out.push(...srcFiles(`${p}/`));
    else if (entry.name.endsWith(".ts")) out.push([p, readFileSync(p, "utf8")]);
  }
  return out;
}

/** Strip comments and string/template literals so we scan CODE, not prose or messages. */
function stripCommentsAndStrings(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .replace(/`(?:[^`\\]|\\.)*`/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, " ")
    .replace(/'(?:[^'\\]|\\.)*'/g, " ");
}

describe("supply chain (DEP-01)", () => {
  it("core-zero-deps", () => {
    const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
    const deps = pkg.dependencies ?? {};
    expect(Object.keys(deps)).toHaveLength(0);
  });
});

describe("no egress (PRIV-01, PRIV-03)", () => {
  const forbidden = [
    /\bfrom\s+["']node:(http|https|net|dgram|dns|tls)["']/,
    /\bfrom\s+["'](http|https|net|axios|undici|node-fetch|ws|got)["']/,
    /\brequire\(\s*["'](node:)?(http|https|net|axios|undici|node-fetch|ws)["']/,
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bnavigator\b/,
  ];

  it("core-has-no-egress", () => {
    for (const [path, code] of srcFiles()) {
      const stripped = stripCommentsAndStrings(code);
      for (const pat of forbidden) {
        expect(pat.test(stripped), `${path} matches ${pat}`).toBe(false);
      }
    }
  });

  it("no-telemetry-calls", () => {
    // Same guarantee, named for the requirement it discharges: nothing phones home.
    for (const [path, code] of srcFiles()) {
      const stripped = stripCommentsAndStrings(code);
      expect(/\bfetch\s*\(/.test(stripped), `${path} calls fetch`).toBe(false);
    }
  });
});

describe("injected clock and store (INJ-01)", () => {
  it("no-ambient-clock-or-store", () => {
    for (const [path, code] of srcFiles()) {
      const stripped = stripCommentsAndStrings(code);
      const isAdapter = path.includes("/adapters/"); // the ONE sanctioned composition-root boundary
      // No module reads a wall clock or randomness ambiently — except the adapters,
      // which are exactly where the pure core meets the messy world (INJ-01).
      if (!isAdapter) {
        for (const pat of [/\bDate\.now\s*\(/, /\bnew\s+Date\s*\(/, /\bperformance\.now\s*\(/, /\bMath\.random\s*\(/]) {
          expect(pat.test(stripped), `${path} reads an ambient clock/rng via ${pat}`).toBe(false);
        }
      }
      // The pure policy core opens no store (no filesystem). Adapters/accounting may.
      if (path.includes("/policy/")) {
        expect(/\bfrom\s+["']node:fs["']/.test(stripped), `${path} imports fs`).toBe(false);
      }
    }
  });
});

describe("no policy in the guard (POL-01)", () => {
  it("no-deciding-literals-in-core", () => {
    // Heuristic guard: the enforcement path (checks.ts) must contain no numeric literal
    // other than the structural identity/emptiness values 0 and 0n. A hardcoded skew,
    // threshold, or cap would be a numeric literal here — an opinion baked into code.
    const code = readFileSync(`${srcDir}policy/checks.ts`, "utf8");
    const stripped = stripCommentsAndStrings(code);
    const literals = stripped.match(/\b\d+n?\b/g) ?? [];
    const offenders = literals.filter((l) => l !== "0" && l !== "0n");
    expect(offenders, `unexpected deciding literals in checks.ts: ${offenders.join(", ")}`).toEqual([]);
  });
});
