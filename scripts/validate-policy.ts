// Validate a policy file and ECHO it back in human units — the fat-finger control, as a CLI.
//
// Run:  npx vite-node scripts/validate-policy.ts <path-to-policy.json>
//
// This is a THIN wrapper. All the load-bearing logic — loading, fail-closed parsing, and the human
// render — lives in the library (loadPolicyFile / parseDisplay / describePolicy), which SHIPS to npm
// so an installed user gets the control as code; this script is a convenience over it, not the control
// itself. No `bin` yet: prove the affordance earns its keep as a documented one-liner first.
//
// It prints ONE of two things:
//   ✗ the specific failure reason + detail, if the policy is invalid (e.g. an unedited starter);
//   ✓ every cap rendered in human units where `display` decimals were declared, else exact base units.
// It forms no opinion and looks nothing up — it renders the user's own declarations. A non-zero exit
// signals an invalid policy so the one-liner can gate a commit hook / CI step.
import { readFileSync } from "node:fs";
import { loadPolicyFile } from "../src/adapters/policy-file-loader.js";
import { parseDisplay, describePolicy, type Display } from "../src/display.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: vite-node scripts/validate-policy.ts <path-to-policy.json>");
  process.exit(2);
}

const loaded = loadPolicyFile(path);
if (!loaded.ok) {
  console.error(`✗ ${path} is invalid — the guard will NOT start.`);
  console.error(`  [${loaded.reason}] ${loaded.detail}`);
  process.exit(1);
}

// Display is optional and NEVER affects enforcement; a malformed section is a loud warning, not fatal —
// the echo degrades to exact base units rather than a guessed (lying) rendering.
let display: Display | undefined;
try {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const parsed = parseDisplay(raw);
  if (parsed.ok) display = parsed.value;
  else console.error(`! display section ignored [${parsed.reason}]: ${parsed.detail}`);
} catch {
  /* already parsed by loadPolicyFile; ignore */
}

const d = describePolicy(loaded.value, display);
const lines: string[] = [];
lines.push(`✓ ${path} is valid.`);
lines.push(
  `  Kill switch ${d.halt ? "ON (all payments denied)" : "OFF"}   ` +
    `Window ${d.windowSeconds}s   Skew ${d.clockSkewSeconds}s   ` +
    `Max-auth ${d.maxAuthLifetimeSeconds}s   Origin-match ${d.requireOriginMatch ? "required" : "off"}`,
);
lines.push(`  Allowlist (${d.allowlist.length}):`);
for (const e of d.allowlist) lines.push(`    ${e.address}  on  ${e.chain}`);
for (const den of d.denominations) {
  const label = den.decimals === null ? "(no decimals declared — showing base units)" : `(decimals: ${den.decimals}${den.symbol ? `, ${den.symbol}` : ""})`;
  lines.push(`  ${den.key}   ${label}`);
  for (const [name, v] of [["per request", den.perRequest], ["per domain", den.perDomain], ["global", den.global]] as const) {
    lines.push(`    ${name.padEnd(12)} ${v.human ?? `${v.baseGrouped} base units`}`);
  }
}
console.log(lines.join("\n"));
