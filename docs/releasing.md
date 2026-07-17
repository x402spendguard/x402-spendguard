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

1. **The name is claimed.** `x402-spendguard` is published; the name is yours.
2. **2FA is enabled** on the npm account (authorization + writes).
3. **Authentication is Trusted Publishing (OIDC) — no long-lived token.** Configure once on npmjs.com:
   the package page → **Settings → Trusted Publishers → GitHub Actions**, and enter:
   - **Organization or user:** `x402spendguard`
   - **Repository:** `x402-spendguard`
   - **Workflow filename:** `release.yml` (filename only, not a path)
   - **Environment:** leave blank (we do not gate on an Environment)

   The `Release` workflow's `publish` job then authenticates via short-lived **OIDC** (`id-token:
   write`), with **no secret**; the provenance attestation rides the same OIDC token. The `publish` job
   runs on Node 24 (Trusted Publishing needs npm ≥ 11.5.1) and with `--ignore-scripts`, so no
   third-party code runs while the OIDC publish capability is live.
   > **The bootstrap token (historical).** Trusted Publishing requires the package to already exist, so
   > the *first* publish (`0.2.0`) was created with a one-time **classic automation token** in the repo
   > secret `NPM_TOKEN`. Once `0.2.0` was live and Trusted Publishing configured, that token was
   > **revoked on npm and deleted from the repo** (`gh secret delete NPM_TOKEN`) — there is no standing
   > publish secret. That one-time token is the pattern to bootstrap any *brand-new* package.
   > Provenance requires publishing from CI; a local `npm publish --provenance` cannot generate it.

## Cutting a release

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
- **The GitHub Release is automated.** The `release-notes` job (after a successful publish) creates the
  matching GitHub Release from this version's `CHANGELOG.md` section and attaches `TRACEABILITY.md`, so
  npm and GitHub stay in sync. It marks the release **`--latest`** — correct for linear `0.x`/`1.x`
  releasing. **If you ever maintain parallel release lines** (e.g. patch an old `1.x` after `2.x` is
  out), `--latest` would mislabel the backport as latest; make it conditional at that point.
