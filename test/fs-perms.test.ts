import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modeIsWorldWritable } from "../src/adapters/fs-perms.js";
import { FileSpendStore } from "../src/adapters/file-spend-store.js";
import { loadPolicyFile } from "../src/adapters/policy-file-loader.js";
import { emptyState } from "../src/accounting/guard.js";
import type { UnixSeconds } from "../src/types.js";
import { NOW } from "./helpers.js";

// process.platform is a value property; redefine it to simulate Windows, restore after each test.
const realPlatform = process.platform;
const setPlatform = (p: string) => Object.defineProperty(process, "platform", { value: p, configurable: true });
afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

describe("POSIX perm gates are guarded for Windows (PLAT-01)", () => {
  it("modeIsWorldWritable honors 0o002 on POSIX but never on win32", () => {
    // On the real (POSIX) test platform the world-write bit is honored…
    expect(modeIsWorldWritable(0o666)).toBe(true);
    expect(modeIsWorldWritable(0o644)).toBe(false);
    expect(modeIsWorldWritable(0o600)).toBe(false);
    // …but on Windows, where Node synthesizes 0o666 for a normal writable file, it must NOT fire —
    // else the perm gates refuse every file and brick into a deny-all.
    setPlatform("win32");
    expect(modeIsWorldWritable(0o666)).toBe(false);
  });

  it("perm-gates-skipped-on-windows", async () => {
    setPlatform("win32");
    const dir = mkdtempSync(join(tmpdir(), "x402-plat-"));
    try {
      // (a) ACCT-06: a world-writable ledger must NOT be refused on Windows (else deny-all brick).
      const ledger = join(dir, "ledger");
      const store = new FileSpendStore(ledger, NOW as UnixSeconds);
      const { version } = await store.load();
      await store.compareAndSave(version, emptyState(NOW)); // creates ledger.v1
      chmodSync(`${ledger}.v1`, 0o666); // world-writable
      await expect(store.load()).resolves.toBeDefined(); // loads fine on win32, not refused

      // (b) CONF-01: a world-writable policy.json must get PAST the world-writable gate on Windows.
      const policyPath = join(dir, "policy.json");
      writeFileSync(policyPath, "{ not valid json", "utf8");
      chmodSync(policyPath, 0o666); // world-writable
      const r = loadPolicyFile(policyPath);
      expect(r.ok).toBe(false); // it still fails — but on the JSON parse, not the world-writable gate
      if (!r.ok) expect(r.reason).not.toBe("config.world_writable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
