import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HashChainDecisionLog } from "../src/audit/hash-chain-log.js";
import { sha256ChainHasher, hmacChainHasher } from "../src/audit/chain-hasher.js";
import { serializeAudit } from "../src/serialize.js";
import type { LogEntry } from "../src/audit/decision-log.js";

const entry = (i: number): LogEntry => ({
  v: 1,
  at: String(1_000_000 + i),
  verdict: "allow",
  reason: "ok",
  detail: "d",
  origin: "weather.example",
  chain: "eip155:8453",
  asset: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  amount: String(1000 + i),
});

const tmp = () => mkdtempSync(join(tmpdir(), "x402-anchor-"));

describe("audit head anchor — the anchor is operator-supplied, never self-attested (ANCHOR-01)", () => {
  // CHENG's attack, pre-run: forge a self-consistent REWRITE of the log and show that self-verify
  // (no anchor) PASSES it — so a viewer trusting the log's own head would be theater — while verify
  // against the head the operator pinned OUT-OF-BAND catches it.
  it("operator-anchor-catches-a-rewrite-self-verify-misses", async () => {
    const dir = tmp();
    try {
      // The real chain. The operator pins its head somewhere the log-writer can't reach.
      const pathA = join(dir, "real.log");
      const logA = new HashChainDecisionLog(pathA);
      for (let i = 0; i < 4; i++) await logA.append(entry(i));
      const pinnedHead = (await new HashChainDecisionLog(pathA).verify()).head;

      // A self-consistent REWRITE: different entries, a fully valid chain, a different head.
      const pathB = join(dir, "rewritten.log");
      const logB = new HashChainDecisionLog(pathB);
      await logB.append(entry(0));
      await logB.append(entry(99)); // attacker's substituted content
      const selfB = await new HashChainDecisionLog(pathB).verify();

      expect(selfB.ok).toBe(true); // self-verify PASSES the rewrite — the theater a self-anchor would enable
      expect(selfB.head).not.toBe(pinnedHead); // but its head differs from the pinned one

      // Verifying the rewrite against the OPERATOR-PINNED head catches it.
      const anchored = await new HashChainDecisionLog(pathB).verify({ expectedHead: pinnedHead });
      expect(anchored.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A keyed chain needs no external head: an attacker who rewrites the whole chain WITHOUT the key
  // produces a chain that verifies fine UNKEYED (theater) but fails against the operator-held key.
  it("keyed-mode-catches-a-full-rewrite-without-an-anchor", async () => {
    const dir = tmp();
    try {
      const key = "operator-held-secret";
      // Attacker rewrites the whole chain unkeyed (they don't have the key).
      const forged = join(dir, "forged.log");
      const logF = new HashChainDecisionLog(forged, sha256ChainHasher);
      for (let i = 0; i < 3; i++) await logF.append(entry(i));

      // Unkeyed self-verify of the forgery PASSES (a full self-consistent rewrite).
      expect((await new HashChainDecisionLog(forged, sha256ChainHasher).verify()).ok).toBe(true);
      // Verifying it with the operator-held KEY FAILS — the attacker couldn't compute valid HMACs.
      expect((await new HashChainDecisionLog(forged, hmacChainHasher(key)).verify()).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The serialized audit export self-reports only its own head + self-consistency — it carries NO
  // "anchored/verified" verdict, because a file can't be trusted to make one about itself.
  it("audit-export-self-reports-head-not-an-anchored-verdict", async () => {
    const dir = tmp();
    try {
      const path = join(dir, "a.log");
      const log = new HashChainDecisionLog(path);
      for (let i = 0; i < 3; i++) await log.append(entry(i));
      const computed = await new HashChainDecisionLog(path).verify();

      const ex = await serializeAudit(new HashChainDecisionLog(path));
      expect(ex.head).toBe(computed.head); // its OWN head, for the operator to compare
      expect(ex.selfConsistent).toBe(true);
      expect(ex.brokenAt).toBeNull();
      expect(ex).not.toHaveProperty("anchored"); // no self-attested anchored verdict
      expect(ex).not.toHaveProperty("verified");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
