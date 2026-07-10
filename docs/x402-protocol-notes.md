# x402 Protocol Notes (for a client-side guard)

**Point of contact:** Kevin Brown, x402.spendguard@gmail.com
**Purpose:** the protocol facts a client-side spend guard depends on, verified against source. Published because an honest map of what x402 does and does not bind is useful to anyone building on the rail — and because our threat model rests on these facts, so they should be checkable.
**Method:** read from the x402 monorepo `github.com/x402-foundation/x402` (mirror `github.com/coinbase/x402`), inspected 2026-07-09/10 (Permit2/`upto` pass at commit `dd927a26`). Where the spec prose and the Zod schemas disagree, **the Zod schemas are treated as ground truth.** Line numbers are approximate and may drift; file paths and struct names are the stable references.

> **Caveat.** This reflects the source at the dates above. x402 moves quickly. Verify against current source before relying on any specific claim.

---

## 1. Two live generations — a guard must handle both

- **v1 / legacy** (`typescript/packages/legacy/`): headers `X-PAYMENT` / `X-PAYMENT-RESPONSE`; field `maxAmountRequired`; `network` a loose string (`"base-sepolia"`). This is what the deployed `x402-fetch` / `x402-axios` clients use.
- **v2** (`typescript/packages/core/` + `@x402/*`): headers `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`; `maxAmountRequired` → `amount`; `network` is CAIP-2 (`"eip155:8453"`); stricter checks.

## 2. What is signed (the `exact` EVM scheme, EIP-3009)

The signature is EIP-712 typed data over an EIP-3009 `TransferWithAuthorization`:

```
TransferWithAuthorization { from, to, value, validAfter, validBefore, nonce }
```

with domain `{ name, version, chainId, verifyingContract }`, where `name`/`version` come from `requirements.extra` and **`verifyingContract` is the token contract** — not the resource server. The `X-PAYMENT` payload is `base64(JSON)` (standard base64, not base64url).

**The central fact for a guard: the signature binds *money movement*, not the *request*.** It commits to `{from, to, value, validAfter, validBefore, nonce}` under the token's domain. It does **not** commit to the `resource` URL, the resource-server identity, the scheme string, or the human-readable network label.

## 3. What nobody enforces

- **The `resource` URL is neither signed nor checked by anyone.** A payload signed for challenge A verifies against challenge B whenever B shares `payTo`, amount, asset, and chain, and the time window is open. The reference implementation carries a TODO to this effect ("verify resource is not already paid for (next version)"); the v2 spec's replay-prevention section claims no challenge binding. This is a **protocol-level gap**, not an implementation lapse.
- **`maxTimeoutSeconds` is advisory only.** The client sets `validBefore` itself; the facilitator checks presence/sanity but **not** that `validBefore ≤ now + maxTimeoutSeconds`. Long-lived authorizations can be minted freely. (→ our BIND-03 enforces the bound the protocol declares but ignores.)
- **Overpayment verifies on v1.** v1 facilitators accept `value ≥ maxAmountRequired`; v2 tightened to exact equality. On the deployed v1 path, an agent signing 10× the asking price passes every check the ecosystem performs. (→ our BIND-01 enforces `value == amount`.)
- **No pre-settlement nonce dedup on EVM.** The on-chain EIP-3009 nonce is the only true replay backstop, and only after a transaction lands.

**The signed payload is a bearer capability.** EIP-3009 `transferWithAuthorization` may be submitted by anyone holding the signed payload (the EIP itself recommends `receiveWithAuthorization` to avoid this). Consequence for a guard: **never log the payload or the payment header** — doing so writes an unlocked capability to disk. (→ our PRIV-02.) Note this does *not* let a third party steal: the signature pins `to`/`value`/`nonce`, so a captured payload can only send the payer's funds to the payer's intended recipient, once.

## 4. Permit2 does not close the resource gap

The `exact` scheme also supports `assetTransferMethod: "permit2"` (client path `mechanisms/evm/src/exact/client/permit2.ts`; on-chain proxy `contracts/evm/src/x402ExactPermit2Proxy.sol`). The signed struct is `PermitWitnessTransferFrom`, domain scoped to the **Permit2 contract**, with:

```
Witness { to, validAfter }            // exact
Witness { to, facilitator, validAfter }   // upto
```

The witness binds the **receiver and a time window — not the resource, URL, or challenge.** That is the *same class* of fields EIP-3009 already binds. The on-chain proxy enforces receiver-binding at settlement (a facilitator cannot redirect funds), but does nothing to let the user verify **before signing** that `to`/`amount`/`deadline` match the challenge they were shown — which is the guard's job.

**Permit2 is not the default.** The default is `eip3009`; only tokens lacking EIP-3009 opt into Permit2. All mainstream USDC deployments use EIP-3009.

> A separately-authored ecosystem analysis characterized the Permit2 path as binding the "receiver/resource" on-chain. From source, that is **half-true and misleading**: it binds the *receiver* (which EIP-3009 also does), not the *resource*. Our pre-sign binding checks remain necessary on the Permit2 path. We note this as an example of why claims about the protocol should be checked against source.

## 5. The `upto` scheme — the server picks the charge

`upto` (v2-only; used for metered / AI-inference billing) signs a **maximum** (`permitted.amount`). The **resource server sets the actual settled amount (0 → max) at settlement time**, based on consumption; on-chain, the only constraints are `amount ≤ max` and `msg.sender == witness.facilitator`. The client sees only the maximum *before* signing; the actual charge is returned in the settlement response *after* the money has moved.

Consequence for a guard: an `upto` payment can only be bounded at its **maximum exposure** — the guard cannot constrain the server-chosen actual charge below the signed max. A guard must therefore treat `upto` as "authorizes up to `permitted.amount`" and disclose that to the user. (v1 declines `upto`; v2 handles it under this rule.)

## 6. The facilitator

Endpoints: `POST /verify`, `POST /settle`, `GET /supported`. The facilitator never sees or needs the client's private key — it relays the client-signed authorization. It therefore **cannot steal the payer's funds** (the signature fixes `to`/`value`/`nonce`/window); it can only **censor**, lie on `/verify` (harming the resource server), or lie/double-report on `/settle`.

> **Honesty flag:** this "cannot steal, only censor" conclusion is *derived* from the scheme mechanics and the "not a custodian" documentation line. The v2 spec's security-considerations section contains no dedicated facilitator-trust-boundary prose — this is a gap in the spec, and our conclusion should be read as a derivation, not a quotation.

## 7. Where a client-side guard intervenes, before signing

- **v2, sanctioned:** `x402Client.onBeforePaymentCreation(hook)` — receives the selected requirements (resource URL, amount, asset, network, `payTo`) and can abort *before* the authorization is built and signed. No forking. Sees the requirement but not yet the struct.
- **Both generations:** wrap the signer (`ClientEvmSigner = { address, signTypedData }`; a viem `LocalAccount` satisfies it) and refuse to sign. Transport-agnostic. Sees the struct (`{from,to,value,validAfter,validBefore,nonce}`) but not the resource URL.
- **Legacy chokepoint:** every EVM `exact` payment funnels through a single `signAuthorization` → `signTypedData` call; interposing there guarantees nothing signs without the guard's assent.

The tension between the first two points (requirement-without-struct vs struct-without-URL) is the correlation problem noted as ASM3 in the threat model.

## 8. Default posture of the ecosystem: auto-pay

The v1 reference client signs anything at or under a hardcoded `maxValue` of **0.10 USDC** with **no confirmation hook**. v2 removed even that cap in favor of "write a policy" — and ships no policy. Out of the box, any 402 an agent touches, it pays. This is the gap a spend guard fills.

## 9. Research relied upon

Two x402 security preprints (arXiv **2605.11781**, **2605.30998**), with related work, demonstrate replay-to-many-grants (a live endpoint produced 248 HTTP grants from one settlement), settlement front-running, reorg revert-grant, proxy/CDN cache leakage, cross-resource substitution, and allowance overdraft.

> These are **arXiv preprints, not peer-reviewed publications.** The arXiv IDs should be spot-checked before being relied upon in any downstream citation. As shown in [THREAT_MODEL.md §5a](../THREAT_MODEL.md#5a-which-documented-x402-attacks-are-in-scope), most of these attacks are server-, facilitator-, or chain-layer issues outside the scope of a client-side spend guard; we cite them to draw that boundary honestly, not to claim we address them.

---

*Corrections welcome at the contact above. This is a working reference, not a specification.*
