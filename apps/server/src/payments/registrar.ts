import { BuyInput, type Hex32, LEMMA_TOOLS, type PaymentTerms, paymentRequirementsFor, toolResourceUrl } from "@lemma/core";
import type { Network, PaymentRequirements } from "@x402/core/types";
import { type x402ResourceServer, createPaymentWrapper } from "@x402/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { describeError } from "../errors.js";
import type { PaidToolRegistrar } from "../mcp.js";
import type { QuoteResult, ResolutionService } from "../service.js";
import { type BuyHandlerDeps, type BuyRefusal, buyHandler, refusal, settlementHook } from "./handler.js";

export const BUY_TOOL_DESCRIPTION =
  "Paid: buy the Compatibility Resolution a lemma_preview offer quoted. Pays the quoted x402 terms (exact EIP-3009, USDC on Arbitrum Sepolia) in _meta x402/payment, with nonce derivePaymentNonce(resolutionId, previewId). Answers the ResolutionDelivery as JSON text.";

/** x402's own `PaymentRequirements` type for core's requirements (the same fields; x402 types the network as a template literal). */
export function x402Requirements(terms: PaymentTerms): PaymentRequirements {
  const r = paymentRequirementsFor(terms);
  return { ...r, network: r.network as Network, extra: { ...r.extra } };
}

/**
 * The paid tool, per request (the MCP server is stateless, one server per
 * request). The registrar reads the request's JSON-RPC message:
 *
 * - a `tools/call` of `lemma_buy_resolution` with a parseable `BuyInput` whose
 *   preview has an open quote gets the tool wrapped by x402's
 *   `createPaymentWrapper`, with `accepts` built from that quote's stored terms
 *   (core `paymentRequirementsFor`, so the bridge's `accepted` is deep-equal);
 * - anything else (`tools/list`, bad input, no offer, an expired quote, a
 *   store failure) gets the same tool name unwrapped, answering an `isError`
 *   code and charging nothing. Bad input is answered by the tool itself, so
 *   its code is `BAD_INPUT` rather than the SDK's validation text.
 *
 * The paid tool declares no outputSchema: x402 returns its payment challenge
 * in `structuredContent`, which a declared schema would make clients reject.
 */
export function paidToolRegistrar(deps: Omit<BuyHandlerDeps, "service"> & { readonly resourceServer: x402ResourceServer }): PaidToolRegistrar {
  return async (server: McpServer, service: ResolutionService, request: { readonly message: unknown }) => {
    const call = buyCallOf(request.message);
    if (call === undefined) return unpaid(server, "NOT_FOUND");
    const input = BuyInput.safeParse(call.arguments);
    if (!input.success) {
      server.registerTool(LEMMA_TOOLS.buyResolution, { description: BUY_TOOL_DESCRIPTION }, async () => refusal("BAD_INPUT"));
      return;
    }
    let quote: QuoteResult;
    try {
      quote = await service.quote(input.data.previewId, deps.clock());
    } catch (error) {
      deps.logger.log("error", "buy.quote_failed", { error: describeError(error) });
      return unpaid(server, "UNAVAILABLE");
    }
    if (!quote.ok) return unpaid(server, quote.reason);
    const quoted: { previewId: Hex32; terms: PaymentTerms } = { previewId: input.data.previewId, terms: quote.terms };
    const paid = createPaymentWrapper(deps.resourceServer, {
      accepts: [x402Requirements(quote.terms)],
      resource: { url: toolResourceUrl(LEMMA_TOOLS.buyResolution), description: "Lemma Compatibility Resolution", mimeType: "application/json" },
      hooks: { onAfterSettlement: settlementHook({ ...deps, service }, input.data.previewId) },
    });
    server.registerTool(
      LEMMA_TOOLS.buyResolution,
      { description: BUY_TOOL_DESCRIPTION, inputSchema: BuyInput, annotations: { idempotentHint: true, openWorldHint: false } },
      paid(buyHandler({ ...deps, service }, quoted)) as Parameters<McpServer["registerTool"]>[2],
    );
  };
}

/** The same tool, answering a refusal code: listed in `tools/list`, free when called. */
function unpaid(server: McpServer, code: BuyRefusal): void {
  server.registerTool(
    LEMMA_TOOLS.buyResolution,
    { description: BUY_TOOL_DESCRIPTION, inputSchema: BuyInput, annotations: { idempotentHint: true, openWorldHint: false } },
    async () => refusal(code),
  );
}

/** The arguments of a `tools/call` of the paid tool, or undefined for any other message. */
function buyCallOf(message: unknown): { arguments: unknown } | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const m = message as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
  if (m.method !== "tools/call" || m.params?.name !== LEMMA_TOOLS.buyResolution) return undefined;
  return { arguments: m.params.arguments };
}
