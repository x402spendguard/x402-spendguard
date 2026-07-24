// PKG teeth — proves PKG-01..05 against a REAL tarball, the way the cross-process smoke test proves
// ACCT-05 against real processes. We `npm pack` the package, unpack it into a throwaway node_modules,
// and then attack it from a consumer's position:
//   - the barrel imports and the guard actually RUNS (the artifact is self-contained + executable);
//   - a runtime deep-import throws ERR_PACKAGE_PATH_NOT_EXPORTED (the exports map is the sole path);
//   - a TYPE deep-import fails `tsc` under nodenext (the block holds for types, not just runtime);
//   - the shipped file list carries no .ts source, no .map, no test/e2e code, no secret.
// Opt-in (it builds + packs); runs in the CI `e2e` job, never the hermetic default gate.
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PKG_NAME = "x402-spendguard";

/** Run a command, returning {code, stdout, stderr}. Never throws on a nonzero exit — the code is data. */
function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {},
): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(cmd, args, { cwd: opts.cwd ?? ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return { code: err.status ?? 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
  }
}

let tarball = "";
let shipped: string[] = []; // package-relative paths inside the tarball (dist/index.js, …)
let installDir = ""; // a throwaway consumer project: <installDir>/node_modules/x402-spendguard

beforeAll(() => {
  // `npm pack` triggers the `prepack` build, so the tarball reflects a fresh compile.
  const packDest = mkdtempSync(join(tmpdir(), "x402-pack-"));
  const packed = run("npm", ["pack", "--json", "--pack-destination", packDest]);
  expect(packed.code, `npm pack failed:\n${packed.stderr}`).toBe(0);
  const meta = JSON.parse(packed.stdout) as { filename: string }[];
  tarball = join(packDest, meta[0].filename);
  expect(existsSync(tarball)).toBe(true);

  // Ground-truth the shipped file list from the actual archive (not npm's own report).
  const listed = run("tar", ["-tzf", tarball]);
  expect(listed.code).toBe(0);
  shipped = listed.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((p) => p.replace(/^package\//, ""));

  // Install by hand into node_modules — no `npm install`, so the test stays hermetic (no registry).
  installDir = mkdtempSync(join(tmpdir(), "x402-consumer-"));
  const nm = join(installDir, "node_modules");
  mkdirSync(nm, { recursive: true });
  expect(run("tar", ["-xzf", tarball, "-C", nm]).code).toBe(0);
  renameSync(join(nm, "package"), join(nm, PKG_NAME));
}, 120_000);

describe("PKG teeth — a real packed-and-installed tarball", () => {
  it("packed-artifact-imports-and-runs", () => {
    // A consumer builds the documented flow using ONLY barrel exports — no low-level constructors.
    // `systemClock.now()` hands back a branded timestamp, so no brand-maker is needed.
    const consumer = join(installDir, "consume.mjs");
    const ledger = join(installDir, "ledger");
    writeFileSync(
      consumer,
      `
import {
  SpendGuard, FileSpendStore, systemClock, parsePolicy, createSpendGuardBinding,
  HashChainDecisionLog, sha256ChainHasher, assetKey, STARTER_POLICY_JSON,
} from "${PKG_NAME}";
import assert from "node:assert/strict";

const ledger = ${JSON.stringify(ledger)};

// ONBOARD-01/02: the starter reaches an npm-install user as code, and fails LOUD unedited.
assert.ok(STARTER_POLICY_JSON.includes("REPLACE_WITH"), "starter ships with fail-loud placeholders");
assert.ok(!parsePolicy(JSON.parse(STARTER_POLICY_JSON)).ok, "unedited starter must be rejected, not silently accepted");

// Build the caps key by construction (the documented way) — proves assetKey ships and is callable.
const capsKey = assetKey({ chain: "eip155:8453", token: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
assert.equal(capsKey, "eip155:8453|0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "assetKey builds the composite caps key");

const parsed = parsePolicy({
  halt: false,
  requireOriginMatch: false,
  allowlist: [{ address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", chain: "eip155:8453" }],
  caps: { [capsKey]:
    { perRequest: "1000000", perDomain: "5000000", global: "20000000" } },
  clockSkewSeconds: "60", maxAuthLifetimeSeconds: "3600", windowSeconds: "86400",
});
assert.ok(parsed.ok, "valid policy must parse");

// Invalid policy is rejected, not coerced — proves the parse boundary executes.
const bad = parsePolicy({ halt: "nope" });
assert.ok(!bad.ok, "invalid policy must be refused");

const store = new FileSpendStore(ledger, systemClock.now());
const guard = new SpendGuard(store, systemClock, parsed.value);

// snapshot() executes the real accounting/read path through the public surface.
const snap = await guard.snapshot();
assert.ok(Array.isArray(snap.byDenomination), "snapshot exposes byDenomination");
assert.ok(Array.isArray(snap.byDomain), "snapshot exposes byDomain");
assert.equal(snap.halt, false, "snapshot reflects kill-switch state");

// The adapter wiring loads and returns the three interposition points.
const binding = createSpendGuardBinding(guard);
for (const k of ["wrapSigner", "hook", "wrapFetch"]) assert.equal(typeof binding[k], "function", k);

// The audit primitive constructs from the barrel too.
const log = new HashChainDecisionLog(ledger + ".audit", sha256ChainHasher);
assert.equal(typeof log.append, "function");

console.log("OK");
`,
    );
    const res = run("node", [consumer], { cwd: installDir });
    expect(res.code, `consumer failed:\n${res.stdout}\n${res.stderr}`).toBe(0);
    expect(res.stdout).toContain("OK");
  });

  it("runtime-deep-import-is-blocked", () => {
    const probe = join(installDir, "deep.mjs");
    // The internal file physically exists in dist/ — but the exports map must make it unreachable.
    writeFileSync(
      probe,
      `
import assert from "node:assert/strict";
try {
  await import("${PKG_NAME}/dist/adapters/x402-guarded-signer.js");
  console.error("LEAK: internal deep-import resolved");
  process.exit(2);
} catch (e) {
  assert.equal(e.code, "ERR_PACKAGE_PATH_NOT_EXPORTED", "expected exports-map block, got: " + e.code);
  console.log("BLOCKED");
}
`,
    );
    const res = run("node", [probe], { cwd: installDir });
    expect(res.code, `${res.stdout}\n${res.stderr}`).toBe(0);
    expect(res.stdout).toContain("BLOCKED");
  });

  it("type-deep-import-is-blocked", () => {
    // The barrel is the sole path for TYPES too: under nodenext resolution, tsc honors the exports
    // map, so a deep type-import cannot resolve even though the .d.ts file exists on disk.
    const tsc = join(ROOT, "node_modules", ".bin", "tsc");
    const mkTsconfig = (name: string, file: string) => {
      const p = join(installDir, name);
      writeFileSync(
        p,
        JSON.stringify({
          compilerOptions: {
            module: "nodenext",
            moduleResolution: "nodenext",
            noEmit: true,
            strict: true,
            skipLibCheck: true,
            types: [],
          },
          files: [file],
        }),
      );
      return p;
    };

    // Positive control: importing types FROM THE BARREL must compile clean.
    writeFileSync(
      join(installDir, "good.ts"),
      `import type { Policy, SpendGuardBinding, SpendStore } from "${PKG_NAME}";\n` +
        `export const _p = (x: Policy): SpendGuardBinding | SpendStore => x as any;\n`,
    );
    const good = run(tsc, ["-p", mkTsconfig("tsconfig.good.json", "./good.ts")], { cwd: installDir });
    expect(good.code, `barrel type import should compile:\n${good.stdout}`).toBe(0);

    // The attack: a deep type-import of an internal symbol must FAIL to resolve.
    writeFileSync(
      join(installDir, "bad.ts"),
      `import type { guardedSigner } from "${PKG_NAME}/dist/adapters/x402-guarded-signer.js";\n` +
        `export type _T = typeof guardedSigner;\n`,
    );
    const bad = run(tsc, ["-p", mkTsconfig("tsconfig.bad.json", "./bad.ts")], { cwd: installDir });
    expect(bad.code, "deep type-import must NOT resolve (exports map should block it)").not.toBe(0);
    expect(bad.stdout + bad.stderr).toMatch(/Cannot find module|not.*exported|TS2307|TS2724/i);
  });

  it("packed-tarball-ships-only-dist", () => {
    // Must ship the compiled entry + its declaration.
    expect(shipped).toContain("dist/index.js");
    expect(shipped).toContain("dist/index.d.ts");

    // Must NOT ship: source .ts (excluding .d.ts), any map, test/e2e code, or a secret file.
    const offenders = shipped.filter(
      (p) =>
        (/\.ts$/.test(p) && !/\.d\.ts$/.test(p)) || // raw TS source
        /\.map$/.test(p) || // source/declaration maps
        /(^|\/)(test|tests)\//.test(p) ||
        /e2e/i.test(p) ||
        /\.test\./.test(p) ||
        /(^|\/)\.npmrc$/.test(p) ||
        /(^|\/)\.env/.test(p),
    );
    expect(offenders, `unexpected files shipped: ${offenders.join(", ")}`).toEqual([]);

    // Everything under a directory must be under dist/ (nothing stray at other paths).
    const nonDist = shipped.filter((p) => p.includes("/") && !p.startsWith("dist/"));
    expect(nonDist, `files outside dist/: ${nonDist.join(", ")}`).toEqual([]);
  });
});
