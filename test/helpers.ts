// Shared test builders. Not a *.test.ts file, so the traceability meta-test does
// not scan it for test names, and the static test does not scan it (src/ only).
import type {
  Address,
  Amount,
  Authorization,
  Caps,
  Challenge,
  ChainId,
  Domain,
  OpaqueHex,
  PaymentEvaluation,
  Policy,
  SpendState,
  UnixSeconds,
} from "../src/types.js";
import { assetKey } from "../src/parse.js";

export const CHAIN = "eip155:8453" as ChainId; // Base
export const USDC = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
export const PAYEE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
export const ATTACKER = "0x9999999999999999999999999999999999999999" as Address;
export const ORIGIN = "weather.example" as Domain;
export const NOW = 1_000_000n as UnixSeconds;

export const A = (n: bigint) => n as Amount;
export const T = (n: bigint) => n as UnixSeconds;
export const key = assetKey({ chain: CHAIN, token: USDC });

export const caps = (c: Partial<Caps> = {}): Record<string, Caps> => ({
  [key]: { perRequest: A(1_000_000n), perDomain: A(5_000_000n), global: A(20_000_000n), ...c },
});

export const policy = (over: Partial<Policy> = {}): Policy => ({
  halt: false,
  allowlist: [{ address: PAYEE, chain: CHAIN }],
  caps: caps(),
  clockSkewSeconds: T(60n),
  windowSeconds: T(86_400n),
  requireOriginMatch: false,
  ...over,
});

/** Fresh state for PURE-engine tests. The engine ignores windowStart/lastSeen. */
export const freshState = (): SpendState => ({
  spentByDomain: {},
  spentByAsset: {},
  windowStart: T(0n),
  lastSeen: T(0n),
});

/** Build a spend state with given totals (window fields defaulted — engine ignores them). */
export const state = (over: Partial<SpendState> = {}): SpendState => ({ ...freshState(), ...over });

export const challenge = (over: Partial<Challenge> = {}): Challenge => ({
  scheme: "exact",
  network: CHAIN,
  asset: USDC,
  payTo: PAYEE,
  amount: A(500_000n),
  maxTimeoutSeconds: T(600n),
  resource: "https://weather.example/forecast",
  ...over,
});

export const authorization = (over: Partial<Authorization> = {}): Authorization => ({
  form: "eip3009-evm",
  chainId: CHAIN,
  verifyingContract: USDC,
  from: "0xcccccccccccccccccccccccccccccccccccccccc" as Address,
  to: PAYEE,
  value: A(500_000n),
  validAfter: T(0n),
  validBefore: T(NOW + 300n),
  nonce: "0xdeadbeef" as OpaqueHex,
  ...over,
});

export const ev = (c: Partial<Challenge> = {}, a: Partial<Authorization> = {}): PaymentEvaluation => ({
  origin: ORIGIN,
  challenge: challenge(c),
  authorization: authorization(a),
});
