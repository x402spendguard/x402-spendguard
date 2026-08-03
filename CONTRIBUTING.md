# Contributing

## Before you push: `npm run verify`

Run **`npm run verify`** before every push. It is the local mirror of CI's `test`
job, so a green `verify` means a green CI — no round-trips waiting on the runner.

It runs, in order:

1. `npm run typecheck`
2. `npm test` — the hermetic default gate (unit + property suite; excludes `test/e2e/**`)
3. `npm run traceability` **+ `git diff --exit-code TRACEABILITY.md`**
4. `npm run reason-codes` **+ `git diff --exit-code docs/reason-codes.md`**

Steps 3–4 are the reason `verify` exists and `npm test` is not enough on its own.
`TRACEABILITY.md` and `docs/reason-codes.md` are **generated** files (from
`REQUIREMENTS.md` and the reason registry). CI regenerates them and fails if the
committed copy is stale — a check that writes files and diffs the tree, so it
lives *outside* `npm test`. That gap is real: a stale `TRACEABILITY.md` once passed
`npm test` locally and still broke CI. `verify` closes it. In practice: **if you
touch `REQUIREMENTS.md` (or add/remove a requirement's test), or change the reason
registry, regenerate and commit the generated file** — `verify` will tell you when
you forgot.

Not run by `verify` (separate CI jobs, by design): `npm run test:e2e` (spawns
processes / stands up a local server) and the Windows job. Run `npm run test:e2e`
locally when you touch the adapter/store/CAS paths.

## Flow

- Branch per change; keep `main` green.
- `npm run verify` green before pushing.
- Commit messages explain the *why*; link the decision record (`docs/decisions.md`)
  when a change embodies one.
