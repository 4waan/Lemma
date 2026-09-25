import type { CatalogIndex } from "@lemma/catalog";
import { resolve } from "@lemma/catalog";
import { type Hex32, LEMMA_TOOLS, type Preview, PreviewInput, PreviewResult, RecoverInput, ResolutionDelivery } from "@lemma/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ServerConfig } from "./config.js";
import type { Logger } from "./log.js";
import type { PreviewStore, ResolutionReader } from "./store.js";

export interface McpDeps {
  readonly config: ServerConfig;
  readonly index: CatalogIndex;
  readonly previews: PreviewStore;
  readonly resolutions: ResolutionReader;
  readonly clock: () => Date;
  readonly newPreviewId: () => Hex32;
  readonly logger: Logger;
  /**
   * Registers the paid tools (protocol lane): x402 wrapping of
   * `lemma_buy_resolution` over the ResolutionService. Called only when paid
   * tools are enabled.
   */
  readonly registerPaidTools?: ((server: McpServer) => void) | undefined;
}

export const SERVER_INFO = { name: "lemma", version: "0.1.0" } as const;

const failure = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

/**
 * One MCP server per request (stateless Streamable HTTP; the SDK refuses to
 * reuse a stateless transport). Registration is cheap: two free tools, plus the
 * paid tools when enabled.
 *
 * Error results carry text only. A declared outputSchema makes MCP clients
 * validate `structuredContent` even on errors, so an error never carries one.
 */
export function buildMcpServer(deps: McpDeps): McpServer {
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
      const preview = resolve(input, deps.index, {
        now: deps.clock(),
        previewId: deps.newPreviewId(),
        payment: deps.config.payment,
        offerTtlSeconds: deps.config.offerTtlSeconds,
      });
      if ("offer" in preview && preview.offer !== null) {
        try {
          await deps.previews.saveOffer(preview);
        } catch (error) {
          deps.logger.log("error", "preview.store_failed", { error: String(error), releaseDigest: preview.release.releaseDigest });
          return failure("The preview could not be stored, so its offer cannot be honored. Try again.");
        }
      }
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
      const found = await deps.resolutions.recover(previewId, buyer);
      if (found === "NOT_FOUND") return failure("NOT_FOUND: no settled resolution for this preview and buyer.");
      if (found === "IN_FLIGHT") return failure("IN_FLIGHT: the payment is not settled yet. Retry after it settles or expires.");
      return { content: [{ type: "text", text: `resolution ${found.resolution.resolutionId}` }], structuredContent: found };
    },
  );

  if (deps.config.paidTools) {
    if (deps.registerPaidTools === undefined) throw new Error("paid tools are enabled but no paid-tool registrar was provided");
    deps.registerPaidTools(server);
  }
  return server;
}

/** A one-line, enum-and-number summary for humans; clients read `structuredContent`. */
export function summarize(preview: Preview): string {
  const reasons = preview.reasons.length > 0 ? ` (${preview.reasons.join(", ")})` : "";
  if (!("offer" in preview) || preview.offer === null) return `${preview.decision}${reasons}`;
  return `${preview.decision}: offer of ${preview.offer.terms.amount} atomic USDC until ${preview.offer.validUntil}`;
}
