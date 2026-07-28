// `npm run notify` — a REFERENCE notifier for the decision sink. It shows the whole pattern:
//
//   read the durable decision log  →  project each new record to a REDACTED alert  →  send it
//
//   • Reads the log the guard ALREADY wrote (synchronously, write-ahead — `returned ⟹ recorded`).
//     The notifier is out-of-process and never on the payment path, so it can be as slow, flaky, or
//     intermittent as it likes and it can NEVER add latency to a payment decision. The durable log
//     IS the buffer: this tracks a cursor (last `seq` shipped), resumes across restarts, and drops
//     nothing — no in-memory queue, no overflow to bound.
//   • Projects each record through `toAlert`, so the alert carries the FACT of a decision
//     (seq/verdict/reason/at) and NOT the counterparty tuple — because a notification is the one
//     artifact that leaves the machine (ALERT-01: redacted-by-default).
//   • The SEND is the one egress point, stubbed to the console here. Replace `consoleSend` with your
//     webhook / Slack / SMS POST — THAT is where a notification crosses the network, deliberately
//     OUTSIDE the guard's no-egress core. The core writes + projects locally; this operator-wired
//     process is the only thing that ever reaches out.
//
// In YOUR app, import these from "x402-spendguard"; this repo file imports from ../src so it runs
// against the working tree and is exercised by test/decision-notifier.test.ts.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDecisionLogAfter } from "../src/adapters/decision-log-reader.js";
import { toAlert, type Alert } from "../src/audit/alert.js";
import { HashChainDecisionLog } from "../src/audit/hash-chain-log.js";
import type { LogEntry } from "../src/audit/decision-log.js";

/** Render a human message from ONLY the redacted alert fields — never any counterparty data. The
 *  `seq` points the operator at the full record in their local, owner-only decision log. */
export function renderAlert(a: Alert): string {
  const mark = a.verdict === "deny" ? "BLOCKED" : "allowed";
  return `[x402-spendguard] ${mark} [${a.reason}] at ${a.at} — entry #${a.seq} (see your local decision log)`;
}

/** The ONE egress point. Stubbed to the console; swap the body for your webhook/Slack/SMS POST. This
 *  is where — and the only place — a notification leaves the machine, deliberately outside `src/`. */
export type Send = (alert: Alert, message: string) => void | Promise<void>;
const consoleSend: Send = (_alert, message) => {
  // eslint-disable-next-line no-console
  console.log(message);
};

interface Cursor {
  lastSeq: number;
}
function readCursor(path: string): number {
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as Cursor).lastSeq;
  } catch {
    return -1; // no cursor yet → start from the beginning
  }
}
function writeCursor(path: string, lastSeq: number): void {
  writeFileSync(path, JSON.stringify({ lastSeq }), { mode: 0o600 });
}

/**
 * Process every decision newer than the persisted cursor exactly once: project → send → advance the
 * cursor. Returns the alerts sent. Reads from the durable log, so it never touches the payment path;
 * the cursor is advanced AFTER each send, so a crash re-sends at most one (at-least-once; `seq` is a
 * natural dedupe key) and never drops a decision.
 */
export async function drainOnce(opts: { logPath: string; cursorPath: string; send?: Send }): Promise<Alert[]> {
  const send = opts.send ?? consoleSend;
  const from = readCursor(opts.cursorPath);
  const sent: Alert[] = [];
  for (const record of readDecisionLogAfter(opts.logPath, from)) {
    const alert = toAlert(record); // REDACTED here — the raw record (with to/origin/amount) never reaches `send`
    await send(alert, renderAlert(alert));
    sent.push(alert);
    writeCursor(opts.cursorPath, alert.seq);
  }
  return sent;
}

async function main(): Promise<void> {
  // A self-contained demonstration: write two real decisions (one allowed, one blocked) to a temp
  // log, then drain them to the console as redacted alerts. In production, point `logPath` at the log
  // your guard writes and run `drainOnce` on an interval (or trigger it when the log file changes).
  const dir = mkdtempSync(join(tmpdir(), "x402-notify-"));
  const logPath = join(dir, "decisions.log");
  const cursorPath = join(dir, "notifier.cursor");
  try {
    const base: Omit<LogEntry, "verdict" | "reason" | "amount"> = {
      v: 1,
      at: "1700000000",
      detail: "example",
      origin: "data-api.example",
      chain: "eip155:8453",
      asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      to: "0x1111111111111111111111111111111111111111",
    };
    const log = new HashChainDecisionLog(logPath);
    await log.append({ ...base, verdict: "allow", reason: "ok", amount: "2000000" });
    await log.append({ ...base, verdict: "deny", reason: "cap.global", amount: "2000000" });

    // eslint-disable-next-line no-console
    console.log("Draining the decision log → redacted alerts (the only thing that would cross the network):\n");
    await drainOnce({ logPath, cursorPath });
    // eslint-disable-next-line no-console
    console.log(
      "\nNotice what did NOT cross the wire: no payee, no origin, no amount — only the fact of the\n" +
        "decision and a local pointer (entry #). The counterparty graph stays on the box; widen the\n" +
        "payload only by an explicit operator choice, knowing it egresses.",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (!process.env.VITEST) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
}
