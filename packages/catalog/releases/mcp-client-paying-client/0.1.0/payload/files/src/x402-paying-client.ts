/**
 * An x402-paying MCP client with spending limits: it pays for MCP tools that
 * charge with x402 (protocol version 2, MCP transport) in USDC on Arbitrum
 * Sepolia (testnet), with the `exact` scheme (an EIP-3009
 * transferWithAuthorization it signs), and never spends past its limits.
 * It follows x402-foundation/x402 specs/transports-v2/mcp.md, and signs
 * through the reference client in @x402/core and @x402/evm.
 *
 * - A tool answers an unpaid call with an error result carrying the x402
 *   PaymentRequired. The client picks the `exact` USDC requirement on
 *   Arbitrum Sepolia from what the tool accepts, and pays nothing when there
 *   is none, whatever else is offered.
 * - It refuses, without signing anything, a price above `maxPerCall` or one
 *   the rest of the budget cannot cover. The budget is reserved before
 *   signing, so calls made at the same time cannot overspend it together.
 * - It pays at most once per call: the call is retried once with the payment
 *   in `_meta["x402/payment"]`, and a tool that asks again, or a settlement
 *   that fails, ends the call with a PaymentFailedError instead of a second
 *   payment.
 * - Only a settled payment (`_meta["x402/payment-response"]` with success)
 *   counts as spent. A tool that fails after the payment verified is not
 *   settled, so its reservation goes back to the budget.
 *
 * Wiring, once per process (one budget for every server it pays):
 *
 *   const payments = createPayingClient({ privateKey: process.env.X402_PRIVATE_KEY, maxPerCall: "0.10", budget: "1.00" });
 *   const result = await payments.callTool(mcpClient, "get_report", { id: 7 });
 *   // result.payment: { tool, amount, transaction, network, payer } when the call was paid
 *   payments.spending(); // { budget, spent, remaining, payments }
 *
 * Amounts are USDC decimal strings ("0.05") in options and atomic integer
 * strings (6 decimals, "50000") in results, never floating point.
 *
 * From the Lemma release mcp-client-paying-client@0.1.0; @x402/* is Apache-2.0.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { x402Client } from "@x402/core/client";
import type { Network, PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { MCP_PAYMENT_META_KEY, extractPaymentRequiredFromError, extractPaymentResponseFromMeta } from "@x402/mcp";
import { privateKeyToAccount } from "viem/accounts";

/** Arbitrum Sepolia, as x402 names networks (CAIP-2). */
export const ARBITRUM_SEPOLIA: Network = "eip155:421614";

/** Circle's USDC on Arbitrum Sepolia: the only asset this client pays in. */
export const ARBITRUM_SEPOLIA_USDC = { address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", decimals: 6 } as const;

export interface PayingClientOptions {
  /** The payer's private key: 0x and 64 hex digits. */
  readonly privateKey: string | undefined;
  /** The most one call may cost, in USDC ("0.10"). */
  readonly maxPerCall: string | undefined;
  /** The most all calls together may cost, in USDC ("1.00"). */
  readonly budget: string | undefined;
}

/** One settled payment. Amounts are atomic USDC (6 decimals) as integer strings. */
export interface Payment {
  readonly tool: string;
  readonly amount: string;
  readonly transaction: string;
  readonly network: string;
  readonly payer: string;
}

export interface Spending {
  readonly budget: string;
  readonly spent: string;
  readonly remaining: string;
  readonly payments: readonly Payment[];
}

/** A tool's result, with the payment when the call was paid and settled. */
export type PaidCallResult = CallToolResult & { readonly payment?: Payment };

export type RefusalReason = "no_acceptable_requirement" | "over_max_per_call" | "over_budget";

/** Nothing was signed: the tool's price or terms are outside the limits. */
export class PaymentRefusedError extends Error {
  constructor(
    readonly reason: RefusalReason,
    readonly tool: string,
    message: string,
  ) {
    super(message);
    this.name = "PaymentRefusedError";
  }
}

/** A payment was signed and sent, and the tool did not deliver a settled result for it. Nothing counts as spent. */
export class PaymentFailedError extends Error {
  constructor(
    readonly tool: string,
    message: string,
    readonly settlement: SettleResponse | null,
  ) {
    super(message);
    this.name = "PaymentFailedError";
  }
}

export interface PayingClient {
  /** The payer's address. */
  readonly address: string;
  /**
   * Calls `name` on `client`, paying for it when it charges. Throws a
   * PaymentRefusedError (nothing signed) or a PaymentFailedError (signed,
   * not settled); a tool's own error comes back as its `isError` result.
   */
  callTool(client: Client, name: string, args?: Record<string, unknown>, options?: { readonly timeout?: number; readonly signal?: AbortSignal }): Promise<PaidCallResult>;
  spending(): Spending;
}

/** `amount` in USDC ("0.05") as atomic units, or undefined when it is not a plain decimal with at most 6 places. */
export function parseUsdc(amount: string | undefined): bigint | undefined {
  if (amount === undefined) return undefined;
  const match = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (match === null) return undefined;
  return BigInt(match[1] ?? "0") * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}

/** Atomic USDC as a decimal string ("20000" is "0.02"). */
export function formatUsdc(atomic: bigint | string): string {
  const value = BigInt(atomic);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

/** A paying client. Refuses a missing or malformed key, and a limit that is not a positive USDC amount. */
export function createPayingClient(options: PayingClientOptions): PayingClient {
  const key = options.privateKey?.trim();
  if (key === undefined || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("the payer's private key must be 0x and 64 hex digits");
  const maxPerCall = positiveUsdc(options.maxPerCall, "the per-call limit");
  const budget = positiveUsdc(options.budget, "the budget");

  const account = privateKeyToAccount(key as `0x${string}`);
  // This client applies its own limits, so the library's default spend controls are off.
  const signer = new x402Client().register(ARBITRUM_SEPOLIA, new ExactEvmScheme(account)).setSpendControls(false);
  const payments: Payment[] = [];
  let spent = 0n;
  let reserved = 0n;

  const refuse = (reason: RefusalReason, tool: string, message: string): never => {
    throw new PaymentRefusedError(reason, tool, message);
  };

  async function callTool(client: Client, name: string, args: Record<string, unknown> = {}, requestOptions: { readonly timeout?: number; readonly signal?: AbortSignal } = {}): Promise<PaidCallResult> {
    let first: CallToolResult;
    let required: PaymentRequired | null;
    try {
      first = (await client.callTool({ name, arguments: args }, undefined, requestOptions)) as CallToolResult;
      required = paymentRequiredOf(first);
    } catch (error) {
      required = extractPaymentRequiredFromError(error);
      if (required === null) throw error;
      first = { isError: true, content: [] };
    }
    if (required === null) return first;

    const accepted = required.accepts.find(isArbitrumSepoliaUsdc);
    if (accepted === undefined) return refuse("no_acceptable_requirement", name, `${name} does not accept an exact USDC payment on Arbitrum Sepolia`);
    const amount = atomic(accepted.amount);
    if (amount === undefined) return refuse("no_acceptable_requirement", name, `${name} asks for a malformed amount`);
    if (amount > maxPerCall) return refuse("over_max_per_call", name, `${name} costs ${formatUsdc(amount)} USDC, above the ${formatUsdc(maxPerCall)} USDC per-call limit`);
    // Reserved before anything is awaited, so concurrent calls see each other's reservations.
    if (spent + reserved + amount > budget) return refuse("over_budget", name, `${name} costs ${formatUsdc(amount)} USDC and ${formatUsdc(budget - spent - reserved)} USDC of the budget is left`);
    reserved += amount;
    try {
      const payload: PaymentPayload = await signer.createPaymentPayload({ ...required, accepts: [accepted] });
      const paid = (await client.callTool({ name, arguments: args, _meta: { [MCP_PAYMENT_META_KEY]: payload } }, undefined, requestOptions)) as CallToolResult;
      const settlement = extractPaymentResponseFromMeta(paid);
      if (paymentRequiredOf(paid) !== null) {
        throw new PaymentFailedError(name, settlement?.errorReason ? `${name}: the payment did not settle (${settlement.errorReason})` : `${name} asked for payment again after being paid; not paying twice`, settlement);
      }
      if (paid.isError === true) return paid;
      if (settlement === null || settlement.success !== true) throw new PaymentFailedError(name, `${name} returned a result without a successful settlement`, settlement);
      const payment: Payment = { tool: name, amount: amount.toString(), transaction: settlement.transaction, network: settlement.network, payer: settlement.payer ?? account.address };
      spent += amount;
      payments.push(payment);
      return { ...paid, payment };
    } finally {
      // A settled call has moved its amount to `spent`; any other gives its reservation back.
      reserved -= amount;
    }
  }

  return {
    address: account.address,
    callTool,
    spending: () => ({ budget: budget.toString(), spent: spent.toString(), remaining: (budget - spent).toString(), payments: [...payments] }),
  };
}

function positiveUsdc(amount: string | undefined, what: string): bigint {
  const value = parseUsdc(amount);
  if (value === undefined || value <= 0n) throw new Error(`${what} must be a positive USDC amount with at most 6 decimals, not ${JSON.stringify(amount ?? null)}`);
  return value;
}

function isArbitrumSepoliaUsdc(requirement: PaymentRequirements): boolean {
  return requirement.scheme === "exact" && requirement.network === ARBITRUM_SEPOLIA && typeof requirement.asset === "string" && requirement.asset.toLowerCase() === ARBITRUM_SEPOLIA_USDC.address.toLowerCase();
}

function atomic(amount: unknown): bigint | undefined {
  return typeof amount === "string" && /^\d{1,30}$/.test(amount) ? BigInt(amount) : undefined;
}

/** The x402 PaymentRequired an error result carries (in structuredContent, or as JSON in its first text item), or null. */
function paymentRequiredOf(result: CallToolResult): PaymentRequired | null {
  if (result.isError !== true) return null;
  const candidates: unknown[] = [result.structuredContent];
  const first = result.content?.[0];
  if (first?.type === "text") {
    try {
      candidates.push(JSON.parse(first.text));
    } catch {
      // Not JSON: an ordinary tool error.
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate === "object" && candidate !== null && (candidate as { x402Version?: unknown }).x402Version === 2 && Array.isArray((candidate as { accepts?: unknown }).accepts)) {
      return candidate as PaymentRequired;
    }
  }
  return null;
}
