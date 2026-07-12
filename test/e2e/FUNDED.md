# Funded settle test — runbook

The **funded settle test** ([`funded-settle.e2e.test.ts`](./funded-settle.e2e.test.ts)) is the one
test that moves **real value**. It proves the happy path end to end: a policy‑**compliant** payment
passes the guard, a real funded viem `LocalAccount` signs it through our allowlist wrap, and a real
facilitator **verifies and settles it on‑chain** (real USDC moves on **Base Sepolia**).

Everything else in the repo is hermetic. This test **self‑skips** unless you give it a funded
testnet key, so `npm test`, `npm run test:e2e`, and CI never move funds.

> **Testnet only.** Use a brand‑new **throwaway** key that has only ever held faucet tokens. Never
> put a mainnet key — or any key with real value — in `.env`. Amounts here are ~**0.01 USDC**.

---

## What you need

- This repo, with dev deps installed: `npm ci`
- A **throwaway** Base Sepolia private key
- A little **faucet USDC** on that key — **no ETH needed**. x402 uses EIP‑3009, which is *relayed*:
  the facilitator submits the on‑chain transfer and **sponsors the gas**. Your wallet only needs USDC.

Base Sepolia facts (verified against `@x402/evm`): chain `eip155:84532`, USDC
`0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 decimals), default facilitator
`https://x402.org/facilitator`.

---

## Step 1 — Generate a throwaway key

From the repo root (uses the already‑installed `viem`):

```bash
node -e "import('viem/accounts').then(({generatePrivateKey,privateKeyToAccount})=>{const k=generatePrivateKey();console.log('PRIVATE_KEY:',k);console.log('ADDRESS    :',privateKeyToAccount(k).address)})"
```

Copy both lines somewhere temporary. The `ADDRESS` is what you fund; the `PRIVATE_KEY` goes in
`.env` in the next step.

## Step 2 — Fund it with faucet USDC (no ETH)

1. Go to **https://faucet.circle.com**
2. Select network **Base Sepolia**
3. Paste your `ADDRESS`
4. Request USDC (Circle gives 20 USDC per address every 2 hours — far more than the ~0.01 you need)

Confirm it arrived (optional): search the address on
`https://sepolia.basescan.org` and check its USDC balance. You do **not** need any ETH.

## Step 3 — Configure `.env`

Copy the template and fill in the key:

```bash
cp test/e2e/.env.example test/e2e/.env
```

Edit `test/e2e/.env` and set **at minimum**:

```dotenv
TESTNET_PRIVATE_KEY=0x<the PRIVATE_KEY from step 1>
```

Optional overrides (sensible defaults if left blank):

| Var | Default | Meaning |
|-----|---------|---------|
| `X402_PAY_TO` | a freshly generated throwaway address | recipient of the payment |
| `X402_AMOUNT` | `10000` (= 0.01 USDC) | amount in **atomic** USDC units (6 decimals) |
| `X402_FACILITATOR_URL` | `https://x402.org/facilitator` | facilitator that verifies + settles |

`test/e2e/.env` is **gitignored** — it never enters the repo. (You can also skip the file and pass
the key inline: `TESTNET_PRIVATE_KEY=0x... npm run test:e2e:funded`.)

## Step 4 — Run it

```bash
npm run test:e2e:funded
```

### Success looks like

```
[funded] payer=0x…  → payTo=0x…  amount=10000 (atomic USDC)
[funded] SETTLED 10000 atomic USDC → 0x…  tx=0x<64-hex>
 ✓ FUNDED settle … › compliant payment: guard allows → real account signs → facilitator verifies + settles on-chain
 Test Files  1 passed (1)
```

Paste the `tx=0x…` hash into `https://sepolia.basescan.org` to see the on‑chain USDC transfer.

---

## What the test actually does

1. Builds a guard whose policy **allows** exactly this payment (payTo on the allowlist, caps sized
   to admit the amount) — the same `SpendGuard` the library ships.
2. Wires the real `@x402` client with our `createSpendGuardBinding` and your **real** funded account,
   wrapped by the allowlist signer (`guardedSigner`).
3. Drives a genuine 402 → the guard runs at the signer wrap, **allows**, and the real account
   produces a genuine EIP‑3009 signature. It asserts the guard **recorded the spend** (write‑ahead).
4. Calls the facilitator’s `verify` (asserts `isValid`) then `settle` (asserts `success` + an
   on‑chain `transaction` hash). The facilitator sponsors gas and submits `transferWithAuthorization`.

So it proves the guard doesn’t just *block* bad payments (the deny‑path suite) but that an
**allowed** payment is genuinely settleable — the guard produces a valid, on‑chain‑acceptable
payment. It also exercises the real allowlist‑wrapped signer against a live facilitator.

## Troubleshooting

- **Test skipped, not run.** `TESTNET_PRIVATE_KEY` isn’t set. Check `test/e2e/.env` exists and has
  the key, or pass it inline.
- **`invalid private key`.** The key must be `0x` + 64 hex chars. Regenerate with Step 1.
- **`verify failed` / `settle failed`.** Usually insufficient USDC on the payer, or a facilitator
  hiccup. Confirm the balance on BaseScan; re‑run (the faucet refills every 2h). The assertion
  message includes the facilitator’s reason.
- **Nothing moves but it “passes.”** It can’t — `settle` must return `success: true` and a 64‑hex
  `transaction` hash, or the test fails.

## Hygiene

- The key is **throwaway** and testnet‑only; after the run you can discard it.
- `test/e2e/.env` is gitignored (`.env*` is blocked except `.env.example`); a real key never lands
  in git — verified: `git add test/e2e/.env` is refused.
- The payment is tiny (default 0.01 USDC) and one‑shot; nothing recurs.
