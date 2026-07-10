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
import type { PaymentEvaluation, Policy, PolicyDecision, SpendState, UnixSeconds } from "../types.js";

/** Injected wall clock. The real one lives in an adapter; tests inject a fake. */
export interface Clock {
  now(): UnixSeconds;
}

/** Injected durable spend store. Async so the edge can be a file/db; also makes the
 *  concurrency guarantee (ACCT-02) real rather than an artifact of synchronous code. */
export interface SpendStore {
  load(): Promise<SpendState>;
  save(state: SpendState): Promise<void>;
}

/** A fresh, empty spend state anchored at `now`. */
export function emptyState(now: UnixSeconds): SpendState {
  return { spentByDomain: {}, spentByAsset: {}, windowStart: now, lastSeen: now };
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
    return { spentByDomain: {}, spentByAsset: {}, windowStart: newStart, lastSeen: effective };
  }
  return { ...state, lastSeen: effective };
}

/** Return a NEW state with this payment's value added to the domain and denomination totals. */
export function recordSpend(state: SpendState, ev: PaymentEvaluation): SpendState {
  const a = ev.authorization;
  const key = assetKey({ chain: a.chainId, token: a.verifyingContract });
  const byDomain = { ...state.spentByDomain };
  const row = { ...(byDomain[ev.origin] ?? {}) };
  row[key] = (row[key] ?? 0n) + a.value;
  byDomain[ev.origin] = row;
  const byAsset = { ...state.spentByAsset };
  byAsset[key] = (byAsset[key] ?? 0n) + a.value;
  return { ...state, spentByDomain: byDomain, spentByAsset: byAsset };
}

const deny = (reason: string, detail: string): PolicyDecision => ({ verdict: "deny", reason, detail });

/**
 * The stateful guard. Wrap the pure engine with durable, serialized, write-ahead
 * accounting. One instance per protected wallet/policy.
 */
export class SpendGuard {
  private readonly mutex = new Mutex();

  constructor(
    private readonly store: SpendStore,
    private readonly clock: Clock,
    private readonly policy: Policy,
  ) {}

  /** Decide on a payment and, if allowed, durably record the spend before returning. */
  authorize(ev: PaymentEvaluation): Promise<PolicyDecision> {
    return this.mutex.run(async () => {
      const raw = this.clock.now();
      const loaded = await this.store.load();
      const state = applyWindow(loaded, raw, this.policy.windowSeconds);
      const now = state.lastSeen; // the monotonic, effective clock

      const decision = evaluate(ev, this.policy, state, now);

      if (decision.verdict === "allow") {
        // Write-ahead: durably record BEFORE returning allow. If the record fails,
        // we must not let the payment proceed uncounted — deny.
        try {
          await this.store.save(recordSpend(state, ev));
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown error";
          return deny("spend.record_failed", `Could not durably record spend; denying: ${msg}`);
        }
        return decision;
      }

      // On deny, still persist the advanced window/lastSeen so time monotonicity sticks —
      // but never let a persistence failure flip the (already-safe) deny.
      try {
        await this.store.save(state);
      } catch {
        /* deny stands regardless */
      }
      return decision;
    });
  }
}
