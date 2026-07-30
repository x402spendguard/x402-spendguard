// A MOCK FacilitatorEvmSigner — the chain-faking half of an honest x402 sandbox facilitator.
//
// THE HONESTY INVARIANT (why this is not the xpaysh/x402-local "rubber-stamp" trap):
// We do NOT write our own facilitator. We inject this signer into the REAL @x402/evm
// `ExactEvmScheme` (via the real `x402Facilitator`), so every DETERMINISTIC security check runs
// in the production library, unmodified:
//   - EIP-712 digest hashing + ECDSA signer recovery  (recoverAddress, in-library)
//   - recipient / value / network / scheme match
//   - validAfter / validBefore time-window checks
// A mock signer STRUCTURALLY CANNOT make a bad signature pass: `verifyEIP3009` computes the digest
// and recovers the signer itself — it never asks us. All we get to answer are CHAIN-STATE calls,
// which is exactly the half a chain legitimately owns. So a developer who tests against this and
// sees green has NOT been told a broken signature is fine — the opposite of a rubber-stamp mock.
//
// WHAT WE FAKE (loudly, and only this):
//   getCode           → "deployed" for configured contracts (the asset), EOA ("0x") otherwise
//   readContract      → the transferWithAuthorization SIMULATION succeeds; balance/nonce answers
//   writeContract     → a well-formed SYNTHETIC tx hash (no chain, no gas, no settlement)
//   waitForReceipt    → success (or "reverted" when a fault is injected)
//
// FAULT INJECTION knobs let a test drive the chain-state failures a mock must be able to model:
//   insufficientBalance  → the transfer simulation reverts and balanceOf reports < amount
//   nonceUsed            → authorizationState() reports the nonce already consumed
//   settleReverts        → the settlement receipt comes back non-success
//
// Lives under test/e2e/ (never imported by src/), so the static no-egress proof over src/ is
// untouched — this is opt-in test scaffolding, exactly like x402-local-server.ts.
import { verifyTypedData, type Hex } from "viem";
import type { FacilitatorEvmSigner } from "@x402/evm";

/** A fixed, well-formed facilitator address. Never signs anything real — settlement is faked. */
const MOCK_FACILITATOR_ADDRESS = "0x000000000000000000000000000000000000dEaD" as const;

/** Minimal ERC-20 bytecode marker so `getCode` reports a "deployed" contract (non-"0x"). */
const DEPLOYED_MARKER = "0x60006000" as const;

export interface MockFacilitatorFaults {
  /** The on-chain transfer would revert at verify-time simulation (insufficient balance, a used
   *  nonce, etc.). At THIS fidelity the facilitator surfaces the generic simulation-failure reason;
   *  decomposing it into insufficient_balance vs nonce_already_used needs faithful MULTICALL3
   *  diagnostics — a fidelity rung deferred to the standalone tool, not faked here. */
  transferReverts?: boolean;
  /** The settlement transaction is mined but reverts (receipt status non-success). */
  settleReverts?: boolean;
}

export interface MockFacilitatorOpts {
  /** Contract addresses that `getCode` should report as deployed (case-insensitive) — the asset(s). */
  deployedContracts: readonly string[];
  /** Optional balance (atomic units) balanceOf reports; defaults to a large funded balance. */
  balance?: bigint;
  /** Optional ERC-20 metadata for the failure-diagnosis path (name/version). */
  token?: { name?: string; version?: string };
  faults?: MockFacilitatorFaults;
}

/**
 * Build a `FacilitatorEvmSigner` that fakes ONLY chain state. Inject it into the real
 * `ExactEvmScheme` so the production verify/settle logic runs against faked reads — real crypto,
 * faked chain. The returned signer is stateless except for a monotonic tx-hash counter so repeated
 * settlements get distinct, well-formed synthetic hashes (no Math.random — deterministic).
 */
export function makeMockFacilitatorSigner(opts: MockFacilitatorOpts): FacilitatorEvmSigner {
  const deployed = new Set(opts.deployedContracts.map((a) => a.toLowerCase()));
  const balance = opts.balance ?? 1_000_000_000_000n; // 1e12 atomic units — amply funded
  const faults = opts.faults ?? {};
  let txCounter = 0;

  const syntheticTxHash = (): Hex =>
    `0x${(++txCounter).toString(16).padStart(64, "0")}` as Hex;

  return {
    getAddresses: () => [MOCK_FACILITATOR_ADDRESS],

    async getCode({ address }): Promise<Hex | undefined> {
      return deployed.has(address.toLowerCase()) ? DEPLOYED_MARKER : "0x";
    },

    // Honest even though the exact scheme never calls it: verifyEIP3009 recovers the signer itself.
    // We delegate to viem's real verifier rather than stub `true`, so this can't lie either.
    async verifyTypedData(args): Promise<boolean> {
      try {
        return await verifyTypedData(args as never);
      } catch {
        return false;
      }
    },

    async readContract({ functionName }): Promise<unknown> {
      switch (functionName) {
        case "transferWithAuthorization":
          // The verify-time simulation. Success == "would transfer". A throw models a chain-state
          // revert; the real facilitator then runs a MULTICALL3 diagnosis we don't model yet, so it
          // falls back to the generic simulation-failure reason (see MockFacilitatorFaults).
          if (faults.transferReverts) throw new Error("transfer would revert (mock chain-state fault)");
          return undefined;
        // balanceOf / authorizationState are correct benign answers, reachable only once the
        // MULTICALL3 diagnostic path is modeled (the fidelity rung above); harmless until then.
        case "balanceOf":
          return balance;
        case "authorizationState":
          return false; // nonce unused
        case "name":
          return opts.token?.name ?? "";
        case "version":
          return opts.token?.version ?? "";
        default:
          // Anything else (e.g. an unexpected read) throws loudly rather than fabricating an answer.
          throw new Error(`mock facilitator signer: unhandled readContract "${functionName}"`);
      }
    },

    async writeContract(): Promise<Hex> {
      return syntheticTxHash();
    },

    async sendTransaction(): Promise<Hex> {
      return syntheticTxHash();
    },

    async waitForTransactionReceipt({ hash }): Promise<{ status: string; logs?: readonly never[] }> {
      return { status: faults.settleReverts ? "reverted" : "success", logs: [] };
    },
  };
}
