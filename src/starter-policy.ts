// The shipped, readable starter policy — the artifact POL-01 has always promised ("shipped defaults
// live in a readable default policy file, never as code constants") and that, until now, did not exist.
//
// TWO deliberate design points, both by construction:
//  1. FAIL-LOUD when copied unedited. The security-relevant fields the user MUST choose — the payee
//     address, the token contract, and the three caps — are PLACEHOLDER strings that `parsePolicy`
//     REJECTS (an invalid address, a malformed cap key, non-integer amounts). So an unedited copy
//     fails to load with a specific reason, rather than silently denying every payment (the opaque
//     failure a valid-but-empty template would produce). See ONBOARD-02.
//  2. READABLE DEFAULTS in the file, not in code. The operational fields POL-01 names — clock skew,
//     the cross-origin flag, plus the auth-lifetime ceiling and budget window — carry real, visible,
//     editable values here. They are defaults the USER can see and change, not constants buried in
//     the enforcement path.
//
// It ships as CODE (this const + `writeStarterPolicy`) because `files: ["dist"]` would strand a
// repo-root example file — so an `npm install` user gets it, not only a GitHub browser. The
// repo-root `policy.example.json` is generated from this const and drift-gated (see the tests).
//
// JSON, not JSONC: `parsePolicy` is `JSON.parse` (no parser added to a security lib's supply chain),
// so the file carries no comments — the field-by-field explanation lives in the README and in what
// the `describePolicy`/validate affordance prints. Numeric fields are STRINGS: money and time parse
// through branded primitives that accept a decimal string or bigint, never a JSON number.

/** The starter policy, exactly as written to disk. Valid JSON, but `parsePolicy` REJECTS it until the
 *  `REPLACE_WITH_…` placeholders are edited — fail-loud by construction (ONBOARD-01/02). */
export const STARTER_POLICY_JSON = `{
  "halt": false,
  "allowlist": [
    { "address": "0xREPLACE_WITH_YOUR_PAYEE_ADDRESS", "chain": "eip155:8453" }
  ],
  "caps": {
    "eip155:8453|0xREPLACE_WITH_TOKEN_CONTRACT_ADDRESS": {
      "perRequest": "REPLACE_WITH_PER_REQUEST_CAP_IN_BASE_UNITS",
      "perDomain": "REPLACE_WITH_PER_DOMAIN_CAP_IN_BASE_UNITS",
      "global": "REPLACE_WITH_GLOBAL_CAP_IN_BASE_UNITS"
    }
  },
  "clockSkewSeconds": "60",
  "maxAuthLifetimeSeconds": "3600",
  "windowSeconds": "86400",
  "requireOriginMatch": true
}
`;

/**
 * Write the starter policy to `path` for a new user to edit.
 *
 * Fail-closed on two fronts:
 *  - REFUSES TO OVERWRITE an existing file (the `wx` flag → EEXIST). Clobbering a live policy is a
 *    data-loss footgun; the caller must delete or choose another path deliberately.
 *  - Creates the file `0o600` (owner-only). A policy's `allowlist` is the counterparty graph — the
 *    same at-rest sensitivity the ledger and decision log carry (PRIV-04). No-op on Windows, where
 *    Node ignores the mode (ACL-based); see PLAT-01.
 */
export async function writeStarterPolicy(path: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  try {
    await writeFile(path, STARTER_POLICY_JSON, { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `writeStarterPolicy: "${path}" already exists — refusing to overwrite it (delete it or choose another path).`,
      );
    }
    throw err;
  }
}
