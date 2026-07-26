// D3 — the static viewer (VIEW-01). The viewer is a single dependency-free HTML file that reads a
// dumped export (snapshot + audit) and renders it. Its guarantees are the ones CHENG named as the
// GO condition and are PROVEN HERE, not asserted in prose:
//
//   1. no-egress by construction — it imports nothing socket-capable, fetches nothing, loads no
//      external asset. The crown-jewel property (PRIV-01) must hold at the edge too, or a dep/CDN
//      re-opens egress by the back door.
//   2. math-free — it never touches the `$b` base-unit field, never parses a number out of money.
//      It displays the pre-rendered `text` (D1 rendered it in trusted Node, >2^53-tested), so the
//      viewer is STRUCTURALLY unable to be the thing that corrupts an amount on screen.
//   3. exact large amounts — a >2^53 amount shows verbatim from `text`, never rounded.
//   4. untrusted strings are escaped — the export carries attacker-influenced counterparty data
//      (`byDomain[].origin`); the viewer must not let it inject markup.
//   5. the audit head is DISPLAY, not authority — shown as "compare to your pinned value", never
//      implying the static file verified itself.
//
// The render logic is executed here as the EXACT bytes that ship: we extract the inline logic
// script from the HTML and run it, so the test can never drift from the artifact.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const viewerPath = fileURLToPath(new URL("../viewer/index.html", import.meta.url));
const html = readFileSync(viewerPath, "utf8");
const logicBody = html.match(/<script id="viewer-logic">([\s\S]*?)<\/script>/)?.[1] ?? "";

// Pull the inline logic script (the one the test drives) out of the shipped file and evaluate it.
// `document` is undefined here, so the DOM-bootstrap inside stays dormant; only the pure functions
// (exposed on `V`) are exercised. This runs the shipped bytes — no separate copy to drift.
function loadViewer(): {
  esc: (s: string) => string;
  renderSnapshot: (snap: unknown) => string;
  renderAudit: (audit: unknown) => string;
} {
  if (!logicBody) throw new Error("viewer/index.html must contain a <script id=\"viewer-logic\"> block");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${logicBody}\nreturn V;`)() as ReturnType<typeof loadViewer>;
}

// A money envelope as it appears on the wire (D1): exact base units + pre-rendered human text.
const money = (b: string, text: string) => ({ $b: b, text });

const SNAPSHOT_FIXTURE = {
  version: 1,
  now: 1_700_000_000,
  halt: false,
  windowStart: 1_699_900_000,
  windowSeconds: 86_400,
  windowEndsAt: 1_699_986_400,
  byDenomination: [
    {
      key: "eip155:8453|0xUSDC",
      // A base-unit amount well past 2^53 — the case a naive Number() would silently round.
      spent: money("123456789012345678901234567890", "123,456,789,012,345.678901 USDC"),
      remaining: money("9000000", "9.000000 USDC"),
      caps: { perRequest: money("1000000", "1.000000 USDC"), global: money("500000000", "500.000000 USDC") },
    },
  ],
  byDomain: [
    {
      origin: "the-counterparty.example",
      byAsset: [
        { key: "eip155:8453|0xUSDC", spent: money("491000000", "491.000000 USDC"), perDomainCap: null, remaining: null },
      ],
    },
  ],
};

const AUDIT_OK = { version: 1, head: "a1b2c3d4e5f6", selfConsistent: true, brokenAt: null };
const AUDIT_BROKEN = { version: 1, head: "deadbeef", selfConsistent: false, brokenAt: 2 };

// The dangerous constructs, at the edge. Any of these could reach the network and break the
// statically-provable no-egress guarantee the core earns. The viewer must contain NONE.
const EGRESS_CONSTRUCTS: [string, RegExp][] = [
  ["fetch(", /\bfetch\s*\(/],
  ["XMLHttpRequest", /XMLHttpRequest/],
  ["WebSocket", /WebSocket/],
  ["EventSource", /EventSource/],
  ["sendBeacon", /sendBeacon/],
  ["dynamic import()", /\bimport\s*\(/],
  ["import ... from", /\bimport\s+[\w{*]/],
  ["require(", /\brequire\s*\(/],
  ["new Worker", /new\s+Worker/],
  ["new Image", /new\s+Image/],
  ["a URL scheme (://)", /:\/\//],
  ["an external src=", /\bsrc\s*=/],
  ["a <link> tag", /<link\b/i],
  ["a CSS @import", /@import/],
  ["srcdoc", /srcdoc/],
];

describe("VIEW-01 — the static viewer", () => {
  it("viewer-imports-nothing-and-cannot-egress", () => {
    // The whole file (markup + inline script + style) must contain none of the network-reaching
    // constructs, and no external script/style reference — the no-egress proof holds at the edge.
    const hits = EGRESS_CONSTRUCTS.filter(([, re]) => re.test(html)).map(([label]) => label);
    expect(hits, `viewer contains egress-capable construct(s): ${hits.join(", ")}`).toEqual([]);
    // The sole script the test drives is inline; there is no <script src=…> anywhere.
    expect(/<script[^>]*\bsrc\b/i.test(html)).toBe(false);
    expect(html).toContain('<script id="viewer-logic">');
  });

  it("viewer-is-math-free-never-touches-base-units", () => {
    // It reads `.text` only. If it never names `$b` and parses no numbers, it cannot do money math
    // and therefore cannot be the thing that rounds a large amount on screen.
    expect(logicBody).not.toContain("$b");
    for (const banned of ["Number(", "parseInt", "parseFloat", "BigInt"]) {
      expect(logicBody, `viewer must not use ${banned} on money`).not.toContain(banned);
    }
  });

  it("viewer-renders-a-large-amount-exactly-from-text", () => {
    const out = loadViewer().renderSnapshot(SNAPSHOT_FIXTURE);
    // The >2^53 amount appears verbatim from `text`…
    expect(out).toContain("123,456,789,012,345.678901 USDC");
    // …and the raw base-unit digit-string never does — it displays text, not $b.
    expect(out).not.toContain("123456789012345678901234567890");
    // Every cap and the domain breakdown render from their own text.
    expect(out).toContain("1.000000 USDC"); // per-request cap
    expect(out).toContain("500.000000 USDC"); // global cap
    expect(out).toContain("491.000000 USDC"); // domain spend
  });

  it("viewer-escapes-untrusted-counterparty-strings", () => {
    const V = loadViewer();
    // esc() neutralizes every markup metacharacter.
    expect(V.esc(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
    // A hostile counterparty origin cannot inject live markup.
    const hostile = { ...SNAPSHOT_FIXTURE, byDomain: [{ origin: "evil.example<script>alert(1)</script>", byAsset: [] }] };
    const out = V.renderSnapshot(hostile);
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("viewer-audit-head-is-compare-not-verified", () => {
    const V = loadViewer();
    const ok = V.renderAudit(AUDIT_OK).toLowerCase();
    expect(ok).toContain("a1b2c3d4e5f6"); // the head is shown…
    expect(ok).toContain("compare"); // …as a value to compare out-of-band
    // …and it never claims an authority a static file cannot have.
    expect(ok).not.toContain("verified");
    expect(ok).not.toContain("authentic");
    // A broken chain is surfaced honestly, with where it broke, and is NOT labelled consistent.
    const broken = V.renderAudit(AUDIT_BROKEN);
    expect(broken).toContain("2"); // brokenAt index surfaced
    expect(broken.toLowerCase()).toContain("failed");
  });
});
