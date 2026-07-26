// D3 — the viewer's DOM WIRING (VIEW-01, bootstrap path). viewer.test.ts proves the pure render
// functions against the shipped bytes; this proves the glue that connects a dropped file to those
// functions — the ~30 lines guarded by `typeof document !== "undefined"` that never run under a plain
// unit test. Rather than pull in a DOM library (a dev-dep we don't want), we execute the REAL
// bootstrap bytes against a minimal fake `document`/`FileReader`, so a regression in "load a file →
// it renders" (likely once the Layer-1 demo edits this file) turns a test red instead of shipping.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(fileURLToPath(new URL("../viewer/index.html", import.meta.url)), "utf8");
const logic = html.match(/<script id="viewer-logic">([\s\S]*?)<\/script>/)![1];

// A minimal fake element: records event handlers and innerHTML/hidden writes; no-op classList.
function makeEl() {
  const handlers: Record<string, (e: unknown) => void> = {};
  return {
    innerHTML: "",
    hidden: true,
    files: [] as unknown[],
    classList: { add() {}, remove() {} },
    addEventListener(type: string, h: (e: unknown) => void) {
      handlers[type] = h;
    },
    _fire(type: string, e: unknown) {
      handlers[type]?.(e);
    },
  };
}

// Run the REAL bootstrap with fakes injected as globals. Passing `document` as a bound name makes
// `typeof document !== "undefined"` true, so the bootstrap block executes exactly as in a browser.
function boot() {
  const els: Record<string, ReturnType<typeof makeEl>> = {
    drop: makeEl(),
    file: makeEl(),
    "snapshot-body": makeEl(),
    "snapshot-panel": makeEl(),
    "audit-body": makeEl(),
    "audit-panel": makeEl(),
  };
  const alerts: string[] = [];
  const fakeDocument = { getElementById: (id: string) => els[id] };
  // A synchronous FileReader: readAsText copies the fake file's content and fires onload.
  class FakeFileReader {
    result: string | null = null;
    onload: (() => void) | null = null;
    readAsText(f: { content: string }) {
      this.result = f.content;
      this.onload?.();
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("document", "FileReader", "alert", logic)(
    fakeDocument,
    FakeFileReader,
    (m: string) => alerts.push(m),
  );
  return { els, alerts };
}

// Real export shapes (verified against a live round-trip: snapshot has byDenomination[], audit has
// selfConsistent:boolean — the two branches the bootstrap detects on).
const SNAPSHOT_JSON = JSON.stringify({
  version: 1, now: 1, halt: false, windowStart: 1, windowSeconds: 86400, windowEndsAt: null,
  byDenomination: [{
    key: "eip155:8453|0xUSDC",
    spent: { $b: "0", text: "0.000000 USDC" },
    remaining: { $b: "500000000", text: "500.000000 USDC" },
    caps: { perRequest: { $b: "1000000", text: "1.000000 USDC" }, global: { $b: "500000000", text: "500.000000 USDC" } },
  }],
  byDomain: [],
});
const AUDIT_JSON = JSON.stringify({ version: 1, head: "abc123def", selfConsistent: true, brokenAt: null });

describe("VIEW-01 — the viewer DOM wiring", () => {
  it("a dropped snapshot file lands in the snapshot panel", () => {
    const { els } = boot();
    els.file.files = [{ content: SNAPSHOT_JSON }];
    els.file._fire("change", {});
    expect(els["snapshot-panel"].hidden).toBe(false);
    expect(els["snapshot-body"].innerHTML).toContain("500.000000 USDC");
    // Untouched panel stays hidden — detection routed to exactly one.
    expect(els["audit-panel"].hidden).toBe(true);
  });

  it("a dropped audit file lands in the audit panel, labelled compare-not-verified", () => {
    const { els } = boot();
    els.file.files = [{ content: AUDIT_JSON }];
    els.file._fire("change", {});
    expect(els["audit-panel"].hidden).toBe(false);
    expect(els["audit-body"].innerHTML).toContain("abc123def");
    expect(els["audit-body"].innerHTML.toLowerCase()).not.toContain("verified");
    expect(els["snapshot-panel"].hidden).toBe(true);
  });

  it("a drag-drop of a snapshot renders the same as the file picker", () => {
    const { els } = boot();
    els.drop._fire("drop", { preventDefault() {}, dataTransfer: { files: [{ content: SNAPSHOT_JSON }] } });
    expect(els["snapshot-panel"].hidden).toBe(false);
    expect(els["snapshot-body"].innerHTML).toContain("500.000000 USDC");
  });

  it("an unrecognized file alerts and renders nothing", () => {
    const { els, alerts } = boot();
    els.file.files = [{ content: JSON.stringify({ version: 1, something: "else" }) }];
    els.file._fire("change", {});
    expect(alerts.length).toBe(1);
    expect(els["snapshot-panel"].hidden).toBe(true);
    expect(els["audit-panel"].hidden).toBe(true);
  });

  it("malformed JSON alerts instead of throwing", () => {
    const { els, alerts } = boot();
    els.file.files = [{ content: "{ not json" }];
    expect(() => els.file._fire("change", {})).not.toThrow();
    expect(alerts.length).toBe(1);
  });
});
