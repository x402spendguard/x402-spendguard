import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePolicy } from "../src/parse.js";
import { loadPolicyFile } from "../src/adapters/policy-file-loader.js";
import { CHAIN, USDC, PAYEE, key } from "./helpers.js";

// A canonical, well-formed policy as it appears ON DISK: money is decimal strings
// (JSON has no bigint), the cap key is the canonical "chain|token" coordinate.
const validPolicyObject = () => ({
  halt: false,
  allowlist: [{ address: PAYEE, chain: CHAIN }],
  caps: {
    [`${CHAIN}|${USDC}`]: { perRequest: "500000", perDomain: "5000000", global: "20000000" },
  },
  clockSkewSeconds: "60",
  maxAuthLifetimeSeconds: "3600",
  windowSeconds: "86400",
  requireOriginMatch: false,
});

// A private temp dir so we control file modes exactly (chmod after write beats umask).
const dir = mkdtempSync(join(tmpdir(), "spendguard-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
function writePolicy(contents: string, mode = 0o600): string {
  const path = join(dir, `policy-${seq++}.json`);
  writeFileSync(path, contents);
  chmodSync(path, mode); // set mode explicitly, independent of the process umask
  return path;
}

describe("config loader — CONF-01 (world-writable refusal)", () => {
  it("rejects-world-writable-policy", (ctx) => {
    if (process.platform === "win32") ctx.skip(); // PLAT-01: the world-writable refusal is skipped on Windows
    // A world-writable policy file could be tampered by any local user; refuse to load it.
    const path = writePolicy(JSON.stringify(validPolicyObject()), 0o666);
    const r = loadPolicyFile(path);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("config.world_writable");
  });

  it("loads a non-world-writable, well-formed policy", () => {
    const path = writePolicy(JSON.stringify(validPolicyObject()), 0o600);
    const r = loadPolicyFile(path);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.halt).toBe(false);
      expect(r.value.allowlist).toEqual([{ address: PAYEE, chain: CHAIN }]);
      expect(r.value.clockSkewSeconds).toBe(60n);
      expect(r.value.windowSeconds).toBe(86_400n);
      expect(r.value.caps[key].perRequest).toBe(500_000n);
    }
  });

  it("group-writable is permitted (CONF-01 is scoped to world-writable only)", () => {
    // Mechanism, not judgment: the requirement names world-writable. Do not silently
    // widen it to group-writable — that would be the guard inventing policy.
    const path = writePolicy(JSON.stringify(validPolicyObject()), 0o620);
    expect(loadPolicyFile(path).ok).toBe(true);
  });

  it("rejects-world-writable-policy-dir", (ctx) => {
    if (process.platform === "win32") ctx.skip(); // PLAT-01: world-writable is meaningless under synthesized win32 modes
    // CONF-03: a 0o600 policy file in a WORLD-WRITABLE DIRECTORY is still swappable — dir-write governs
    // rename/replace, so any local user can substitute a permissive policy.json (also 0o600) that passes
    // the file-level check. Refuse the directory, not just the file. (Own temp dir — the shared one stays 0o700.)
    const d = mkdtempSync(join(tmpdir(), "spendguard-dirperm-"));
    try {
      const p = join(d, "policy.json");
      writeFileSync(p, JSON.stringify(validPolicyObject()));
      chmodSync(p, 0o600); // the file itself is fine
      chmodSync(d, 0o777); // its directory is world-writable
      const r = loadPolicyFile(p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("config.dir_world_writable");
    } finally {
      chmodSync(d, 0o700); // restore so cleanup can remove it
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("config loader — I/O failures fail closed", () => {
  it("missing file is a specific, non-throwing failure", () => {
    const r = loadPolicyFile(join(dir, "does-not-exist.json"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("config.file_unreadable");
  });

  it("malformed JSON is a specific, non-throwing failure", () => {
    const path = writePolicy("{ not valid json ", 0o600);
    const r = loadPolicyFile(path);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("config.json_malformed");
  });
});

describe("parsePolicy — parse, don't validate (untrusted JSON → trustworthy Policy)", () => {
  it("parse-into-trustworthy-policy", () => {
    // CONF-02, the load-bearing contract in one place: parse untrusted JSON into a trustworthy
    // Policy — brand + canonicalize on accept, reject-with-reason (never default) on anything broken.
    // The per-field cases below are the detailed coverage; this is the named requirement anchor.
    const ok = parsePolicy(validPolicyObject());
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(typeof ok.value.caps[key].global).toBe("bigint"); // money branded, not left a string/number
      expect(ok.value.maxAuthLifetimeSeconds).toBe(3_600n); // time branded through the primitive
      expect(ok.value.caps[key].perRequest).toBe(500_000n); // cap key canonicalized to the assetKey coordinate
    }
    // Reject, never DEFAULT: a partial policy missing `halt` must be refused, not silently defaulted
    // to halt=false (which would quietly weaken the guard). No code-side default fills the gap.
    const { halt: _omit, ...missingHalt } = validPolicyObject();
    const partial = parsePolicy(missingHalt);
    expect(partial.ok).toBe(false);
    if (!partial.ok) expect(partial.reason).toBe("config.halt_invalid");
    // Reject, never COERCE: a wrong-typed money value (a bare JSON number) is refused, not truncated.
    const wrongType = { ...validPolicyObject(), caps: { [`${CHAIN}|${USDC}`]: { perRequest: 500000, perDomain: "5", global: "20" } } };
    expect(parsePolicy(wrongType).ok).toBe(false);
  });

  it("accepts a well-formed policy and brands its money as bigint", () => {
    const r = parsePolicy(validPolicyObject());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.maxAuthLifetimeSeconds).toBe(3_600n);
      expect(typeof r.value.caps[key].global).toBe("bigint");
    }
  });

  it("rejects a non-object", () => {
    expect(parsePolicy(null).ok).toBe(false);
    expect(parsePolicy(42).ok).toBe(false);
    const r = parsePolicy("nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("config.not_an_object");
  });

  it("rejects a missing/non-boolean halt (no code-side default — POL-01)", () => {
    const { halt, ...rest } = validPolicyObject();
    const r = parsePolicy(rest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("config.halt_invalid");
  });

  it("rejects a non-array allowlist", () => {
    const r = parsePolicy({ ...validPolicyObject(), allowlist: "everyone" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("config.allowlist_invalid");
  });

  it("rejects an allowlist entry with a malformed address", () => {
    const r = parsePolicy({ ...validPolicyObject(), allowlist: [{ address: "0xnothex", chain: CHAIN }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("parse.address_malformed");
  });

  it("rejects a cap amount that is not a non-negative integer", () => {
    const bad = {
      ...validPolicyObject(),
      caps: { [`${CHAIN}|${USDC}`]: { perRequest: "-1", perDomain: "5", global: "20" } },
    };
    const r = parsePolicy(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("parse.amount_malformed");
  });

  it("cap-amount-rejects-bare-number", () => {
    // Money on disk MUST be a decimal string. A bare JSON number is refused, not coerced —
    // which is what makes the >2^53 precision-loss path unreachable: you can never silently
    // get a different cap than you wrote, because a number-typed cap does not parse at all.
    const bareNumber = {
      ...validPolicyObject(),
      caps: { [`${CHAIN}|${USDC}`]: { perRequest: 500000, perDomain: "5", global: "20" } },
    };
    const r = parsePolicy(bareNumber);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("parse.amount_malformed");

    // Explicitly cover the precision-danger magnitude: 2^53 + 1 as a bare number also rejects.
    const overSafeInt = {
      ...validPolicyObject(),
      caps: { [`${CHAIN}|${USDC}`]: { perRequest: 9007199254740993, perDomain: "5", global: "20" } },
    };
    expect(parsePolicy(overSafeInt).ok).toBe(false);
  });

  it("rejects a cap key that is not a canonical chain|token coordinate", () => {
    const bad = {
      ...validPolicyObject(),
      caps: { "not-a-coordinate": { perRequest: "1", perDomain: "5", global: "20" } },
    };
    const r = parsePolicy(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("config.cap_key_malformed");
  });

  it("canonicalizes a cap key so a checksum-cased token address still applies", () => {
    // The engine looks up caps by the lowercase-canonical assetKey. A user who writes the
    // token in mixed case must not get a cap that silently never matches (a footgun that
    // fails OPEN toward the global cap). The loader re-canonicalizes the key.
    const mixed = USDC.toUpperCase().replace("0X", "0x");
    const r = parsePolicy({
      ...validPolicyObject(),
      caps: { [`${CHAIN}|${mixed}`]: { perRequest: "1", perDomain: "5", global: "20" } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.caps[key].perRequest).toBe(1n);
  });

  it("a caps map with a \"__proto__\" coordinate cannot pollute the prototype", () => {
    // The real vector: JSON.parse creates an OWN "__proto__" key (a JS object literal would
    // instead set the prototype). "__proto__" is not a chain|token coordinate, so it rejects —
    // and building the caps map must never mutate Object.prototype (the H2 lesson).
    const json =
      `{"halt":false,"allowlist":[],` +
      `"caps":{"__proto__":{"perRequest":"1","perDomain":"5","global":"20"}},` +
      `"clockSkewSeconds":"60","maxAuthLifetimeSeconds":"3600","windowSeconds":"86400","requireOriginMatch":false}`;
    const r = parsePolicy(JSON.parse(json));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("config.cap_key_malformed");
    expect(({} as Record<string, unknown>).perRequest).toBeUndefined();
  });
});
