// Doc-integrity gate: makes "the docs match reality" a fact, not a hope.
//
// The durable half of the 2026-07 documentation-integrity scrub. A corpus-wide claim audit
// found rot that diff-scoped review structurally cannot catch — dead anchors, a stale
// current-version claim, drifted counts — because prose that is never in a diff is never
// re-read. This test mechanizes the DETERMINISTIC rot classes so they turn the suite red
// instead of shipping. The judgment classes (shipped author-notes, re-reading state-prose)
// live in docs/doc-audit-checklist.md, run before a release.
//
// Every check here is mutation-proven: reintroduce the rot and this goes red.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/** Every tracked markdown file (absolute paths), skipping vendored/build dirs. */
function markdownFiles(dir = repoRoot, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) markdownFiles(full, acc);
    else if (entry.endsWith(".md")) acc.push(full);
  }
  return acc;
}

/** GitHub-style heading → anchor slug: lowercase, drop punctuation, spaces → hyphens.
 *  Limitation: does not append GitHub's `-1`/`-2` disambiguator for DUPLICATE headings.
 *  The corpus has none today, and the failure direction is safe — an ambiguous case would
 *  flag rather than silently pass a dead anchor. */
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 \-]/g, "")
    .replace(/ /g, "-");
}

/** Remove fenced code blocks and inline code so code samples can't masquerade as links. */
function stripCode(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]*`/g, "");
}

/** The set of anchor slugs a file exposes (one per heading). */
function headingSlugs(absPath: string): Set<string> {
  const slugs = new Set<string>();
  for (const line of stripCode(readFileSync(absPath, "utf8")).split("\n")) {
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) slugs.add(slugify(m[1]));
  }
  return slugs;
}

/** Internal (non-URL) markdown links in a file: {target path, optional #anchor}. */
function internalLinks(md: string): { target: string; anchor: string | null }[] {
  const links: { target: string; anchor: string | null }[] = [];
  for (const m of stripCode(md).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let url = m[1].trim().split(/\s+/)[0]; // drop any "title"
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) continue; // http:, mailto:, …
    if (url.startsWith("#")) {
      links.push({ target: "", anchor: url.slice(1) });
      continue;
    }
    const [target, anchor] = url.split("#");
    links.push({ target, anchor: anchor ?? null });
  }
  return links;
}

const slugCache = new Map<string, Set<string>>();
function slugsFor(absPath: string): Set<string> {
  if (!slugCache.has(absPath)) slugCache.set(absPath, headingSlugs(absPath));
  return slugCache.get(absPath)!;
}

describe("doc integrity (the docs match reality, mechanically)", () => {
  it("every internal doc link and anchor resolves", () => {
    const dead: string[] = [];
    for (const file of markdownFiles()) {
      const rel = relative(repoRoot, file);
      const content = readFileSync(file, "utf8");
      for (const { target, anchor } of internalLinks(content)) {
        const targetAbs = target === "" ? file : resolve(dirname(file), target);
        if (target !== "" && !existsSync(targetAbs)) {
          dead.push(`${rel}: link target not found → ${target}${anchor ? "#" + anchor : ""}`);
          continue;
        }
        if (anchor && statSync(targetAbs).isFile() && !slugsFor(targetAbs).has(anchor)) {
          dead.push(`${rel}: anchor not found → ${target || "(self)"}#${anchor}`);
        }
      }
    }
    // Sanity: we actually parsed a corpus with links (guards against a broken walker/regex).
    expect(markdownFiles().length).toBeGreaterThan(10);
    expect(dead, `dead internal links / anchors:\n  ${dead.join("\n  ")}`).toEqual([]);
  });

  it("the README states the current package version", () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
    const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");
    const status = /##\s+Status\b([\s\S]*?)(?:\n##\s|$)/.exec(readme);
    expect(status, "README has a ## Status section").toBeTruthy();
    expect(
      status![1].includes(pkg.version),
      `README ## Status must state the current version ${pkg.version} (from package.json)`,
    ).toBe(true);
  });

  it("the README's property-test and invariant counts match the suite", () => {
    const readme = readFileSync(resolve(repoRoot, "README.md"), "utf8");
    const props = readFileSync(resolve(repoRoot, "test/properties.test.ts"), "utf8");

    const propertyTests = [...props.matchAll(/\bit(?:\.\w+)?\s*\(\s*["'`]/g)].length;
    const invariants = new Set(
      [...props.matchAll(/\bit(?:\.\w+)?\s*\(\s*["'`]\s*(INV-\d+|CLOCK-\d+|hash-chain)/g)].map((m) => m[1]),
    ).size;

    const phrase = /(\w+) `fast-check` property tests covering (\w+) invariants/.exec(readme);
    expect(phrase, "README states '<n> `fast-check` property tests covering <m> invariants'").toBeTruthy();

    const words: Record<string, number> = {
      one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
      nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    };
    const toNum = (w: string) => words[w.toLowerCase()] ?? Number(w);

    expect(
      toNum(phrase![1]),
      `README says "${phrase![1]}" property tests; the suite has ${propertyTests}`,
    ).toBe(propertyTests);
    expect(
      toNum(phrase![2]),
      `README says "${phrase![2]}" invariants; the suite has ${invariants}`,
    ).toBe(invariants);
  });
});
