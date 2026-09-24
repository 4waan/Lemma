import { z } from "zod";

import { digest } from "./canonical.js";
import { type Hex32, SchemaVersion } from "./primitives.js";

/** The integration tasks the MVP catalog can resolve, one per planned release family. */
export const CAPABILITY_IDS = [
  "mcp-client.add-paying-client",
  "mcp-server.add-payment-gating",
  "node-service.add-payment-facilitator",
] as const;

export const CapabilityId = z.enum(CAPABILITY_IDS);

export type CapabilityId = z.infer<typeof CapabilityId>;

/**
 * What the agent asks Lemma to resolve. It is a typed capability id with no
 * free-text prompt, so model prose never reaches matching or pricing.
 */
export const TaskRequest = z.strictObject({
  schemaVersion: SchemaVersion,
  capability: CapabilityId,
});

export type TaskRequest = z.infer<typeof TaskRequest>;

export function taskDigest(task: TaskRequest): Hex32 {
  return digest("task-request", TaskRequest.parse(task));
}
