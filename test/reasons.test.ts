import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  REASONS,
  DECISION_REASONS,
  CONFIG_REASONS,
  OTHER_REASONS,
  isReasonCode,
} from "../src/reasons.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Every .ts under src/, recursively. Returns forward-slash paths so the exclude/display logic is
 *  platform-independent (fileURLToPath yields backslashes on Windows); Node reads either separator. */
function srcFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}${entry.name}`;
    if (entry.isDirectory()) out.push(...srcFiles(`${p}/`));
    else if (entry.name.endsWith(".ts")) out.push(p.replace(/\\/g, "/"));
  }
  return out;
}

describe("reason registry — the single source of truth", () => {
  // COMPLETENESS BY CONSTRUCTION — via TWO complementary gates, not this regex alone. Read this
  // before assuming the check below is a complete literal scan (it is deliberately NOT):
  //   1. TYPE SYSTEM (the primary gate). The emit helpers take a closed key-union parameter —
  //      deny()/allow() → DecisionReason, err()/fail() → ConfigReason — so a positional argument
  //      that isn't a registry key fails to compile. This covers the ordinary emit path; the regex
  //      below never sees it and doesn't need to.
  //   2. THIS STATIC CHECK (the backstop). It covers ONLY the raw `reason: "..."` OBJECT-LITERAL
  //      shape — the one bypass the type system can't catch, because `PolicyDecision.reason` /
  //      `Result.reason` are structurally assignable from any string. It does NOT scan positional
  //      args (gate 1 owns those). The only residual is a deliberate `as any` cast, a self-inflicted
  //      wound no gate can prevent.
  // Together: types block the ordinary path, the regex blocks the object-literal path types can't see.
  it("no-reason-code-escapes-the-registry", () => {
    // A `reason:` property assigned a string literal whose VALUE is code-shaped (dotted or a bare
    // lowercase word, no spaces). This deliberately spares the audit layer's `VerifyResult.reason`,
    // which is free-text human diagnostic prose ("hash mismatch (record tampered)") — a different
    // contract from a machine code — while still catching a machine code that sneaks in anywhere.
    const CODE = /^[a-z][a-z_]*(\.[a-z_]+)*$/;
    const RE = /reason\s*:\s*(['"`])([^'"`]*)\1/g;
    const offenders: string[] = [];
    for (const file of srcFiles()) {
      if (file.endsWith("/reasons.ts")) continue;
      const shown = file.replace(/^.*\/src\//, "src/"); // platform-independent display
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const trimmed = line.trim();
          if (trimmed.startsWith("//") || trimmed.startsWith("*")) return; // skip comment lines
          const code = line.split("//")[0]; // strip any trailing line comment
          for (const m of code.matchAll(RE)) {
            if (CODE.test(m[2])) offenders.push(`${shown}:${i + 1}: ${trimmed}`);
          }
        });
    }
    expect(offenders, `raw reason literals must route through a typed helper:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("DECISION and CONFIG partitions are disjoint (a verdict can never be a config code)", () => {
    const d = Object.keys(DECISION_REASONS);
    const c = Object.keys(CONFIG_REASONS);
    expect(d.filter((k) => (c as string[]).includes(k))).toEqual([]);
  });

  it("REASONS is exactly the union of the three partitions", () => {
    const union = [
      ...Object.keys(DECISION_REASONS),
      ...Object.keys(CONFIG_REASONS),
      ...Object.keys(OTHER_REASONS),
    ].sort();
    expect(Object.keys(REASONS).sort()).toEqual(union);
  });

  it("every code carries complete, well-formed legend metadata", () => {
    for (const [code, meta] of Object.entries(REASONS)) {
      expect(meta.means.length, `${code}.means`).toBeGreaterThan(0);
      expect(meta.fix.length, `${code}.fix`).toBeGreaterThan(0);
      expect(["policy-load", "payment", "read-api"], `${code}.when`).toContain(meta.when);
    }
  });

  it("isReasonCode accepts registered codes and rejects strangers", () => {
    expect(isReasonCode("halt")).toBe(true);
    expect(isReasonCode("config.cap_key_malformed")).toBe(true);
    expect(isReasonCode("not.a.real.code")).toBe(false);
    expect(isReasonCode(42)).toBe(false);
  });
});
