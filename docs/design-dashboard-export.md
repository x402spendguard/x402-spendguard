# Design: the shipped dashboard — a dump-file exporter + a static viewer (D-040)

**Status:** ratified (CC↔CHENG↔Kevin convergence, 2026-07-25). Chapter target: **0.4.0**.

## The decision (D-040): no socket. A file the guard *writes*, plus a viewer that *reads* it.

The shipped dashboard is **not** a server the guard runs. It is:

1. a **serialized export** — a documented file the guard writes (`serializeSnapshot()` → `writeSnapshotExport()`), and
2. a **static viewer** — a single dependency-free HTML file that reads the export and renders it.

No `node:http`, no loopback endpoint, no server, no `fetch`. The statically-provable **no-egress**
guarantee (PRIV-01 / T12) is the crown jewel; a socket would break the proof that the enforcement
core imports nothing socket-capable. The shipped-vs-prop distinction does **not** change this: a
loopback endpoint is a local read surface the guard owns and must defend forever, whereas a
dump-file + bring-your-own-viewer keeps that surface out of our supply chain entirely. The data is
pull-shaped and point-in-time (a snapshot is already a pull, `verify()` is already a batch op), so
nothing about it *wants* a live socket. Refused: a loopback endpoint (reopens egress); a bundled
viewer with a dependency tree (a dep can phone home — reopens egress by the back door).

## Three slices, converge-first, D1 → D2 → D3

### D1 — `serializeSnapshot()` + `writeSnapshotExport()`  (this slice)
A pure serializer for the `Snapshot` posture feed, plus a thin writer.

- **Lossless by default.** Every number present exactly. Redaction is an **opt-in caller option**, never
  a baked-in default — don't hide the owner's own data from the owner (mechanism-not-policy). The
  redaction seam is a caller-supplied `redactOrigin(origin) => string` (default identity); the
  higher-sensitivity fields are the counterparty ones (`byDomain[].origin`; later, the decision log's
  payee `to`).
- **Money as a tagged envelope, and pre-rendered.** Money serializes as
  `{ "$b": "<base-units>", "text": "<human string>" }`. The tag defends the *format*: a naive
  `JSON.parse` yields an **object**, so `Number(amount)` → `NaN` (loud), never a silent >2⁵³ corruption.
  The `text` defends the *reference consumer*: the viewer (D3) **displays `text` and does no money math
  at all**, so it cannot be the thing that corrupts. `text` is produced in trusted Node by the already-
  `>2⁵³`-tested `renderAmount` (S4); a programmatic consumer instead uses the shipped **reviver**
  (`parseSnapshotExport`) to recover exact `bigint`s from `$b`. Envelope protects the format,
  pre-render protects the reference impl, reviver serves the programmatic path — all three teach the
  safe thing. **Timestamps are plain JSON numbers** (Unix seconds, safe-range forever) — enveloping
  them buys no safety and costs readability.
- **The file is ledger-grade sensitive.** `writeSnapshotExport()` writes **`0o600`** (mirrors the
  ledger/starter, PRIV-04): the export is the *most* sensitive artifact the tool produces — full spend
  posture + the counterparty graph, materialized into a file *designed to be moved*. Written atomically
  (temp + rename) so every write is owner-only regardless of a prior file's mode. Docs state: as
  sensitive as the ledger — do not commit, log, or serve it without the same care.

### D2 — the head anchor + a `verify` CLI path
`verify(expectedHead)` and `hmacChainHasher` already exist. The security value is entirely in *where
the head is pinned*, and the honest single-tenant answer is: **the guard cannot find an attacker-
unreachable spot on a box it does not control — so it doesn't pretend to.** The guard *emits* the head
(in the export and from a `verify` CLI); the **anchor is operator-supplied** — they pin it wherever
their trust boundary actually is (a secrets store, a different host, a printed value), and `verify`
checks against what they supply. For keyed mode, the **key is operator-held**, never in the export or
the viewer. A same-directory, same-permission sibling file is **not** an anchor (the log-writer's
attacker rewrites it too — theater). The viewer *displays* the head labelled "compare to your
last-known-good"; it never claims an authority a static file can't have.

### D3 — the static viewer
A single dependency-free HTML file. Reads the dumped export; renders spend-vs-caps, the domain
breakdown, and the audit self-consistency + head display. **Displays `text` strings; does no money
math; imports nothing.** This is the visible payoff and the demo's witness surface, and the lowest-
risk slice (a read consumer), so it lands last.

## The demo (Layer 1, later) inherits every honesty rule
When the runnable demo is built on top of this: the villain is a *prompt-injected honest agent*, not a
compromised process; everything real-testnet-labelled; the mainnet boundary intact.
