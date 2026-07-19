# Design note — ACCT-05: the versioned (CAS) spend-store seam

Implementation spec for the architecture ratified in [decisions D-031](decisions.md). This note is
the thing the implementation is reviewed *against*. It folds in the three sharpenings from Opus's
adversarial pass on the design (2026-07-13) — the probe-tense fix especially.

## The problem (one sentence)

The store's `load()` → `save()` is an unconditional read-modify-write; two processes on one wallet's
ledger both load pre-spend state, both pass a cap, both overwrite last-write-wins → **silent
under-count in the money-losing direction** (ACCT-05 = H1).

## The seam

`SpendStore` evolves from `load/save` to a versioned compare-and-swap, plus a startup probe:

```
load():          Promise<{ state: SpendState; version: Version }>   // read + an OPAQUE version token
compareAndSave(expected: Version, next: SpendState): Promise<boolean>  // commit iff version unchanged; false = conflict, NEVER a silent overwrite
verifyAtomicity(): Promise<void>                                    // startup probe; THROWS (refuse-closed) if the store can't prove concurrent exclusive-create
```

- **`Version` is opaque to the guard.** The guard passes the token straight back to
  `compareAndSave`, never interprets it. That keeps the guard topology-agnostic: file store → an
  integer; a DB → a row-version; a Durable Object → whatever. The guard code is identical across all.
- Chosen over a `transact(fn)` callback because the **bounded-retry + fail-closed logic is security
  logic** and must live in one auditable place (the guard), not be re-implemented per backend.

## The guard's CAS loop (in `SpendGuard.authorize`, inside the existing mutex)

```
for attempt in 0 .. MAX:
  { state, version } = load()                    // load-fail → deny (unchanged)
  state = applyWindow(state, now, windowSeconds)
  decision = evaluate(ev, policy, state, now)
  if allow:
     if compareAndSave(version, recordSpend(state, ev)): return allow
     else: continue        // CONFLICT → re-load, RE-EVALUATE against fresh state (may now DENY — correct)
  else:
     compareAndSave(version, state)  // best-effort window persist; deny stands regardless
     return deny
return deny("spend.contention", "...")           // bounded retry exhausted → FAIL-CLOSED
```

- **Re-evaluate on conflict, never retry the stale verdict.** A payment that passed against old
  state but is over-cap against fresh state must flip to deny. This is what makes CAS *correct*, not
  merely atomic.
- **Keep the in-process mutex** as an in-process fast-path. Within a process the mutex serializes, so
  there are **zero CAS conflicts in-process → zero false-denies in the committed one-instance-per-
  wallet topology.** CAS only arbitrates the cross-process case (rare for that topology), where it
  fails **closed and loud** — never the silent surprise. This is the reconciliation of the earlier
  "rare deny" objection (see D-031).

## The file mechanism (`FileSpendStore`)

State lives in **version-named files** `<path>.v<N>` (e.g. `ledger.v3`; N a monotonic integer).

- **`load()`** → read the highest `N` present (empty at N=0 if none); return `{state, version: N}`.
- **`compareAndSave(N, next)`** → write `next` to a unique temp, `fsync`, then **`link(temp,
  "<path>.v<N+1>")`**. `link` is an atomic create-or-`EEXIST`: exactly one of two racing writers wins
  `<path>.v<N+1>`, the loser gets `EEXIST` → return `false`. Temp is complete before the link → both
  crash-safe *and* atomically-CAS. On success: unlink temp, run cleanup, return `true`.
  **This is a genuine OS-atomic create — never read-check-write.** (Criterion 1.)

### Opus fix #3 — the reader side is security-critical and bounded-fail-closed

`load()` reads the highest N, but cleanup can unlink a version a reader is about to open. So:

- **Cleanup keeps the last 3 versions** (not 2), or equivalently gates deletion on
  "older than highest-minus-one" — cheap insurance to widen the read window.
- **Read-retry on a vanished file is bounded and fail-closed**, the same discipline as the write
  loop: if the file a reader chose is unlinked underneath it, re-enumerate and re-read the new
  highest; if it can't get a stable read within the bound, **deny** (throw → the guard's
  `state.load_failed` deny path). "Keep-last-3" makes a targeted file eligible for deletion, so this
  retry is not optional.

## The startup probe `verifyAtomicity()` — CONCURRENT, not sequential (Opus fix #1, the critical one)

A *sequential* create-twice-check-`EEXIST` proves the property that **doesn't** fail. The failure
mode we defend against (NFS et al.) is exactly one where sequential `link` looks fine and
**concurrent** `link`s from two racers *both appear to win*. So the probe must **race concurrent
creates** against the same target and assert **exactly one wins**:

- Fire **two `link()` attempts to the same fresh target name concurrently** (via async fs on the
  libuv threadpool — genuine syscall-level concurrency, not microtask interleaving) and assert
  **exactly one resolves and the other rejects `EEXIST`**. If *both* resolve, the filesystem does
  not honor exclusive-create under contention → **throw, refuse to run** (fail-closed).
- Run a few rounds to shake out timing.

### Opus fix #2 — the mount denylist is load-bearing, required alongside the probe

`link()` atomicity on network filesystems can vary by server/version/mount-option in ways a probe
run *at one instant* may not surface (it races once, at boot, before real contention conditions). So
the design requires **both**, belt-and-suspenders:

1. **Race the concurrent probe** (above), and
2. **Detect and refuse known-unsafe mounts** (NFS/CIFS/other network FS) — because the probe can be
   fooled by timing, and the denylist can't enumerate every future unsafe FS. Neither alone is
   sufficient.

This is ASM6 restated ("an unsupported topology must fail *loud*") and it closes the ASM6 silent
fail-open (read-only / ephemeral) with the same startup check.

## `MAX` retry bound

Injectable with a sensible default. It affects **liveness only** — exhaustion always denies, never
wrongly allows — so it's a mechanism knob, not policy (POL-01 unaffected; `authorize` is in
`guard.ts`, not the `checks.ts` the POL-01 static test scans). **A test must assert that exhaustion
denies** (prove the fail-closed-on-contention path, don't assume it — Opus).

## Scope boundaries

- **Unifies ACCT-02 + ACCT-05/H1** into one single-writer mechanism (two scopes, one thing). The
  mutex becomes a fast-path, not a second guarantee.
- **Does NOT touch** the adapter concurrent-flow mis-attribution (`PaymentFlowContext`, Finding B) —
  different layer, already fail-closed. **Not in this slice.**

## Test plan (TDD)

1. **`cross-process-cannot-both-pass`** (promote from `it.todo`): two `SpendGuard` instances (two
   mutexes) sharing one store, concurrent over-cap payments → **exactly one allows.** Reds now
   (both allow). *(This proves the CAS logic. It does NOT prove real two-process `link()`
   atomicity — see the README gate below.)*
2. **Guard-loop units** (via a versioned `MemStore` that injects a conflict): conflict →
   re-evaluate → deny-when-now-over-cap; **retry exhaustion → deny (fail-closed).**
3. **Probe adversarial:** inject a store whose *concurrent* create is simulated-broken
   (both-win, not merely no-`EEXIST`) → `verifyAtomicity()` **refuses**. This is the test that keeps
   ② from silently degrading into the lock-trap ③.
4. **Read-retry:** a file the reader targets is unlinked underneath it → bounded re-read, and
   exhaustion → deny.
5. Preserve ACCT-01/02/03; no-egress static test still green (`node:fs` is allowed); tsc clean.

## README honesty gate (Opus fix #3, docs side)

**Do NOT soften README limitation #2 ("one instance per wallet") on the strength of the
two-in-process-instances test.** That proves the *CAS logic*, not real two-*process* `link()`
atomicity, which is the actual claim. Land the logic + in-process proof now; **gate the wording
change on a genuine two-process (ideally two-host, on the target FS) smoke test.** Claiming the
property on a proxy test is the same "tested the thing that doesn't fail" error as fix #1, but in
the docs.

## Acceptance criteria (carried from D-031, one sharpened)

1. Atomic primitive is a genuine OS-atomic create — **met by `link()`**.
2. Startup probe is **concurrent** (races both-win), **and** paired with a known-unsafe-mount
   refusal. Adversarially tested against a *concurrently*-broken store.
3. Bounded fail-closed retry on the **write** loop **and** on the **read-retry-on-vanished** path.
