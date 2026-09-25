import { z } from "zod";

import { PatchBundle, bundleDigest } from "./bundle.js";
import { Preview } from "./preview.js";
import { Address, Hex32 } from "./primitives.js";
import { RepositoryProfile } from "./profile.js";
import { Resolution } from "./receipt.js";
import { TaskRequest } from "./task.js";

/**
 * MCP tool names shared by the server, the bridge and the dashboard.
 * `recoverResolution` is a free server tool the bridge calls on its own after a
 * lost paid response; it is never offered to the agent.
 */
export const LEMMA_TOOLS = {
  preview: "lemma_preview",
  buyResolution: "lemma_buy_resolution",
  applyResolution: "lemma_apply_resolution",
  verifyAdoption: "lemma_verify_adoption",
  recoverResolution: "lemma_recover_resolution",
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

/**
 * Bridge → server input of `lemma_recover_resolution`. The preview id is the
 * bearer secret: the server returns it only to the bridge that asked for the
 * preview and never publishes it. The server derives the resolution id from
 * both fields, so a published resolution id alone recovers nothing.
 */
export const RecoverInput = z.strictObject({
  previewId: Hex32,
  buyer: Address,
});

export type RecoverInput = z.infer<typeof RecoverInput>;

/**
 * A delivered resolution with its patch bundle. The recover tool returns it as
 * `structuredContent`. The paid tool returns the same object as JSON text,
 * because x402's MCP client passes on only `content`, `isError` and the
 * payment response. The bundle must be the one the resolution names.
 */
export const ResolutionDelivery = z
  .strictObject({
    resolution: Resolution,
    bundle: PatchBundle,
  })
  .refine((d) => !PatchBundle.safeParse(d.bundle).success || digestMatches(d.bundle, d.resolution.payloadDigest), {
    path: ["bundle"],
    message: "bundle digest must equal resolution.payloadDigest",
  });

export type ResolutionDelivery = z.infer<typeof ResolutionDelivery>;

function digestMatches(bundle: PatchBundle, payloadDigest: unknown): boolean {
  try {
    return bundleDigest(bundle) === payloadDigest;
  } catch {
    return false;
  }
}
