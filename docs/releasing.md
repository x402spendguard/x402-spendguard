# Releasing to npm

The publish pipeline is **armed but not fired.** `.github/workflows/release.yml` publishes to npm —
with a signed **provenance** attestation — when a maintainer pushes a `vX.Y.Z` tag whose version
matches `package.json`. Nothing ships automatically.

**The version is deliberately HELD at `0.1.4`.** A published version number is a promise made once,
so the `0.2.0` bump and the first publish wait on the **property-test pass** (fuzzing the enforcement
core against inputs neither we nor a reviewer wrote — the last cheap moment before the surface
becomes a public API). Do not tag a release until that lands. This ordering is why the P0 concurrency
bug was caught *before* publish, not after: build the crate → property-test it → then ship it.

## One-time npm-account setup (maintainer — required before the first publish)

These are the steps only the account owner can do; the workflow can't publish until they're done.

1. **Reserve the name.** `x402-spendguard` is currently free on the registry (verified). The first
   successful publish claims it — until then the name is unprotected.
2. **Enable 2FA** on the npm account for **authorization and writes** (npm → Account → Two-Factor
   Authentication). This protects interactive publishes and account changes.
3. **Provide CI a publish credential — pick one:**
   - **(Baseline) A granular automation token.** npm → Access Tokens → Generate → *Granular*,
     **scoped to only the `x402-spendguard` package**, **read+write (publish)**, short expiry, "bypass
     2FA for automation" (that is the token's purpose in CI). Add it to the repo as the Actions secret
     **`NPM_TOKEN`** (GitHub → repo Settings → Secrets and variables → Actions). Scope it minimally so
     a leaked token's blast radius is one package, not the account.
     - **Required before the first real publish (token blast-radius, GAP 3):** while a long-lived
       `NPM_TOKEN` exists it is in the environment of *every* step of the `release` job that runs
       before `npm publish` — so a compromised dependency during `npm ci`, or a malicious step, could
       exfiltrate it. Mitigate both: (a) the token is granular / automation / **publish-only /
       single-package** (narrowest scope npm offers); and (b) gate the job behind a GitHub
       **Environment with required reviewers** (repo Settings → Environments → e.g. `npm-publish`, add
       yourself as a required reviewer, then `environment: npm-publish` on the `release` job) so the
       secret is only exposed after a human approves that specific run. Best of all: **skip this phase
       entirely** by going straight to Trusted Publishing once the package exists — then there is no
       long-lived secret to scope or gate.
   - **(Recommended hardening, once the package exists) npm Trusted Publishing (OIDC).** Configure a
     *trusted publisher* on npmjs.com pointing at this repo + the `Release` workflow. Then the CI
     publish authenticates via short-lived OIDC with **no long-lived secret at all** — the ideal for a
     security tool. When this is in place, delete the `NODE_AUTH_TOKEN` env from `release.yml` and
     revoke `NPM_TOKEN`.
   > Provenance (`--provenance`) works with **either** path; it requires publishing from CI (a local
   > `npm publish --provenance` cannot generate it), which is why the workflow, not a laptop, is the
   > publisher.

## Cutting a release (when the version hold lifts)

> **The very first firing — extra care, cheap insurance.** The first real publish is where a
> misconfiguration is most likely and most expensive. Run it through the **Environment gate with
> required reviewers** (approve that specific run by hand) *even if* you've also set up Trusted
> Publishing. Once the first clean publish proves the pipeline end-to-end, relax the gate to whatever
> steady state you prefer.

1. Ensure `main` is green (hermetic gate + e2e).
2. Bump `version` in `package.json` (e.g., `0.1.4` → `0.2.0`).
3. Move the `## [Unreleased]` block in `CHANGELOG.md` to `## [0.2.0] — <date>`.
4. Commit: `release: v0.2.0 — <summary>`.
5. Tag and push the tag:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
   The `Release` workflow runs the full gate (typecheck, hermetic tests, traceability-staleness, e2e
   with smoke teeth), verifies the tag matches `package.json`, then `npm publish --provenance
   --access public`.
6. Verify: `npm view x402-spendguard`, and confirm the provenance badge on the npm package page.

## Notes

- **The gate is the workflow's, not `prepublishOnly`'s.** `prepublishOnly` (typecheck + test) is a
  local backstop for an accidental laptop publish; the authoritative gate is the workflow's full suite.
- **What ships** is `dist/` (compiled JS + declarations) + `README`/`LICENSE`/`package.json` — no
  source, no maps, no tests. This is enforced by `files: ["dist"]`, the map-free build, and proved
  against a real tarball by `test/e2e/pack-install.e2e.test.ts` (PKG-01…05).
- **No install-time code.** There is no `postinstall`; `prepack` (build) runs only when *we* pack.
