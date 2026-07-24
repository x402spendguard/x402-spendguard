import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { STARTER_POLICY_JSON, writeStarterPolicy } from "../src/starter-policy.js";
import { parsePolicy } from "../src/parse.js";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Replace every `REPLACE_WITH_…` placeholder with a valid value — what an editing user does. */
function edited(): unknown {
  const filled = STARTER_POLICY_JSON.replace("0xREPLACE_WITH_YOUR_PAYEE_ADDRESS", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    .replace("0xREPLACE_WITH_TOKEN_CONTRACT_ADDRESS", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    .replace("REPLACE_WITH_PER_REQUEST_CAP_IN_BASE_UNITS", "1000000")
    .replace("REPLACE_WITH_PER_DOMAIN_CAP_IN_BASE_UNITS", "5000000")
    .replace("REPLACE_WITH_GLOBAL_CAP_IN_BASE_UNITS", "20000000");
  return JSON.parse(filled);
}

describe("starter policy (ONBOARD-01/02) — the readable default POL-01 promised", () => {
  // ONBOARD-02. The drift gate CHENG specified, both directions in one test:
  //  - RAW (unedited) must FAIL parsePolicy → an unedited copy fails loud, not silent-deny-all.
  //  - EDITED (placeholders filled) must PARSE → the template is not stale against the Policy type.
  it("starter-fails-loud-and-is-not-stale", () => {
    const raw = parsePolicy(JSON.parse(STARTER_POLICY_JSON));
    expect(raw.ok, "an unedited starter must be REJECTED (fail-loud), not accepted").toBe(false);
    // and the specific reason is a real config code, not the generic backstop
    if (!raw.ok) expect(raw.reason.startsWith("config.") || raw.reason.startsWith("parse.")).toBe(true);

    const filled = parsePolicy(edited());
    expect(filled.ok, "the starter with placeholders filled must PARSE (not stale vs the Policy type)").toBe(true);
  });

  // ONBOARD-01 (drift gate). The repo-root policy.example.json exists and is byte-identical to the
  // shipped const — so the GitHub-browser copy can't drift from the npm-shipped one (files:["dist"]
  // strands the repo file from the tarball, so the const is the source of truth and this pins them).
  it("starter-policy-file-exists", () => {
    const onDisk = readFileSync(join(REPO_ROOT, "policy.example.json"), "utf8");
    expect(onDisk).toBe(STARTER_POLICY_JSON);
  });

  // ONBOARD-01 (writer safety). Refuse to overwrite — clobbering a live policy is a data-loss footgun.
  it("write-starter-refuses-overwrite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-starter-"));
    try {
      const path = join(dir, "policy.json");
      await writeStarterPolicy(path);
      expect(readFileSync(path, "utf8")).toBe(STARTER_POLICY_JSON);
      await expect(writeStarterPolicy(path), "second write must refuse").rejects.toThrow(/already exists/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ONBOARD-01 (writer safety). Owner-only at rest — the allowlist is the counterparty graph (PRIV-04).
  // POSIX-only: Windows ignores the mode (ACL-based, PLAT-01), so self-skip there.
  it("write-starter-is-owner-only", async (ctx) => {
    if (process.platform === "win32") ctx.skip();
    const dir = mkdtempSync(join(tmpdir(), "x402-starter-"));
    try {
      const path = join(dir, "policy.json");
      await writeStarterPolicy(path);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
