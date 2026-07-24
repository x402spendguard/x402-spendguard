// Config on-ramp, runnable with ONLY the library (no network, no funds, no x402 client).
//
// Run after `npm install x402-spendguard`:
//   npx tsx examples/configure-and-echo.ts     (or your TS runner of choice)
//
// It shows the fat-finger control: an off-by-a-zero cap is invisible in base units
// (500000000 vs 50000000) but obvious once echoed in human units. For the full x402-client
// wiring — wrapping a real signer/fetch and driving a 402 — see ../test/e2e/.
import { parsePolicy, parseDisplay, describePolicy, assetKey } from "x402-spendguard";

const CHAIN = "eip155:8453"; // Base
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // USDC on Base (illustrative)

// Build the caps key by construction — never hand-concatenate the "chain|token" string.
const key = assetKey({ chain: CHAIN, token: USDC });

// The raw object your policy.json would hold. NOTE the deliberate fat-finger: perRequest is
// 500000000 base units — 500 USDC — when we meant 50. In base units the extra zero hides.
const raw = {
  halt: false,
  requireOriginMatch: true,
  allowlist: [{ address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", chain: CHAIN }],
  caps: { [key]: { perRequest: "500000000", perDomain: "5000000", global: "20000000" } },
  // The optional `display` section is DISPLAY-ONLY — it never affects a decision; it just lets the
  // echo render caps in human units. decimals is the token's base-unit exponent (USDC = 6).
  display: { [key]: { decimals: 6, symbol: "USDC" } },
  clockSkewSeconds: "60",
  maxAuthLifetimeSeconds: "3600",
  windowSeconds: "86400",
};

const policy = parsePolicy(raw);
if (!policy.ok) {
  console.error(`policy invalid [${policy.reason}]: ${policy.detail}`);
  process.exit(1);
}
const display = parseDisplay(raw);

const desc = describePolicy(policy.value, display.ok ? display.value : undefined);
console.log("Caps, echoed in human units:");
for (const d of desc.denominations) {
  console.log(`  ${d.key}  (${d.decimals === null ? "no decimals declared" : `${d.decimals} decimals, ${d.symbol}`})`);
  const pr = d.perRequest;
  console.log(`    per request: ${pr.human ?? `${pr.baseGrouped} base units`}`);
}
// Prints:  per request: 500.000000 USDC  — the extra zero is now impossible to miss.
