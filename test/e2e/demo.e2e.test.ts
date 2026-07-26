// The `npm run demo` scenario is a PUBLIC, CLAIM-MAKING artifact — it gets the same claim-integrity
// bar as a doc or an X post. This test runs the demo's REAL scenario core (the same one the narrated
// demo prints) with no presentation, and asserts the numbers the demo shows are the numbers the guard
// actually produces. If the guard's cumulative accounting ever changed so the demo started lying
// (blocked at the wrong query, wrong reason, a signature slipping through on a deny), this turns red.
//
// Opt-in e2e (real @x402 client, localhost) — never the default green-main gate.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runDrainScenario } from "../../scripts/demo.js";

describe("demo scenario — the numbers the demo claims are the numbers the guard produces", () => {
  it("a fooled agent's cumulative drain is capped at the global ceiling, on the real client", async () => {
    const r = await runDrainScenario();

    // Ten $2 queries fit under the $20 ceiling; the eleventh is the one accounting-across-payments
    // catches — every individual payment was within the $5 per-request cap.
    expect(r.approvedCount).toBe(10);
    expect(r.blockedAt).toBe(11);
    expect(r.queries.slice(0, 10).every((q) => q.approved)).toBe(true);

    // The block is the GLOBAL cumulative cap (the hero), and the un-dismissable structural proof:
    // no signing route was reached on the denied payment.
    expect(r.blockReason).toBe("cap.global");
    expect(r.blockTouched).toEqual([]);
    // …while an APPROVED payment really did reach the one guarded route.
    expect(r.queries[0].touched).toEqual(["signTypedData"]);

    // The ledger the demo prints is the real snapshot: spent hit exactly the ceiling, remaining is 0.
    expect(r.snapshotSpent).toBe(r.capBase);
    expect(r.snapshotSpent).toBe(20_000_000n);
    expect(r.snapshotRemaining).toBe(0n);

    // The human strings the demo shows are the shipped describePolicy / display renders (not printf).
    expect(r.capHuman).toBe("20.000000 USDC");
    expect(r.perRequestHuman).toBe("5.000000 USDC");
    expect(r.demandHuman).toBe("$100.00");
  });

  it("the export the demo writes is read exactly by the shipped viewer (no demo-only format)", async () => {
    // Prove the payoff is un-fakeable: the same export shape the viewer consumes, rendered by the
    // shipped viewer bytes, shows the real numbers.
    const { tmpdir } = await import("node:os");
    const r = await runDrainScenario(tmpdir(), true);
    expect(r.exportPath).toBeTruthy();
    const onDisk = JSON.parse(readFileSync(r.exportPath!, "utf8"));

    const html = readFileSync(fileURLToPath(new URL("../../viewer/index.html", import.meta.url)), "utf8");
    const logic = html.match(/<script id="viewer-logic">([\s\S]*?)<\/script>/)![1];
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const V = new Function(`${logic}\nreturn V;`)() as { renderSnapshot: (s: unknown) => string };
    const rendered = V.renderSnapshot(onDisk);

    expect(rendered).toContain("20.000000 USDC"); // spent, at the ceiling
    expect(rendered).toContain("0.000000 USDC"); // remaining
  });
});
