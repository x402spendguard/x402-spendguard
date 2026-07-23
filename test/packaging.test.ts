// PKG-01..05 — the hermetic guarantees behind the published artifact. These assert the *contract*
// (the barrel's frozen surface, the single-entry manifest, the src-only/map-free build); the
// end-to-end proof that a real tarball actually honors them is test/e2e/pack-install.e2e.test.ts.
//
// "Don't break userspace": what we publish is a forever contract. PKG-01 is the tripwire — it fails
// the build if the public surface changes without a deliberate edit to the frozen list below.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as api from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as Record<string, unknown>;

/**
 * THE FROZEN PUBLIC SURFACE (values). Adding to or removing from this list is a deliberate act —
 * a breaking change if it's a removal. Type-only exports carry no runtime binding, so they are not
 * listed here; their presence is proven by the type fixtures in the e2e pack test.
 */
const FROZEN_VALUE_EXPORTS = [
  // construct + wire (the documented flow)
  "SpendGuard",
  "LoggingGuard",
  "createSpendGuardBinding",
  "FileSpendStore",
  "systemClock",
  "loadPolicyFile",
  "parsePolicy",
  "assetKey",
  // audit (opt-in, tamper-evident)
  "HashChainDecisionLog",
  "sha256ChainHasher",
  "hmacChainHasher",
  // errors a consumer catches
  "PaymentBlockedError",
  "SnapshotUnreadableError",
].sort();

describe("PKG — the published artifact", () => {
  it("public-surface-is-frozen", () => {
    const actual = Object.keys(api)
      .filter((k) => (api as Record<string, unknown>)[k] !== undefined)
      .sort();
    // Exact equality both ways: nothing crept in, nothing silently dropped.
    expect(actual).toEqual(FROZEN_VALUE_EXPORTS);
  });

  it("package-manifest-is-single-entry", () => {
    const pkg = readJson("package.json");
    const exportsMap = pkg.exports as Record<string, unknown>;
    expect(exportsMap).toBeTypeOf("object");
    // Only the barrel and package.json are exposed — the sole public path.
    expect(Object.keys(exportsMap).sort()).toEqual([".", "./package.json"]);
    const dot = exportsMap["."] as Record<string, string>;
    expect(dot.types).toBe("./dist/index.d.ts");
    // `default` (or `import`) must resolve into the compiled barrel.
    expect(dot.default ?? dot.import).toBe("./dist/index.js");
    expect(pkg.main).toBe("./dist/index.js");
    expect(pkg.types).toBe("./dist/index.d.ts");
    // Pure re-export barrel — safe to tree-shake.
    expect(pkg.sideEffects).toBe(false);
    // The artifact uses node: builtins (fs modes, link, crypto) that need a modern runtime.
    expect((pkg.engines as Record<string, string> | undefined)?.node).toBeTruthy();
  });

  it("build-emits-from-src-only", () => {
    const tsc = readJson("tsconfig.build.json");
    const opts = (tsc.compilerOptions ?? {}) as Record<string, unknown>;
    // src only — never the test tree — rooted so output is dist/index.js, not dist/src/index.js.
    expect(tsc.include).toEqual(["src"]);
    expect(["src", "./src"]).toContain(opts.rootDir);
    expect(opts.outDir).toBe("dist");
    expect(opts.declaration).toBe(true);
    // Maps OFF: a shipped map would dangle against un-shipped source or leak an absolute local path.
    expect(opts.sourceMap).not.toBe(true);
    expect(opts.declarationMap).not.toBe(true);
    expect(opts.inlineSources).not.toBe(true);
  });

  it("exports-map-blocks-deep-imports", () => {
    const pkg = readJson("package.json");
    const exportsMap = pkg.exports as Record<string, unknown>;
    // No internal subpath, and — critically — no wildcard "./*" that would re-open the whole tree.
    for (const key of Object.keys(exportsMap)) {
      expect(key === "." || key === "./package.json").toBe(true);
      expect(key).not.toContain("*");
    }
  });

  it("publish-ships-only-dist", () => {
    const pkg = readJson("package.json");
    // The allowlist ships dist only; README/LICENSE/package.json are added by npm itself.
    expect(pkg.files).toEqual(["dist"]);
    // Belt-and-suspenders with build-emits-from-src-only: no maps can be emitted into what ships.
    const opts = ((readJson("tsconfig.build.json").compilerOptions ?? {}) as Record<string, unknown>);
    expect(opts.sourceMap).not.toBe(true);
    expect(opts.declarationMap).not.toBe(true);
  });
});
