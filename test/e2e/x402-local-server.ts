// A local HTTP endpoint that answers with a GENUINE x402 402 challenge, encoded exactly the
// way a real @x402 resource server does — v2 puts the PaymentRequired in a base64
// `PAYMENT-REQUIRED` header (via the SDK's own `encodePaymentRequiredHeader`), v1 puts it in
// the JSON body with `x402Version: 1`. The wire is byte-identical to what a production server
// emits, so the real @x402 CLIENT parses it exactly as it would in the wild. We build the 402
// ourselves (rather than run the server's price/decimals/facilitator machinery) because the
// thing under test is the client + our guard binding; the server is only a genuine 402 source.
//
// This file lives under test/e2e/ (never imported by src/), so the static no-egress proof over
// src/ is untouched — this HTTP is test scaffolding, opt-in behind `npm run test:e2e`.
import { createServer, type Server } from "node:http";
import { encodePaymentRequiredHeader, decodePaymentRequiredHeader } from "@x402/core/http";
import { validatePaymentRequired } from "@x402/core/schemas";
import type { PaymentRequired } from "@x402/core/types";

export interface LocalServer {
  /** The resource URL a client hits; every request answers 402 with the given challenge. */
  url: string;
  close(): Promise<void>;
}

/**
 * Serve `paymentRequired` as a real 402 over localhost. The encoding follows the generation:
 * `x402Version === 2` → base64 `PAYMENT-REQUIRED` header; otherwise (v1) → JSON body. Returns
 * the bound URL and a close handle; binds to an ephemeral port so tests never collide.
 */
export async function startX402Server(paymentRequired: PaymentRequired): Promise<LocalServer> {
  const isV2 = (paymentRequired as { x402Version?: number }).x402Version === 2;
  // SELF-CERTIFY THE WIRE. We hand-build the 402 rather than run the server's price/decimals
  // machinery, so we must prove it is genuine wire and not a lenient shape the client merely
  // tolerates. `validatePaymentRequired` is the SDK's OWN schema check (throws on any deviation)
  // — and for v2 we validate the EXACT bytes the client parses, by round-tripping through the
  // real encode+decode. If this throws, the harness is testing a fiction; fail loudly at setup.
  const wireForm: unknown = isV2
    ? decodePaymentRequiredHeader(encodePaymentRequiredHeader(paymentRequired))
    : paymentRequired;
  validatePaymentRequired(wireForm);

  const server: Server = createServer((_req, res) => {
    res.statusCode = 402;
    res.setHeader("content-type", "application/json");
    // Close the socket after each response (no HTTP/1.1 keep-alive). `server.close()` waits on
    // all open connections; an idle keep-alive socket would make it hang toward the test timeout.
    // Forcing a per-response close keeps teardown prompt and deterministic across Node/undici.
    res.setHeader("Connection", "close");
    if (isV2) {
      // v2: the PaymentRequired rides a header; the body is just a human-readable hint.
      res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
      res.end(JSON.stringify({ error: "payment required" }));
    } else {
      // v1: the PaymentRequired IS the body (the client reads `x402Version === 1` there).
      res.end(JSON.stringify(paymentRequired));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/resource`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
