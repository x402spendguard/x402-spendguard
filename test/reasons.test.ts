import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  REASONS,
  DECISION_REASONS,
  CONFIG_REASONS,
  OTHER_REASONS,
  isReasonCode,
} from "../src/reasons.js";

const SRC = new URL("../src", import.meta.url).pathname;

/** Every .ts under src/, recursively. */
function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("reason registry — the single source of truth", () => {
  // COMPLETENESS BY CONSTRUCTION. The legend can only claim to cover every code if no code can be
  // emitted from outside the registry. Emit sites reach a code one of two ways: as a TYPED helper
  // argument (deny/err/fail/error-ctor, constrained to a partition — the compiler rejects a stranger)
  // or as a raw `reason: "..."` object-literal property (the BYPASS — unchecked). This test forbids
  // the bypass everywhere but reasons.ts, so every code must originate here, whatever its carrier.
  it("no-reason-code-escapes-the-registry", () => {
    // A `reason:` property assigned a string literal whose VALUE is code-shaped (dotted or a bare
    // lowercase word, no spaces). This deliberately spares the audit layer's `VerifyResult.reason`,
    // which is free-text human diagnostic prose ("hash mismatch (record tampered)") — a different
    // contract from a machine code — while still catching a machine code that sneaks in anywhere.
    const CODE = /^[a-z][a-z_]*(\.[a-z_]+)*$/;
    const RE = /reason\s*:\s*(['"`])([^'"`]*)\1/g;
    const offenders: string[] = [];
    for (const file of srcFiles(SRC)) {
      if (file.endsWith("/reasons.ts")) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const trimmed = line.trim();
          if (trimmed.startsWith("//") || trimmed.startsWith("*")) return; // skip comment lines
          const code = line.split("//")[0]; // strip any trailing line comment
          for (const m of code.matchAll(RE)) {
            if (CODE.test(m[2])) offenders.push(`${file.replace(SRC, "src")}:${i + 1}: ${trimmed}`);
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
