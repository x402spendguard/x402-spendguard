// The accounting layer — the edge that turns the pure engine into a guard that
// actually accumulates spend across payments, safely. This is the part that, in
// the tools we read, was left in per-process memory with no durability and no
// concurrency safety. Here it is the point of the exercise.
//
// Guarantees (see REQUIREMENTS.md):
//  - ACCT-01 write-ahead: spend is recorded DURABLY before `authorize` returns allow,
//    so a crash before settlement over-counts (safe) and never under-counts.
//  - ACCT-02 single-writer: all authorize() calls are serialized; two concurrent
//    payments cannot both read the pre-spend state and both pass.
//  - ACCT-03 durable: state is held behind an injected SpendStore (a file/db at the edge).
//  - CLOCK-01 clock anomaly fails closed: time is viewed monotonically, so a backward
//    jump never resets a window or frees budget.
//  - FAIL-03 (spend half): if the durable record fails, DENY.
//
// The clock and store are injected (INJ-01); this module reads neither ambiently.

import { evaluate } from "../policy/engine.js";
import { assetKey } from "../parse.js";
import { projectSnapshot, SnapshotUnreadableError } from "./snapshot.js";
import type { PaymentEvaluation, Policy, PolicyDecision, SpendState, Snapshot, UnixSeconds } from "../types.js";
import type { DecisionReason } from "../reasons.js";

/** Injected wall clock. The real one lives in an adapter; tests inject a fake. */
export interface Clock {
  now(): UnixSeconds;
}

/** An OPAQUE version token. The store returns it from `load` and requires it back on
 *  `compareAndSave`; the guard round-trips it and NEVER interprets it, so the store stays
 *  topology-agnostic (a file store uses an integer, a DB a row-version, a Durable Object its own). */
export type Version = string & { readonly __version: unique symbol };

/**
 * Injected durable spend store — a versioned COMPARE-AND-SWAP contract (ACCT-05). `load` returns
 * the state plus its version; `compareAndSave` commits only if the store is STILL at that version,
 * else reports a conflict (never a silent overwrite). This is what makes cross-process
 * single-writer possible without a lock: a losing writer is TOLD it lost, and re-evaluates against
 * fresh state. Async so the edge can be a file/db, and so the concurrency guarantee is real.
 */
export interface SpendStore {
  load(): Promise<{ state: SpendState; version: Version }>;
  /** Commit `next` iff the store is still at `expected`; resolves `true` on commit, `false` on a
   *  version conflict. Throwing (an I/O failure) is treated by the guard as record-failed → deny. */
  compareAndSave(expected: Version, next: SpendState): Promise<boolean>;
  /** Startup self-test: prove the store honors CONCURRENT exclusive-create, fail-closed if not.
   *  For an in-memory / single-process store this is trivially satisfied. */
  verifyAtomicity(): Promise<void>;
}

/**
 * A null-prototype string map. Spend is keyed by attacker-influenceable strings (the origin),
 * so keys like "__proto__"/"constructor" must be ordinary keys, never touch Object.prototype.
 * A plain `{}` would let origin "__proto__" read the prototype (always 0) and write to it
 * (never persists) — a silent per-domain cap bypass. Building maps this way closes that.
 */
export function nullMap<T>(src?: Record<string, T>): Record<string, T> {
  const m = Object.create(null) as Record<string, T>;
  if (src) for (const k of Object.keys(src)) m[k] = src[k];
  return m;
}

/** A fresh, empty spend state anchored at `now`. */
export function emptyState(now: UnixSeconds): SpendState {
  return { spentByDomain: nullMap(), spentByAsset: nullMap(), windowStart: now, lastSeen: now };
}

/** A tiny async mutex — serializes work with no runtime dependency (DEP-01). */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(() => fn());
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Advance the budget window and enforce clock monotonicity.
 *  - `effective = max(now, lastSeen)`: a backward jump is ignored, so it can neither
 *    reset a window nor un-count spend (CLOCK-01).
 *  - When a whole window has elapsed, cumulative spend is zeroed and the window start
 *    advances to the current window boundary.
 */
export function applyWindow(state: SpendState, now: UnixSeconds, windowSeconds: UnixSeconds): SpendState {
  const effective = (now > state.lastSeen ? now : state.lastSeen) as UnixSeconds;
  if (windowSeconds > 0n && effective >= state.windowStart + windowSeconds) {
    const elapsed = effective - state.windowStart;
    const windowsPassed = elapsed / windowSeconds; // bigint floor
    const newStart = (state.windowStart + windowsPassed * windowSeconds) as UnixSeconds;
    return { spentByDomain: nullMap(), spentByAsset: nullMap(), windowStart: newStart, lastSeen: effective };
  }
  return { ...state, lastSeen: effective };
}

/** Return a NEW state with this payment's value added to the domain and denomination totals. */
export function recordSpend(state: SpendState, ev: PaymentEvaluation): SpendState {
  const a = ev.authorization;
  const key = assetKey({ chain: a.chainId, token: a.verifyingContract });
  const byDomain = nullMap(state.spentByDomain);
  const row = nullMap(byDomain[ev.origin] as Record<string, bigint> | undefined);
  row[key] = (row[key] ?? 0n) + a.value;
  byDomain[ev.origin] = row;
  const byAsset = nullMap(state.spentByAsset);
  byAsset[key] = (byAsset[key] ?? 0n) + a.value;
  return { ...state, spentByDomain: byDomain, spentByAsset: byAsset };
}

const deny = (reason: DecisionReason, detail: string): PolicyDecision => ({ verdict: "deny", reason, detail });

/** Default bound on CAS retries under cross-process contention. Liveness-only: exhaustion ALWAYS
 *  denies (fail-closed), never wrongly allows, so this is a mechanism knob, not policy. */
export const DEFAULT_MAX_CAS_ATTEMPTS = 8;

/**
 * The stateful guard. Wrap the pure engine with durable, serialized, write-ahead
 * accounting. One instance per protected wallet/policy.
 */
export class SpendGuard {
  private readonly mutex = new Mutex();
  private verified = false;

  constructor(
    private readonly store: SpendStore,
    private readonly clock: Clock,
    private readonly policy: Policy,
    /** Bound on CAS retries under contention (liveness-only; exhaustion denies). Injectable. */
    private readonly maxCasAttempts: number = DEFAULT_MAX_CAS_ATTEMPTS,
  ) {}

  /**
   * Decide on a payment and, if allowed, durably record the spend before returning.
   *
   * The in-process mutex serializes this instance; the store's compare-and-swap serializes ACROSS
   * processes (ACCT-05). On a cross-process conflict the loop RE-LOADS and RE-EVALUATES against the
   * fresh state (a payment fine against old state may now be over-cap → correctly flips to deny) —
   * it never retries the stale verdict. Bounded: on exhaustion under contention it DENIES.
   */
  authorize(ev: PaymentEvaluation): Promise<PolicyDecision> {
    return this.mutex.run(async () => {
      // Prove the store's cross-process compare-and-swap actually holds on THIS deployment before
      // trusting it — once, fail-closed. On an unsupported topology (a filesystem that can't honor
      // concurrent exclusive-create) this refuses LOUD rather than silently under-enforcing (ASM6).
      if (!this.verified) {
        try {
          await this.store.verifyAtomicity();
          this.verified = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown error";
          return deny("store.unverified", `Spend store failed its atomicity self-test; refusing to operate: ${msg}`);
        }
      }

      for (let attempt = 0; attempt < this.maxCasAttempts; attempt++) {
        // Load + window advance are I/O and parsing at the edge — a corrupt or unreadable
        // ledger must DENY, not throw out of authorize(). Fail-closed extends to the accounting layer.
        let loaded: { state: SpendState; version: Version };
        let state: SpendState;
        let now: UnixSeconds;
        try {
          const raw = this.clock.now();
          loaded = await this.store.load();
          state = applyWindow(loaded.state, raw, this.policy.windowSeconds);
          now = state.lastSeen; // the monotonic, effective clock
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown error";
          return deny("state.load_failed", `Could not load spend state; denying by default: ${msg}`);
        }

        const decision = evaluate(ev, this.policy, state, now);

        if (decision.verdict === "allow") {
          // Write-ahead: durably record BEFORE returning allow. A commit conflict means another
          // writer advanced the ledger since we loaded — retry (re-load + re-evaluate). A thrown
          // I/O failure means we could not record at all — deny (never proceed uncounted).
          let committed: boolean;
          try {
            committed = await this.store.compareAndSave(loaded.version, recordSpend(state, ev));
          } catch (err) {
            const msg = err instanceof Error ? err.message : "unknown error";
            return deny("spend.record_failed", `Could not durably record spend; denying: ${msg}`);
          }
          if (committed) return decision;
          continue; // CAS conflict → re-load, re-evaluate against fresh state
        }

        // On deny, best-effort persist the advanced window/lastSeen so time monotonicity sticks —
        // via the same CAS, but a conflict or failure here never flips the (already-safe) deny.
        try {
          await this.store.compareAndSave(loaded.version, state);
        } catch {
          /* deny stands regardless */
        }
        return decision;
      }

      // Bounded retry exhausted under sustained cross-process contention → fail closed.
      return deny(
        "spend.contention",
        `Could not commit spend within ${this.maxCasAttempts} attempts under contention; denying (fail-closed).`,
      );
    });
  }

  /**
   * A read-only, point-in-time view of current spend vs. caps (SNAP-01..03). The primitive a local
   * viewer/dashboard pulls — see the `Snapshot` type doc for the sensitivity contract.
   *
   * READ-ONLY and LOCK-FREE. It rides the store's EXISTING retried `load()` — which is what makes it
   * both tear-free (CAS writes create new, complete version files atomically) AND vanish-safe (its
   * bounded ENOENT re-enumeration handles a version file removed by cleanup mid-read). That, not
   * atomicity alone, is why no mutex is needed; a shortcut `load` that skipped the retry would break
   * this. It NEVER calls `compareAndSave` or `verifyAtomicity`: a snapshot cannot mutate state, and
   * cannot interfere with `authorize()`.
   *
   * Fails LOUD, not closed: on an unreadable store it THROWS `SnapshotUnreadableError`, never a
   * fabricated zeroed snapshot — the same no-false-permissive principle as fail-closed, pointing
   * loud because a zeroed snapshot is a lie (see that error). NOT taken through the mutex.
   */
  async snapshot(): Promise<Snapshot> {
    let loaded: { state: SpendState; version: unknown };
    try {
      loaded = await this.store.load();
    } catch (err) {
      throw new SnapshotUnreadableError(err);
    }
    // Advance the window for DISPLAY only (monotonic; never persisted), so the view reflects what the
    // next payment would see — a fresh (zeroed) budget if a window has elapsed since the last write.
    const advanced = applyWindow(loaded.state, this.clock.now(), this.policy.windowSeconds);
    return projectSnapshot(advanced, this.policy, advanced.lastSeen);
  }
}
