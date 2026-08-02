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
    // Return a forward-slash path so the "/adapters/" and "/policy/" classifiers are platform-independent
    // (on Windows fileURLToPath yields backslashes); the read still uses the native `p`.
    else if (entry.name.endsWith(".ts")) out.push([p.replace(/\\/g, "/"), readFileSync(p, "utf8")]);
  }
  return out;
}

/** Strip comments and string/template literals so we scan CODE, not prose or messages. Use this for
 *  CALL/identifier patterns (`fetch(`, `Date.now(`), so a name appearing inside a string message can't
 *  false-positive. Do NOT use it for import-specifier matching — it blanks the specifier (see below). */
function stripCommentsAndStrings(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .replace(/`(?:[^`\\]|\\.)*`/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, " ")
    .replace(/'(?:[^'\\]|\\.)*'/g, " ");
}

/** Strip ONLY comments, KEEPING string literals — so import/require MODULE SPECIFIERS survive to be
 *  matched. Matching module bans against fully string-stripped code is why the old import denylist was
 *  silently VACUOUS: the `"node:net"` specifier was blanked to whitespace before the pattern ran, so a
 *  planted `import ... from "node:net"` in src/ passed the "no-egress" test. Import patterns anchor to
 *  from/import/require, so a `//`-mangled URL left inside a surviving string can't false-positive. */
function stripCommentsOnly(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}

describe("supply chain (DEP-01)", () => {
  it("core-zero-deps", () => {
    const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
    const deps = pkg.dependencies ?? {};
    expect(Object.keys(deps)).toHaveLength(0);
  });
});

describe("no egress (PRIV-01, PRIV-03)", () => {
  // MODULE bans — a module the core imports could reach outside the process (network) or spawn an
  // external program (child_process). Matched against comment-stripped code that KEEPS strings, so the
  // specifier is visible. Covers static `from "x"`, side-effect `import "x"`, dynamic `import("x")`,
  // and `require("x")`. `child_process` is banned by decision D-042: the core must never spawn a
  // subprocess — a capability like ACL/icacls hardening belongs in a sibling package, never a carve-out
  // in this proof (the same reasoning that kept the routing socket out of the core; see decisions.md).
  const forbiddenImports = [
    /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'](?:node:)?(?:child_process|net|http|https|http2|dgram|dns|tls)["']/,
    /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'](?:axios|undici|node-fetch|ws|got)["']/,
  ];
  // CALL/global bans — matched against fully-stripped code (no strings) so a name inside a string
  // message can't false-positive.
  const forbiddenCalls = [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bnavigator\b/];

  it("core-has-no-egress", () => {
    for (const [path, code] of srcFiles()) {
      const specifiers = stripCommentsOnly(code);
      const calls = stripCommentsAndStrings(code);
      for (const pat of forbiddenImports) {
        expect(pat.test(specifiers), `${path} imports an egress-capable module (${pat})`).toBe(false);
      }
      for (const pat of forbiddenCalls) {
        expect(pat.test(calls), `${path} matches ${pat}`).toBe(false);
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
      // The pure policy core opens no store (no filesystem). Adapters/accounting may. Matched on
      // comment-stripped-but-string-kept code (the `from "node:fs"` check was vacuous the same way).
      if (path.includes("/policy/")) {
        const specifiers = stripCommentsOnly(code);
        expect(
          /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'](?:node:)?fs(?:\/promises)?["']/.test(specifiers),
          `${path} imports fs`,
        ).toBe(false);
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
