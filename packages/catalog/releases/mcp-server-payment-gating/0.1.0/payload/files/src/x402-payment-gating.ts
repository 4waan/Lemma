/**
 * x402 payment gating for MCP tools: each call of a paid tool costs a fixed
 * amount of USDC on Arbitrum Sepolia (testnet), paid with the x402 `exact`
 * scheme (an EIP-3009 transferWithAuthorization the caller signs) and
 * verified and settled by an x402 facilitator. It follows the x402 MCP
 * transport, version 2 (x402-foundation/x402, specs/transports-v2/mcp.md), through
 * the reference implementation in @x402/mcp:
 *
 * - An unpaid call gets an error result carrying the x402 PaymentRequired
 *   (in `structuredContent`, and as JSON in the first text item). The tool
 *   does not run.
 * - A paid call carries its payment in `_meta["x402/payment"]`. The tool runs
 *   only after the facilitator verifies the payment, and the payment settles
 *   only after the tool succeeds. The result then carries the settlement in
 *   `_meta["x402/payment-response"]`.
 * - A tool that fails (an `isError` result or a throw) is not charged. A
 *   settlement that fails answers the payment error instead of the tool's
 *   result, so nothing is delivered unpaid.
 *
 * Wiring, once per server:
 *
 *   const gating = await createPaymentGating({ payTo: process.env.X402_PAY_TO, facilitatorUrl: process.env.X402_FACILITATOR_URL });
 *   server.registerTool("get_report", { description, inputSchema }, gating.paid("get_report", "0.01", async (args) => ({ content: [...] })));
 *
 * `createPaymentGating` refuses a missing or malformed address or URL, and a
 * facilitator that does not settle `exact` payments on Arbitrum Sepolia, so a
 * misconfigured server stops at startup instead of serving paid tools for free.
 * Free tools are registered as before, without `paid`.
 *
 * From the Lemma release mcp-server-payment-gating@0.1.0; @x402/* is Apache-2.0.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { Network, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { type PaymentWrappedHandler, createPaymentWrapper, x402ResourceServer } from "@x402/mcp";

/** Arbitrum Sepolia, as x402 names networks (CAIP-2). */
export const ARBITRUM_SEPOLIA: Network = "eip155:421614";

/** Circle's USDC on Arbitrum Sepolia, and the EIP-712 domain its authorizations are signed under. */
export const ARBITRUM_SEPOLIA_USDC = {
  address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  decimals: 6,
  eip712: { name: "USD Coin", version: "2" },
} as const;

/** How long a payment authorization must stay valid, when not set: the x402 default. */
export const DEFAULT_MAX_TIMEOUT_SECONDS = 300;

/** How long one facilitator request may take, when not set. */
export const DEFAULT_FACILITATOR_TIMEOUT_MS = 30_000;

export interface PaymentGatingOptions {
  /** The address every payment goes to (0x and 40 hex digits). */
  readonly payTo: string | undefined;
  /** The x402 facilitator's base URL: https, or http on the loopback interface (a local facilitator). */
  readonly facilitatorUrl: string | undefined;
  /** How long a payment authorization must stay valid, in seconds (1 to 3600). */
  readonly maxTimeoutSeconds?: number;
  /** How long one verify, settle or supported request may take, in milliseconds. */
  readonly facilitatorTimeoutMs?: number;
}

export interface PaymentGating {
  /** Where payments go, as the requirements name it. */
  readonly payTo: string;
  /**
   * The handler of tool `toolName`, charging `priceUsdc` per call: a decimal
   * USDC amount with at most 6 decimals, such as "0.01". The handler gets the
   * tool's arguments and the request's `extra` as before, and runs only for a
   * verified payment. Pass the result to `registerTool` in place of the handler.
   */
  paid<Args, Extra>(
    toolName: string,
    priceUsdc: string,
    handler: (args: Args, extra: Extra) => CallToolResult | Promise<CallToolResult>,
  ): (args: Args, extra: Extra) => Promise<CallToolResult>;
}

class PaymentGatingError extends Error {
  override name = "PaymentGatingError";
}

/**
 * Connects to the facilitator and checks that it settles `exact` USDC
 * payments on Arbitrum Sepolia, then returns `paid`, which wraps tool
 * handlers. Rejects on a missing or malformed setting, an unreachable
 * facilitator, or one that does not support the network.
 */
export async function createPaymentGating(options: PaymentGatingOptions): Promise<PaymentGating> {
  const payTo = checkAddress(options.payTo);
  const url = checkFacilitatorUrl(options.facilitatorUrl);
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
  if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds < 1 || maxTimeoutSeconds > 3600) {
    throw new PaymentGatingError(`maxTimeoutSeconds must be a whole number of seconds from 1 to 3600, got ${maxTimeoutSeconds}`);
  }
  const facilitator = new HTTPFacilitatorClient({ url, timeoutMs: options.facilitatorTimeoutMs ?? DEFAULT_FACILITATOR_TIMEOUT_MS });
  const resourceServer = new x402ResourceServer(facilitator).register(ARBITRUM_SEPOLIA, new ExactEvmScheme());
  let template: PaymentRequirements;
  try {
    await resourceServer.initialize();
    // One build through x402 checks the facilitator's support and gives the requirements' exact shape.
    [template] = (await resourceServer.buildPaymentRequirements({
      scheme: "exact",
      network: ARBITRUM_SEPOLIA,
      payTo,
      price: { amount: "1", asset: ARBITRUM_SEPOLIA_USDC.address, extra: { ...ARBITRUM_SEPOLIA_USDC.eip712 } },
      maxTimeoutSeconds,
    })) as [PaymentRequirements];
  } catch (error) {
    throw new PaymentGatingError(`the facilitator at ${url} is unreachable or does not settle exact USDC payments on ${ARBITRUM_SEPOLIA}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    payTo,
    paid<Args, Extra>(toolName: string, priceUsdc: string, handler: (args: Args, extra: Extra) => CallToolResult | Promise<CallToolResult>) {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(toolName)) throw new PaymentGatingError(`not a tool name: ${JSON.stringify(toolName)}`);
      const amount = usdcToAtomic(priceUsdc);
      const wrap = createPaymentWrapper(resourceServer, {
        accepts: [{ ...template, amount, extra: { ...template.extra } }],
        // The resource names the tool, so the payment request says what is being paid for.
        resource: { url: `mcp://tool/${toolName}`, description: `Tool: ${toolName}`, mimeType: "application/json" },
      });
      // x402 calls the handler with its own context, so each call's `extra` is closed over here.
      return async (args: Args, extra: Extra) => (await wrap(((a: Args) => handler(a, extra)) as unknown as PaymentWrappedHandler<Record<string, unknown>>)(args as Record<string, unknown>, extra)) as CallToolResult;
    },
  };
}

/** An amount of USDC ("0.01") in atomic units ("10000"), by string arithmetic: never through a float. */
export function usdcToAtomic(usdc: string): string {
  const match = /^(0|[1-9][0-9]{0,11})(?:\.([0-9]{1,6}))?$/.exec(usdc);
  if (match === null) throw new PaymentGatingError(`a price is a decimal USDC amount with at most ${ARBITRUM_SEPOLIA_USDC.decimals} decimals, such as "0.01"; got ${JSON.stringify(usdc)}`);
  const atomic = BigInt(match[1] ?? "0") * 10n ** 6n + BigInt((match[2] ?? "").padEnd(6, "0"));
  if (atomic === 0n) throw new PaymentGatingError("a paid tool's price must be more than 0");
  return atomic.toString();
}

function checkAddress(value: string | undefined): string {
  if (value === undefined || !/^0x[0-9a-fA-F]{40}$/.test(value.trim())) {
    throw new PaymentGatingError(`payTo must be an address (0x and 40 hex digits), got ${value === undefined ? "nothing" : JSON.stringify(value)}`);
  }
  if (/^0x0{40}$/.test(value.trim())) throw new PaymentGatingError("payTo must not be the zero address, where payments would be lost");
  return value.trim();
}

function checkFacilitatorUrl(value: string | undefined): string {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new PaymentGatingError(`facilitatorUrl must be a URL, got ${value === undefined ? "nothing" : JSON.stringify(value)}`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new PaymentGatingError("facilitatorUrl must use https (plain http only on this machine's loopback interface)");
  }
  if (url.username !== "" || url.password !== "") throw new PaymentGatingError("facilitatorUrl must not carry credentials");
  return url.toString().replace(/\/+$/, "");
}
