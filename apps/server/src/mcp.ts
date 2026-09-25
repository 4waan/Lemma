import type { CatalogIndex } from "@lemma/catalog";
import { resolve } from "@lemma/catalog";
import { type Hex32, LEMMA_TOOLS, type Preview, PreviewInput, PreviewResult, RecoverInput, ResolutionDelivery } from "@lemma/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ServerConfig } from "./config.js";
import type { DemandRecorder } from "./demand.js";
import { describeError } from "./errors.js";
import type { Logger } from "./log.js";
import type { ResolutionService } from "./service.js";
import type { PreviewStore, ResolutionReader } from "./store.js";

export interface McpDeps {
  readonly config: ServerConfig;
  readonly index: CatalogIndex;
  readonly previews: PreviewStore;
  readonly resolutions: ResolutionReader;
  readonly demand: DemandRecorder | undefined;
  readonly clock: () => Date;
  readonly newPreviewId: () => Hex32;
  readonly logger: Logger;
  readonly service: ResolutionService | undefined;
  /** The caller's address as the rate limiter keys it (trusted proxy hop), counted salted for demand. */
  readonly source?: string | undefined;
  /**
   * Registers the paid tools (payment work): x402 wrapping of
   * `lemma_buy_resolution` over the ResolutionService. Called only when paid
   * tools are enabled, once per request, with that request's parsed JSON-RPC
   * message, so the registrar can read the preview id it names and build
   * `accepts` from `service.quote(previewId)`.
   */
  readonly registerPaidTools?: PaidToolRegistrar | undefined;
  /** The request's parsed JSON-RPC message, for the paid-tool registrar. */
  readonly request?: unknown;
}

export const SERVER_INFO = { name: "lemma", version: "0.1.0" } as const;

/** The payment work's registrar: the per-request server, the service, and the request it is for. */
export type PaidToolRegistrar = (server: McpServer, service: ResolutionService, request: { readonly message: unknown }) => void | Promise<void>;

const failure = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

/**
 * One MCP server per request (stateless Streamable HTTP; the SDK refuses to
 * reuse a stateless transport). Registration is cheap: two free tools, plus the
 * paid tools when enabled, awaited so an async registrar (one that quotes the
 * named preview first) has registered them before the request is dispatched.
 *
 * Error results carry text only. A declared outputSchema makes MCP clients
 * validate `structuredContent` even on errors, so an error never carries one.
 */
export async function buildMcpServer(deps: McpDeps): Promise<McpServer> {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    LEMMA_TOOLS.preview,
    {
      description: "Free compatibility preview: a typed task and a privacy-safe repository profile against the curated catalog.",
      inputSchema: PreviewInput,
      outputSchema: PreviewResult,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const now = deps.clock();
      const preview = resolve(input, deps.index, {
        now,
        previewId: deps.newPreviewId(),
        payment: deps.config.payment,
        offerTtlSeconds: deps.config.offerTtlSeconds,
      });
      if ("offer" in preview && preview.offer !== null) {
        try {
          await deps.previews.saveOffer(preview);
        } catch (error) {
          deps.logger.log("error", "preview.store_failed", { error: describeError(error), releaseDigest: preview.release.releaseDigest });
          return failure("The preview could not be stored, so its offer cannot be honored. Try again.");
        }
      }
      await deps.demand?.record(preview, input.task.capability, input.profile, now, deps.source ?? "unknown");
      deps.logger.log("info", "preview", { decision: preview.decision, reasons: preview.reasons, offer: "offer" in preview && preview.offer !== null });
      return { content: [{ type: "text", text: summarize(preview) }], structuredContent: { preview } };
    },
  );

  server.registerTool(
    LEMMA_TOOLS.recoverResolution,
    {
      description: "Free recovery of a settled resolution after a lost paid response. Needs the preview id and the buyer that paid.",
      inputSchema: RecoverInput,
      outputSchema: ResolutionDelivery,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ previewId, buyer }) => {
      let found: Awaited<ReturnType<ResolutionReader["recover"]>>;
      try {
        found = await deps.resolutions.recover(previewId, buyer);
      } catch (error) {
        deps.logger.log("error", "recover.failed", { error: describeError(error) });
        return failure("UNAVAILABLE: recovery is temporarily unavailable. Retry later; nothing is lost.");
      }
      if (found === "NOT_FOUND") return failure("NOT_FOUND: no settled resolution for this preview and buyer.");
      if (found === "IN_FLIGHT") return failure("IN_FLIGHT: the payment is not settled yet. Retry after it settles or expires.");
      return { content: [{ type: "text", text: `resolution ${found.resolution.resolutionId}` }], structuredContent: found };
    },
  );

  if (deps.config.paidTools) {
    if (deps.registerPaidTools === undefined || deps.service === undefined) throw new Error("paid tools are enabled but no paid-tool registrar or resolution service was provided");
    await deps.registerPaidTools(server, deps.service, { message: deps.request });
  }
  return server;
}

/** A one-line, enum-and-number summary for humans; clients read `structuredContent`. */
export function summarize(preview: Preview): string {
  const reasons = preview.reasons.length > 0 ? ` (${preview.reasons.join(", ")})` : "";
  if (!("offer" in preview) || preview.offer === null) return `${preview.decision}${reasons}`;
  return `${preview.decision}: offer of ${preview.offer.terms.amount} atomic USDC until ${preview.offer.validUntil}`;
}
