# x402-spendguard — Threat Model (v1)

**Point of contact:** Kevin Brown, x402.spendguard@gmail.com
**Status:** Pre-alpha. This models the **v1** guard (anti-drain + signature integrity). It is a living document; corrections are welcome at the address above.
**Scope of this document:** the *client-side spend guard*. It is deliberately narrower than a threat model of the x402 *protocol* — see [§5a](#5a-which-documented-x402-attacks-are-in-scope) for how the two relate.

---

## How to read this

A threat model earns its keep by tying every control to a specific adversary capability, and by refusing to claim a control against a threat that does not exist. Where a control's justification is narrower than it first appears, we say so. Where we do **not** defend, we say that first and loudly — for a guard, the boundary is the product.

**Evidence tiers** (applied to every threat):
- **(a) in the wild** — a real attacker hit real users for real loss.
- **(b) in research** — a PoC, red-team result, or paper demonstrated it, mostly under responsible disclosure.
- **(c) anticipated** — a design gap or plausible composition, not shown exploited.

**Governing design principle — mechanism, not policy.** The guard enforces the user's explicit, deterministic policy; it forms no opinions of its own. A control that enforces a user-authored rule deterministically is *mechanism* (in scope). A control that requires the guard to judge what is "suspicious" is *policy in the guard* (rejected — see [§6](#6-non-goals)).

---

## 1. System model — what it is, where it sits, and what it is not

**What it is.** A decision function on the agent's payment path. It receives a proposed x402 payment plus the HTTP 402 challenge that payment answers, evaluates the user's policy, and returns **allow** or **deny** *before the payment authorization is signed*. Settlement on-chain is irreversible; signing is the last reversible moment; the guard lives there.

**Where it sits.** Two interposition points, both verified against the x402 source:
- **`onBeforePaymentCreation` (x402 v2 client hook)** — fires with the selected `PaymentRequirements` (payTo, amount, asset, network, resource) *before* the authorization struct is built. Rich context; the signed struct does not yet exist.
- **Signer wrap (v1 and v2)** — sees the actual `TransferWithAuthorization` struct at signing time, but not the resource URL.

Neither point alone holds both the challenge and the struct; correlating them is an adapter concern (see [§7, ASM3](#7-assumptions-and-their-failure-modes)).

**What it is not** — stated first, because the boundary is the product:

- **Not a custodian.** It never holds, stores, or touches keys or funds. A guard that held the key would be a different, higher-liability product.
- **Not a wall — a seatbelt.** It constrains an *honest* agent that may be lied to (adversary A1). It does **not** enforce against an agent whose code an attacker controls (A5), which can reach the signing key directly and never consult the guard. It provides **visibility into what is about to be signed, not authority over whether it is signed.** This is the same enforcement ceiling as every other client-side guard we are aware of.
- **Not a network service.** It makes no outbound calls, ships no telemetry, and has no hosted component in the payment path. It runs inside the user's process, on the user's machine. The runtime is closed-mouthed by construction, not by configuration.
- **Not full x402 protocol hardening.** v1 is anti-drain **plus signature integrity**. It is **not** replay/nonce protection, not payment-completeness verification, and not a fix for the protocol's unsigned-`resource` gap (documented in [x402-protocol-notes.md](docs/x402-protocol-notes.md)).

---

## 2. Assets

- **AS1 — Funds reachable by the signing key.** The asset itself.
- **AS2 — Integrity of the spend accounting.** Corrupt the ledger and every cap becomes meaningless; the accounting is a security asset, not merely a datastore.
- **AS3 — Decision-log integrity.** The forensic record; if forgeable, post-incident analysis is worthless.
- **AS4 — Decision-log confidentiality.** A map of an account's money — destinations, amounts, timing, patterns. Its severity is *deliberately reduced* by requirement PRIV-02 (the log never contains the signed payload), because otherwise the log would also hold bearer capabilities anyone could submit (see [§5, T11](#5-threats--controls)).

---

## 3. Trust boundary (v1)

**Trusted** (kept deliberately small — a minimal Trusted Computing Base is the goal; a *long* trusted list is what should give a reviewer pause):
- the agent process the guard runs in;
- the local machine and its clock — **trusted only in the fail-safe direction** (a clock anomaly may never increase available budget or extend a capability; see CLOCK-01);
- the signing key's storage.

**Untrusted:**
- the network;
- the resource server;
- the 402 challenge;
- the facilitator's honesty about settlement;
- any content the agent has read (web pages, tool output, RAG documents, MCP responses).

**An honest tension, stated rather than hidden:** one trusted item is the local machine, and adversary A5 (compromised process) is the admission that the machine *may* be turned against us. Trusting the host in v1 is a **scoping decision, not a safety claim**. It is the seatbelt/wall boundary again. A reviewer should see us name this rather than infer we missed it.

**The execution environment is the trust boundary (single-tenant isolation).** Concretely, "trusting the local machine" means the guard trusts the **isolation boundary it runs inside** — a container, a serverless sandbox, a single-tenant VM, a mobile app sandbox — and assumes **no hostile user or process shares that boundary** (one that does can read the signing key and defeat any in-process guard — that is A5). This is the honest model for where agents actually run, and — this is the point — it is a **uniform statement across every platform**, which is what "consistent security across diverse runtimes" actually requires. Two consequences, stated so they are not mistaken for a stronger claim:

- **Enforcement is platform-agnostic and always active.** The anti-drain decision (kill switch, allowlist, caps, binding) is a pure function; it behaves identically on Linux, Windows, macOS, serverless, or mobile.
- **At-rest hardening is *opportunistic*, not the trust model.** Protecting the ledger and log *files* from a co-located reader/writer (the POSIX permission gates today, ACCT-06/CONF-01/PRIV-04; a tamper-evident audit log next) is a **defense-in-depth layer added where the platform offers a meaningful mechanism** — POSIX mode bits on Unix, NTFS ACLs on Windows via file placement (`%LOCALAPPDATA%`). Where a platform offers none (Windows synthesizes mode bits, so the gates are skipped — PLAT-01; a stateless FS has no persistent perms at all), the guard **degrades to the isolation boundary, never to a false sense of protection** — it does not pretend a check ran that did not.

Why this, rather than a single universal at-rest mechanism (e.g. a keyed MAC over the ledger)? Because such a mechanism only **relocates** the platform dependency onto **key storage** — protecting the key at rest from a co-located attacker is the *same* per-OS problem — and, on a platform that already had a prevention gate (Unix), it *trades prevention for detect-then-deny* (a self-inflicted denial of service on benign corruption like a backup restore). It is the right tool for a genuinely **shared multi-user host**, and it is available there **without bloating the v1 core**: the `SpendStore` interface is topology-agnostic (D-031), so a shared-host operator can back the guard with a MAC'd / ACL'd / KMS-keyed store of their own. v1 ships the single-tenant implementation **and the seam** — not a guessed multi-user implementation.

---

## 4. Adversaries (by capability)

| ID | Adversary | Capability | Headline tier |
|----|-----------|------------|---------------|
| **A1** | Injection | Controls content the agent reads; **cannot run code**; makes an honest agent *want* the wrong payment | (a) |
| **A2** | Malicious resource server | Controls the 402 challenge (payTo, amount, asset, network, maxTimeoutSeconds) | (b) |
| **A3** | MITM on the 402 | Rewrites the challenge before signing, *if TLS is absent or downgraded* | (c) |
| **A4** | Malicious facilitator | Can censor or lie about settlement; **cannot steal** (the signature pins recipient, value, nonce, window) | (b/c) |
| **A5** | Compromised agent process | Malicious dependency / RCE; has the agent's privileges and reaches the key directly | **out of scope for v1** |
| **A6** | Runaway loop | Not an adversary — the honest agent in a cycle; same drained wallet | (a) mechanism |
| **A7** | Adversary targeting the guard | Corrupts AS2 to raise caps; reads AS4; crashes the guard between decision and settlement; races two payments past a shared cap | (c) |
| **A8** | Policy-integrity adversary | Can write `policy.yaml` *without* code execution — sets `halt=false`, widens caps, adds an address to the allowlist | (c) |

A1 is the headline: prompt injection driving a real wallet drain is the attack with the cleanest in-the-wild narrative to date (Grok/Bankr, May 2026 — an injection the agent decoded and the payment layer executed). A5 names the largest documented *loss* category (the npm supply-chain incidents), and v1 explicitly does not defend it.

---

## 5. Threats → controls

Each threat names the adversary, the asset, the evidence tier, and the requirement(s) that answer it. Requirement IDs are defined in [REQUIREMENTS.md](REQUIREMENTS.md).

| # | Threat | Actor | Asset | Tier | Requirements |
|---|--------|-------|-------|------|--------------|
| T1 | Payment redirected to attacker address | A1, A2, A3 | AS1 | a | ALLOW-01/02, BIND-02 |
| T2 | Oversized single payment | A1, A2 | AS1 | b | CAP-01, BIND-01 |
| T3 | Repeated drain via one endpoint | A1, A6 | AS1 | a | CAP-02 |
| T4 | Account-wide drain across endpoints | A1, A6 | AS1 | a | CAP-03 |
| T5 | Overpayment (v1 facilitators accept `value ≥ amount`) | A2 | AS1 | b | BIND-01 |
| T6 | Long-lived bearer capability (`validBefore ≫ maxTimeoutSeconds`) | A2 | AS1 | c | BIND-03 |
| T7 | Asset/chain confusion (cap evaluated in the wrong denomination) | A2 | AS1, AS2 | c | BIND-04, CAP-04 |
| T8 | Guard fails **open** on malformed input | A2, A7 | AS1 | b | FAIL-01/02 |
| T9 | Cap bypass via concurrency race | A7, A6 | AS1, AS2 | c | ACCT-02 |
| T10 | Cap bypass via crash between decision and settlement | A7 | AS1, AS2 | c | ACCT-01 |
| T11 | Bearer capability leaked via the log | A7 | AS4 | b | PRIV-02 |
| T12 | Guard exfiltrates the user's money-map | — | AS4 | a* | PRIV-01/03 |
| T13 | Emergency stop required | operator | AS1 | — | HALT-01 |
| T14 | Budget keyed on an attacker-chosen domain (redirect) | A2, A3 | AS2 | c | DOM-01 |
| T15 | Policy-file tampering | A8 | AS1, AS2 | c | CONF-01 |

\* T12 is tier (a) as a *pattern* — shipping payment metadata to a vendor endpoint by default is observed behavior in at least one existing tool (see [prior-art.md](docs/prior-art.md)). Our control is that we do not do it.

### The binding checks deserve their honest justification

In the *honest* x402 client, `value` is copied from the challenge `amount` and `to` from `payTo`, so T1/T2/T5 do not arise from the honest client alone. The binding checks (BIND-01/02/04) buy two things:

1. **Soundness.** The guard evaluated caps against the challenge's `amount` and the allowlist against `payTo`. If the *signed* `value`/`to` differ from those, the cap and allowlist decisions were meaningless. Binding is what makes those decisions **sound** under any lower-layer tamper — a malicious SDK extension, or a dependency compromised enough to alter the payload after requirement selection but not enough to bypass the guard entirely.
2. **A standalone control.** BIND-03 bounds the capability's lifetime against the challenge's declared `maxTimeoutSeconds` — a bound **nothing downstream enforces** (verified: facilitators do not check it), honest client or not.

This framing survives the obvious reviewer question ("the honest client already sets `value = amount`, so what is the check for?").

### 5a. Which documented x402 attacks are in scope

The EIP-3009 signature already pins recipient, amount, and nonce. So a payer can only *overspend beyond policy* four ways: **wrong destination, wrong amount, too many, too long.** Mapping the documented x402 research attacks against that fact:

| Documented attack | Causes payer to *overspend*? | In scope for a client-side guard? |
|-------------------|------------------------------|-----------------------------------|
| Replay → many grants per settlement | No — on-chain nonce is single-use; payer charged once | No — server-side idempotency |
| Settlement front-running (caller-unbound EIP-3009) | No — signed `to`/`value` fixed; funds still go to `payTo`, once | No — griefing / DoS, not overspend |
| Reorg revert-grant | No | No — resource-server finality policy |
| Proxy/CDN cache leakage | No | No — server / proxy configuration |
| Denial of settlement (paid-but-denied) | No | No — facilitator / server |
| Cross-resource / cross-challenge substitution | No — one payment, applied to the wrong resource | No — *misdelivery*, not overspend (v2 nonce-ledger at most) |
| **Overpayment (inflated challenge; v1 `≥`)** | **Yes** | **Yes → CAP + BIND-01** |
| **Redirect (malicious challenge / MITM `payTo`)** | **Yes** | **Yes → ALLOW + BIND-02** |
| **Runaway / repeated payments** | **Yes** | **Yes → cumulative caps** |
| **Long-lived capability (`validBefore`)** | **Yes** | **Yes → BIND-03** |

**Scoping statement.** The signature protects the payer against theft; the only ways a payer overspends *beyond policy* are wrong-destination / wrong-amount / too-many / too-long, and the caps, allowlist, and binding checks cover exactly those. The replay/front-running/reorg/cache/denial family is real and important, but it harms the resource server, or it is griefing, or it is misdelivery — none of it makes the payer's wallet lighter than policy allows. A client-side guard structurally cannot fix server-side idempotency or CDN caching, and should not pretend to.

**Boundary line:** *we guard what leaves the wallet, not what the wallet receives in return.* "Paid for A, got B" is misdelivery, and it is out of role (see [§10](#10-residual-risk-and-out-of-role)).

The server-, facilitator-, discovery-, and chain-layer attacks above belong to a **protocol- and ecosystem-level** threat model — owned by the resource server, the facilitator, and the chain — not by a client-side guard. We scope deliberately to the wallet's edge and leave those layers to the parties that control them.

---

## 6. Non-goals

For a guard, the boundary is a deliverable. v1 explicitly does **not**:

- **Claim to be more enforceable than any other client-side guard.** Adversary A5 (an agent holding the wallet) calls the signer directly and bypasses any in-process guard identically. We provide better *visibility* into what is about to be signed, not more *authority* over whether it is signed. This sentence belongs in the README verbatim, or the README oversells.
- **Defend against a compromised agent process (A5)** — the class with the largest documented real-world losses. That is the "walk / run" rung of a longer roadmap (a key-holding local daemon; on-chain delegation), not v1.
- **Support non-EVM chains or non-`exact` schemes in v1.** v1 is EIP-3009 `exact` on EVM only (ASM5). Solana/SVM and the `upto` scheme are denied with a clear reason and deferred to v2.
- **Do anything after settlement.** Irreversibility is the premise of the tool.
- **Defend against a missing TLS layer (A3).** We assume the transport is TLS; if it is not, the challenge is rewritten before we ever see it.
- **Perform anomaly / spike detection.** This is deliberate, not an omission. Statistical "this payment looks unusual" judgments are the guard *authoring policy at runtime* — which violates the mechanism-not-policy principle — and a guard that false-denies on a heuristic erodes the exact trust that is its product. A user-configured **deterministic rate cap** ("at most N payments per window") is a different thing: it is mechanism enforcing an explicit rule, and it is a legitimate future cap dimension.
- **Address the eight server/facilitator/chain-layer x402 attacks in [§5a](#5a-which-documented-x402-attacks-are-in-scope)**, for the structural reason given there.

---

## 7. Assumptions and their failure modes

- **ASM1 — The guard is on the payment path.** If integration is wrong or bypassed, the guard is *absent, not permissive*. This is advisory and is stated as such.
- **ASM2 — The local clock is roughly correct.** BIND-03's window bound depends on it. A badly wrong clock weakens the bound; CLOCK-01 constrains the failure to the safe direction.
- **ASM3 — The requirement the guard evaluates is the requirement the payment pays against.** This is the [§1](#1-system-model--what-it-is-where-it-sits-and-what-it-is-not) interposition split: the v2 hook has the requirement without the struct; the signer wrap has the struct without the resource URL. The adapter must correlate them at one point. If it cannot, the binding checks degrade from "compare what was asked to what is signed" down to "the signed struct is internally consistent," which is weaker. This constrains the adapter, not the pure core (which takes both as arguments). *Open adapter question.*
- **ASM4 — Scheme is `exact`.** BIND-01's strict `value == amount` is correct for the `exact` scheme and **wrong** for `upto` / `auth-capture`, where the signed value is a ceiling and the server sets the actual charge (0 → max) post-consumption. v1 targets `exact` only and denies other schemes with a clear reason (BIND-05). `upto` support is deferred to v2, where the rule is: bind against the maximum, and disclose to the user that "the server may charge up to X." (`upto` is a v2-only scheme in the protocol; deferring it excludes no deployed legacy workload.)
- **ASM5 — Chain family is EVM.** v1 evaluates only EIP-3009 `exact` on EVM chains, whose payment is a legible field-labeled EIP-712 struct our binding checks can read. **Solana/SVM signs a different artifact** (a partially-signed transaction) that our `Authorization` type cannot represent; it is denied at parse (SCOPE-01) and deferred to v2. This is a ratified scope cut, not a refinement — see [decisions D-017](docs/decisions.md). Base, where most current x402 volume lives, is EVM, so v1 covers today's dominant venue.
- **ASM6 — Deployment uses a writable, persistent ledger the store can prove atomic; unsupported topologies now fail LOUD (D-031).** The bundled `FileSpendStore` needs a path that is writable, survives restarts, and honors atomic exclusive-create. The governing principle — **an unsupported deployment topology must fail _loud_, not silently mis-enforce** — is now enforced, not just documented: the store runs a **concurrent** startup self-test and refuses (`store.unverified`, fail-closed) on a filesystem that can't prove it honors concurrent atomic exclusive-create, and refuses a known-unsafe network mount (NFS/SMB) outright. The three former *silent* failures: (a) *shared storage across processes* — the ACCT-05 lost-update — is **closed** by the versioned compare-and-swap store; (b) *read-only filesystem* — the store cannot create its ledger and errors *loudly* at write rather than silently no-op'ing; (c) *ephemeral storage* (serverless per-instance `/tmp`) — remains a genuine limitation: cumulative caps need a durable store, and a runtime with no durable store *anywhere* cannot enforce them — the honest posture is to inject a durable store via the topology-agnostic seam (the CAS interface generalizes to a DB/Durable Object), or run one long-lived process with a real disk. Richer serverless/diskless topologies are future store *implementations* of the same versioned interface, not a re-architecture. (D-031; [design note](docs/design-acct-05-cas-store.md).)

---

## 8. Requirements

The numbered, testable requirements — each a single falsifiable assertion, each naming the test that proves it, each tagged to a build — are maintained in **[REQUIREMENTS.md](REQUIREMENTS.md)**. A requirement that cannot name a test is not a requirement; it is an open question.

---

## 9. Residual risk and out of role

We separate what our controls *fail to stop* from what is *not the guard's job*, because conflating them is dishonest.

**Residual risk (real threats our controls do not stop):**
- A compromised agent process (A5).
- Anything after settlement.
- A missing TLS layer (A3).

A fully honest v1, integrated correctly, reduces drain to the limit of policy and makes the cap and allowlist decisions sound against lower-layer tampering. It does not make the agent's host trustworthy.

**Out of role (not the guard's job, by design):**
- The guard *enforces* policy; it does not *author or evaluate* it. A loss occurring entirely within the bounds the user configured is not a guard failure — it is the guard working as specified. Policy quality is the user's responsibility.
- Misdelivery ("paid for A, got B") — we guard what leaves the wallet, not what the wallet receives in return.

---

## 10. References

- x402 monorepo — `github.com/x402-foundation/x402` (mirror `github.com/coinbase/x402`), inspected 2026-07-09/10. Protocol facts and file-level citations are collected in [docs/x402-protocol-notes.md](docs/x402-protocol-notes.md).
- Prior art (existing x402 spend guards), read at the source level: [docs/prior-art.md](docs/prior-art.md).
- The x402 security research this model relies on (arXiv preprints — *not* peer-reviewed; IDs to be spot-checked before any citation is relied upon): 2605.11781 and 2605.30998, with related work. Specific findings are attributed in the protocol notes.
- In-the-wild incidents referenced (Grok/Bankr, supply-chain compromises) are documented via multiple secondary sources; exact figures vary by outlet and are not treated as load-bearing here.

*This document is provided as-is, without warranty. v1 is an anti-drain and signature-integrity guard, not complete x402 security.*
