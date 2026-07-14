// The snapshot projection — a PURE, read-only view of current spend vs. policy caps + the budget
// window. Mirrors the engine/guard split: `projectSnapshot` is pure (no I/O); `SpendGuard.snapshot()`
// (in guard.ts) loads state and calls this. See REQUIREMENTS.md SNAP-01..03 and the `Snapshot` type
// doc (types.ts) for the sensitivity contract — this projects the system's most sensitive artifact.
import type { AssetKey, Caps, Policy, SpendState, UnixSeconds, Snapshot, DenominationSnapshot, DomainSnapshot } from "../types.js";

/**
 * Thrown by `SpendGuard.snapshot()` when the spend store cannot be read.
 *
 * This is fail-*loud*, and it is the SAME principle as `authorize()`'s fail-*closed*: never produce
 * a false-permissive result. They point opposite directions only because the outputs mean different
 * things — a denied payment is safe, but a zeroed snapshot is a LIE (it reads as "no spend"). A
 * snapshot is a read for a human, not an authorization, so the honest failure is to refuse loudly
 * rather than fabricate zeros. Do not "harmonize" this to fail-closed — that reintroduces the lie.
 */
export class SnapshotUnreadableError extends Error {
  readonly reason = "snapshot.state_unreadable";
  constructor(cause: unknown) {
    super(
      "snapshot.state_unreadable: could not read spend state; refusing to return a fabricated " +
        "(false-permissive) snapshot — a zeroed snapshot would be a lie.",
      { cause },
    );
    this.name = "SnapshotUnreadableError";
  }
}

/**
 * Project spend state + policy into a read-only Snapshot at `now`. Pure: no I/O, no clock, no
 * mutation. `now` is the effective (already monotonic) clock; the caller advances the window
 * read-only before calling. `state` maps are null-prototype at the edge, but we read them
 * proto-safely (`Object.hasOwn`) regardless.
 */
export function projectSnapshot(state: SpendState, policy: Policy, now: UnixSeconds): Snapshot {
  const clampRemaining = (cap: bigint | null, spent: bigint): bigint | null =>
    cap === null ? null : cap - spent > 0n ? cap - spent : 0n; // clamp at 0; raw spent stays visible
  // Cap lookup by a runtime string key (state keys are plain strings; the caps record is keyed by
  // the branded AssetKey). Proto-safe: hasOwn so an attacker-influenced key can't hit the prototype.
  const capFor = (k: string): Caps | undefined =>
    Object.hasOwn(policy.caps, k) ? policy.caps[k as AssetKey] : undefined;

  // byDenomination: the UNION of configured caps and denominations present in state — so every
  // budget line shows (even at 0 spent) and a spend with no configured cap is surfaced, not hidden.
  const denomKeys = new Set<string>();
  for (const k of Object.keys(policy.caps)) denomKeys.add(k);
  for (const k of Object.keys(state.spentByAsset)) denomKeys.add(k);
  const byDenomination: DenominationSnapshot[] = [];
  for (const key of denomKeys) {
    const spent = Object.hasOwn(state.spentByAsset, key) ? state.spentByAsset[key] : 0n;
    const cap = capFor(key);
    const global = cap ? cap.global : null;
    byDenomination.push({
      key,
      spent,
      remaining: clampRemaining(global, spent),
      caps: { perRequest: cap ? cap.perRequest : null, global },
    });
  }

  // byDomain: domains that have spent, each with per-asset spend vs. its per-domain cap.
  const byDomain: DomainSnapshot[] = [];
  for (const origin of Object.keys(state.spentByDomain)) {
    const row = state.spentByDomain[origin];
    const byAsset = Object.keys(row).map((key) => {
      const spent = row[key];
      const cap = capFor(key);
      const perDomainCap = cap ? cap.perDomain : null;
      return { key, spent, perDomainCap, remaining: clampRemaining(perDomainCap, spent) };
    });
    byDomain.push({ origin, byAsset });
  }

  return {
    now,
    halt: policy.halt,
    windowStart: state.windowStart,
    windowSeconds: policy.windowSeconds,
    windowEndsAt: policy.windowSeconds > 0n ? ((state.windowStart + policy.windowSeconds) as UnixSeconds) : null,
    byDenomination,
    byDomain,
  };
}
