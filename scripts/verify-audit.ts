// Verify a decision-log hash chain — the AUTHORITATIVE audit check (D-040 / ANCHOR-01).
//
// Run:  npx vite-node scripts/verify-audit.ts <log-path> [--expected-head <hash>]
//       X402_AUDIT_KEY=<key> npx vite-node scripts/verify-audit.ts <log-path>   (keyed mode)
//
// The one thing this gets right: **the anchor is OPERATOR-SUPPLIED, never read from the log.** A file
// on a box you don't control can't hold an anchor an attacker who rewrote the log couldn't also
// rewrite — so this trusts nothing self-reported. You pin the head out-of-band (a secrets store, a
// different host, a printed value) and pass it with `--expected-head`, OR you use a keyed chain whose
// key lives in the environment (never in argv — argv leaks in the process list). Self-consistency
// ALONE cannot catch a full self-consistent rewrite, and this says so loudly when you run it bare.
import { HashChainDecisionLog } from "../src/audit/hash-chain-log.js";
import { hmacChainHasher, sha256ChainHasher } from "../src/audit/chain-hasher.js";

const path = process.argv[2];
if (!path || path.startsWith("--")) {
  console.error("usage: vite-node scripts/verify-audit.ts <log-path> [--expected-head <hash>]");
  console.error("       X402_AUDIT_KEY=<key> vite-node scripts/verify-audit.ts <log-path>   (keyed)");
  process.exit(2);
}
const ehIdx = process.argv.indexOf("--expected-head");
const expectedHead = ehIdx >= 0 ? process.argv[ehIdx + 1] : undefined;
const key = process.env.X402_AUDIT_KEY; // from env, not argv — argv is visible in the process list
const hasher = key ? hmacChainHasher(key) : sha256ChainHasher;

const result = await new HashChainDecisionLog(path, hasher).verify({ expectedHead });

if (!result.ok) {
  console.error(`✗ audit chain FAILED to verify: ${result.reason ?? "unknown"}${result.brokenAt != null ? ` (at seq ${result.brokenAt})` : ""}`);
  console.error(`  computed head: ${result.head}`);
  process.exit(1);
}

console.log(`✓ audit chain intact.  head: ${result.head}`);
if (!key && expectedHead === undefined) {
  console.error("  ⚠ self-consistency only — this CANNOT catch a full self-consistent rewrite.");
  console.error("    Pin the head out-of-band and re-run with --expected-head <hash>, or set X402_AUDIT_KEY.");
} else {
  console.log(`  anchored: ${key ? "keyed (operator-held key)" : "against the head you supplied"} — a rewrite would have failed here.`);
}
