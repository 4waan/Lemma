import { type Address, BuyInput, type Hex32, type PaymentTerms, derivePaymentNonce, deriveResolutionId, toAddress } from "@lemma/core";
import type { MCPToolContext, SettlementContext } from "@x402/mcp";
import { z } from "zod";

import { describeError } from "../errors.js";
import type { Logger } from "../log.js";
import type { PrepareResult, ResolutionService } from "../service.js";

/** The x402 meta key a payment payload travels under (`MCP_PAYMENT_META_KEY` in @x402/mcp). */
export const PAYMENT_META_KEY = "x402/payment";

/**
 * Why `lemma_buy_resolution` charged nothing. Each answer is `isError` text
 * starting with the code, so the buyer's bridge reads the code and nothing
 * else. With x402, an `isError` answer from the handler cancels settlement.
 */
export type BuyRefusal =
  | "NOT_FOUND"
  | "NO_OFFER"
  | "QUOTE_EXPIRED"
  | "BAD_INPUT"
  | "WRONG_NONCE"
  | "UNSUPPORTED_PAYMENT"
  | "UNAVAILABLE"
  | Extract<PrepareResult, { ok: false }>["reason"];

const REFUSAL_TEXT: Record<BuyRefusal, string> = {
  NOT_FOUND: "no open offer has this preview id. Nothing was charged.",
  NO_OFFER: "this preview has no offer. Nothing was charged.",
  QUOTE_EXPIRED: "the offer expired. Ask for a new preview; nothing was charged.",
  BAD_INPUT: "expected { previewId, claimHash }. Nothing was charged.",
  WRONG_NONCE: "the authorization nonce must be derivePaymentNonce(resolutionId, previewId). Nothing was charged.",
  UNSUPPORTED_PAYMENT: "only an exact EIP-3009 authorization for the quoted terms, valid no longer than the quoted window, is accepted (check the buyer's clock). Nothing was charged.",
  UNAVAILABLE: "the purchase could not be recorded. Retry later; nothing was charged.",
  IN_FLIGHT: "a payment for this resolution is still settling. Recover it; nothing more was charged.",
  ALREADY_SETTLED: "this resolution is already paid. Recover it for free; nothing more was charged.",
  PAYMENT_REUSED: "this authorization already backs another resolution. Nothing was charged.",
  PAYLOAD_MISSING: "the release payload is unavailable. Retry later; nothing was charged.",
};

export function refusal(code: BuyRefusal): { isError: true; content: Array<{ type: "text"; text: string }> } {
  return { isError: true, content: [{ type: "text", text: `${code}: ${REFUSAL_TEXT[code]}` }] };
}

/** The EIP-3009 authorization of an exact EVM payment payload, with exactly the fields x402's exact client writes. */
const Authorization = z.strictObject({
  from: z.string(),
  to: z.string(),
  value: z.string().regex(/^(0|[1-9][0-9]{0,77})$/),
  validAfter: z.string().regex(/^[0-9]{1,20}$/),
  validBefore: z.string().regex(/^[0-9]{1,15}$/),
  nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

/**
 * The inner payload (`paymentPayload.payload`) of an exact EIP-3009 payment:
 * its authorization and signature, and nothing else. x402's exact EVM
 * facilitator picks its verify and settle path from the payload's shape alone:
 * a `permit2Authorization` key sends it down the Permit2 path, which verifies
 * and settles only the permit and never looks at `authorization`. So any other
 * shape is refused before verification (`inProcessFacilitator`) and again by
 * the handler: otherwise a valid Permit2 permit from one wallet could carry a
 * forged `authorization` naming another wallet as the payer.
 */
export const ExactEip3009Payload = z.strictObject({ authorization: Authorization, signature: z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/) });

/** Whether a payment payload's inner payload is exactly an EIP-3009 authorization and its signature. */
export function isExactEip3009Payload(inner: unknown): boolean {
  return ExactEip3009Payload.safeParse(inner).success;
}

export interface VerifiedAuthorization {
  readonly payer: Address;
  readonly to: Address;
  readonly value: string;
  /** Lowercase, as the store keeps it. */
  readonly nonce: Hex32;
  readonly validBefore: Date;
}

/**
 * The authorization inside a payment payload: payer, recipient, value, nonce
 * and window. Only ever read from the payload x402 verified, never from tool
 * arguments. Undefined unless the inner payload is exactly an EIP-3009
 * authorization and its signature (`ExactEip3009Payload`): for a Permit2
 * payload, x402 verifies the permit, not an `authorization` beside it.
 */
export function authorizationOf(payload: unknown): VerifiedAuthorization | undefined {
  const parsed = ExactEip3009Payload.safeParse((payload as { payload?: unknown } | undefined)?.payload);
  if (!parsed.success) return undefined;
  const authorization = parsed.data.authorization;
  try {
    return {
      payer: toAddress(authorization.from),
      to: toAddress(authorization.to),
      value: authorization.value,
      nonce: authorization.nonce.toLowerCase(),
      validBefore: new Date(Number(authorization.validBefore) * 1000),
    };
  } catch {
    return undefined;
  }
}

/**
 * How far an authorization's `validBefore` may reach past the quoted window
 * (`now + terms.maxTimeoutSeconds`), for clock skew between the buyer and
 * this server. x402 checks only that the window has not closed; a longer one
 * would keep a failed settlement's row out of the reconciler's reach until it
 * closes, and start its log search after the transfer.
 */
export const WINDOW_SLACK_SECONDS = 60;

export interface BuyHandlerDeps {
  readonly service: ResolutionService;
  readonly clock: () => Date;
  readonly logger: Logger;
}

/**
 * The paid tool's handler, run by x402 after the payment verified and before
 * it settles. The payer, nonce and window come from the verified payload. The
 * nonce must be the one core derives for this resolution, so USDC itself
 * refuses a second payment for it. Any `isError` answer makes x402 cancel the
 * settlement; an ok answer is the `ResolutionDelivery` as JSON text (x402's
 * MCP client passes on only text content), and x402 then settles.
 */
export function buyHandler(deps: BuyHandlerDeps, quoted: { readonly previewId: Hex32; readonly terms: PaymentTerms }) {
  return async (args: Record<string, unknown>, context: MCPToolContext) => {
    const input = BuyInput.safeParse(args);
    if (!input.success || input.data.previewId !== quoted.previewId) return refusal("BAD_INPUT");
    const auth = authorizationOf(context.meta?.[PAYMENT_META_KEY]);
    // x402 verified recipient and value already; a payload that says otherwise is refused, never settled.
    if (auth === undefined || auth.to !== quoted.terms.payTo || auth.value !== quoted.terms.amount) return refusal("UNSUPPORTED_PAYMENT");
    // The window must be the quoted one (plus slack): every prepared row then reaches the reconciler soon after its call.
    if (auth.validBefore.getTime() > deps.clock().getTime() + (quoted.terms.maxTimeoutSeconds + WINDOW_SLACK_SECONDS) * 1000) return refusal("UNSUPPORTED_PAYMENT");
    const { previewId, claimHash } = input.data;
    const resolutionId = deriveResolutionId(previewId, auth.payer);
    if (auth.nonce !== derivePaymentNonce(resolutionId, previewId)) return refusal("WRONG_NONCE");
    let result: PrepareResult;
    try {
      result = await deps.service.prepare(previewId, { payer: auth.payer, nonce: auth.nonce, validBefore: auth.validBefore }, deps.clock(), claimHash);
    } catch (error) {
      deps.logger.log("error", "buy.prepare_failed", { resolutionId, error: describeError(error) });
      return refusal("UNAVAILABLE");
    }
    if (!result.ok) {
      deps.logger.log("info", "buy.refused", { resolutionId, reason: result.reason });
      return refusal(result.reason);
    }
    deps.logger.log("info", "buy.prepared", { resolutionId, releaseDigest: result.resolution.release.releaseDigest });
    return { content: [{ type: "text" as const, text: JSON.stringify({ resolution: result.resolution, bundle: result.bundle }) }] };
  };
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * x402's `onAfterSettlement` hook: records the settlement for the
 * authorization that settled. It never throws, since a throw there would turn
 * a settled payment into a "settlement failed" answer; anything it cannot
 * record is left to the settlement reconciler.
 */
export function settlementHook(deps: BuyHandlerDeps, previewId: Hex32) {
  return async (context: SettlementContext): Promise<void> => {
    try {
      const auth = authorizationOf(context.paymentPayload);
      if (auth === undefined) return;
      const resolutionId = deriveResolutionId(previewId, auth.payer);
      const transaction = context.settlement.transaction;
      if (!TX_HASH.test(transaction)) {
        deps.logger.log("warn", "settle.no_transaction", { resolutionId });
        return;
      }
      await deps.service.commit(resolutionId, { nonce: auth.nonce, settlementRef: transaction.toLowerCase() });
      // Not the transaction: next to the resolution id it would join a wallet to what it bought, even in logs.
      deps.logger.log("info", "settle.committed", { resolutionId });
    } catch (error) {
      deps.logger.log("error", "settle.commit_failed", { error: describeError(error) });
    }
  };
}
