import { z } from "zod";

import { Preview } from "./preview.js";
import { RepositoryProfile } from "./profile.js";
import { TaskRequest } from "./task.js";

/** MCP tool names shared by the server, the bridge and the dashboard. */
export const LEMMA_TOOLS = {
  preview: "lemma_preview",
  buyResolution: "lemma_buy_resolution",
  applyResolution: "lemma_apply_resolution",
  verifyAdoption: "lemma_verify_adoption",
} as const;

export type LemmaToolName = (typeof LEMMA_TOOLS)[keyof typeof LEMMA_TOOLS];

/**
 * Resource URL for a paid tool. @x402/mcp derives the tool name from it and
 * falls back to "paid_tool" when it is missing, so the server always passes it.
 */
export function toolResourceUrl(name: LemmaToolName): string {
  return `mcp://tool/${name}`;
}

/**
 * Bridge → server input of `lemma_preview`. Strict at the top level, so the MCP
 * SDK publishes `additionalProperties: false` and rejects extra keys instead of
 * silently dropping them.
 */
export const PreviewInput = z.strictObject({
  task: TaskRequest,
  profile: RepositoryProfile,
});

export type PreviewInput = z.infer<typeof PreviewInput>;

/**
 * Output envelope of `lemma_preview`. MCP requires an object at the root of an
 * outputSchema; a bare discriminated union is silently left out of tools/list.
 * Paid tools must not declare an outputSchema at all, because x402 returns its
 * payment challenge in structuredContent and the client would reject it.
 */
export const PreviewResult = z.strictObject({
  preview: Preview,
});

export type PreviewResult = z.infer<typeof PreviewResult>;
