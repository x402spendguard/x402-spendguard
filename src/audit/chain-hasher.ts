// The ChainHasher seam (AUDIT-02) — the first-class, injectable integrity primitive for the
// decision-log hash chain. This is the key/anchor seam the trust-model discussion mandated: v1
// ships an unkeyed default AND a keyed HMAC implementation, and the SAME contract is what a future
// shared-host deployment (or a ledger MAC) reuses — reversal is reuse, not rebuild.
//
// Honest limits (see AUDIT-01 + THREAT_MODEL §3):
//  - unkeyed (SHA-256): a chain an attacker with file write access can fully recompute. It detects
//    non-adversarial corruption, naive edits, and — with an EXTERNALLY pinned head — post-export
//    tampering. It does NOT detect a full self-consistent rewrite on its own.
//  - keyed (HMAC): forgery-resistant to an attacker without the key — detects any edit/insert/reorder
//    even without an external anchor (truncation-from-end still needs the anchor). The key is
//    operator-held, out of the log's trust zone; a co-resident attacker WITH the key is A5 (the
//    isolation boundary), out of scope.
//
// node:crypto is stdlib (no runtime dependency, DEP-01) and not network-capable (no-egress intact).
import { createHash, createHmac } from "node:crypto";
import type { LogEntry } from "./decision-log.js";

export interface ChainHasher {
  /** Stable id of the algorithm (e.g. "sha256", "hmac-sha256") — recorded per record as a hint. */
  readonly algorithm: string;
  /** Commit to (seq, prev-hash, entry contents). Deterministic; commits to CONTENTS, never a secret. */
  hash(input: { seq: number; prev: string; entry: LogEntry }): string;
}

/** Canonical byte-form of the chained fields. LogEntry is a flat record of primitives (PRIV-02:
 *  no signature, no nonce, no payload), so an explicit field list is a stable canonical form and
 *  leaks nothing that the plaintext log does not already hold. */
function canonical(input: { seq: number; prev: string; entry: LogEntry }): string {
  const e = input.entry;
  return JSON.stringify([
    input.seq,
    input.prev,
    e.v,
    e.at,
    e.verdict,
    e.reason,
    e.detail,
    e.origin,
    e.chain,
    e.asset,
    e.to,
    e.amount,
  ]);
}

/** Default, zero-config: an unkeyed SHA-256 chain (corruption + naive-tamper + anchored export-verify). */
export const sha256ChainHasher: ChainHasher = {
  algorithm: "sha256",
  hash(input) {
    return createHash("sha256").update(canonical(input)).digest("hex");
  },
};

/** Keyed: an HMAC-SHA-256 chain — forgery-resistant to an attacker without `key`. The operator
 *  supplies and protects `key` (out of the log's trust zone). This is the seam's real anti-tamper. */
export function hmacChainHasher(key: string | Uint8Array): ChainHasher {
  return {
    algorithm: "hmac-sha256",
    hash(input) {
      return createHmac("sha256", key).update(canonical(input)).digest("hex");
    },
  };
}
