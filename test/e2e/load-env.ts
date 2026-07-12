// Minimal, zero-dependency `.env` loader for the e2e suite. If `test/e2e/.env` exists, its
// `KEY=VALUE` lines are read into `process.env` — but only for keys not ALREADY set, so a shell
// export (`FOO=bar npm run …`) always wins. Runs as a vitest setupFile before the test modules,
// so `describe.skipIf(process.env.…)` sees the values. The deny-path suite needs none of this;
// it exists only so the FUNDED settle test can read a testnet key from an untracked `.env`.
//
// We deliberately do NOT pull in `dotenv` — a payments guard with zero runtime deps shouldn't grow
// a test-time parser it doesn't need. `.env` is gitignored (except `.env.example`); a real key
// never lands in the repo.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

try {
  const envPath = fileURLToPath(new URL("./.env", import.meta.url));
  const text = readFileSync(envPath, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env) continue; // shell-provided value wins
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
} catch {
  // No .env file → nothing to load. The funded test self-skips; everything else is hermetic.
}
