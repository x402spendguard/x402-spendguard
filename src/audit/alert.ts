// The notification projection: a decision-log record → a REDACTED alert safe to send off the machine.
//
// An alert is the ONE artifact in this design that crosses the trust boundary: a separate,
// operator-wired notifier reads the local decision log and SENDS the alert over the network (a
// phone, Slack, a webhook). The decision log itself is owner-only (0o600) and carries the full
// counterparty tuple (to/origin/amount) — that is its job. A notification must NOT ship that tuple
// by default: it defaults to the minimum useful, the same deny-all-by-default discipline this
// project applies everywhere, now applied to egress. Widening the payload is an explicit operator
// choice, made KNOWING it egresses — and it is done by projecting from the record's own fields, not
// by loosening this default. (The redaction default is set by destination: a local export defaults
// lossless — hiding the owner's data from the owner is paternalism — while an alert, which leaves
// the box, defaults redacted. Same project, opposite defaults, because the destinations differ.)
//
// Pure and dependency-free: a record → an object, no I/O, so it stays inside the no-egress core and
// any notifier (ours or a third party's) inherits the redaction BY CONSTRUCTION rather than by
// remembering to strip fields — exactly as `toLogEntry` makes the PRIV-02 log projection safe.
import type { ChainedRecord } from "./hash-chain-log.js";

/**
 * A redacted-by-default notification of a decision. It carries the FACT of a decision — enough to
 * know something needs attention and where to look — and deliberately NOT the counterparty tuple.
 * `seq` is a non-sensitive pointer: it locates the FULL record in the local, owner-only decision
 * log, so an operator can look up who/what/how-much on the box without any of it crossing the wire.
 */
export interface Alert {
  /** The record's position in the chain — a pointer to the full local record; not sensitive. */
  seq: number;
  /** Decision time, decimal Unix seconds as a string (matches the log entry). */
  at: string;
  verdict: "allow" | "deny";
  /** Stable machine reason code (e.g. `cap.global`). Carries no interpolated capability. */
  reason: string;
}

/**
 * Project a decision-log record into a redacted `Alert`. By CONSTRUCTION it reads only the four
 * non-sensitive fields — a hand-listed minimal projection, exactly like `toLogEntry` is for the log
 * — so no counterparty field (`to`/`origin`/`amount`) can leak into a notification by accident.
 * A notifier renders a human message from these fields (e.g. "BLOCKED [cap.global] — entry #42, see
 * your local log"); presentation is the notifier's job, redaction is this projection's.
 */
export function toAlert(record: ChainedRecord): Alert {
  return {
    seq: record.seq,
    at: record.entry.at,
    verdict: record.entry.verdict,
    reason: record.entry.reason,
  };
}
