import { Hex32 } from "@lemma/core";
import type { Context, Hono } from "hono";

import type { LemmaStore } from "../persistence.js";
import type { ReputationConfig } from "./config.js";
import { evidenceTarget } from "./evidence.js";
import { REGISTRATION_PATH, WELL_KNOWN_REGISTRATION_PATH, registrationFile } from "./registration.js";

export interface ReputationRouteDeps {
  readonly config: ReputationConfig;
  /** Whether the paid tools are registered, for the registration file's `x402Support`. */
  readonly paidTools: boolean;
  /** The served dashboard icon's path, for the registration file's `image`. */
  readonly imagePath?: string | undefined;
  readonly store: Pick<LemmaStore, "getReputationPost">;
}

/**
 * - `GET /api/v1/agent/registration.json` and `GET /.well-known/agent-registration.json`:
 *   the ERC-8004 registration file, when `PUBLIC_BASE_URL` is set (404 otherwise).
 * - `GET /api/v1/evidence/:resolutionId/:target` (`provider` or `buyer-agent`):
 *   the ERC-8004 feedback file behind that feedback, byte for byte as hashed
 *   (`feedbackHash = keccak256(body)`), so it is immutable and cached forever.
 *   It is served once the attester has claimed a send of that feedback, from
 *   when the feedback may be on chain and its URI must answer, and not before:
 *   a buyer agent's file names the agent, and the attester checks that the
 *   payer controls it just before the first send, so the file of an agent that
 *   fails the check is never shown.
 */
export function registerReputationRoutes(app: Hono, deps: ReputationRouteDeps): void {
  const registration = (c: Context) => {
    const file = registrationFile(deps.config, { paidTools: deps.paidTools, imagePath: deps.imagePath });
    if (file === undefined) {
      c.header("Cache-Control", "no-store");
      return c.json({ error: "no agent registration: PUBLIC_BASE_URL is not set" }, 404);
    }
    c.header("Cache-Control", "public, max-age=300");
    return c.json(file);
  };
  app.get(REGISTRATION_PATH, registration);
  app.get(WELL_KNOWN_REGISTRATION_PATH, registration);

  app.get("/api/v1/evidence/:resolutionId/:target", async (c) => {
    const id = Hex32.safeParse(c.req.param("resolutionId"));
    const target = evidenceTarget(c.req.param("target"));
    if (!id.success || target === undefined) return c.json({ error: "expected a resolution id and a target, provider or buyer-agent" }, 400);
    const post = await deps.store.getReputationPost(id.data, target);
    if (post === undefined || post.attempts === 0) {
      // It may exist later, once the outcome is final and its feedback is being sent: never cache the miss.
      c.header("Cache-Control", "no-store");
      return c.json({ error: "no feedback file for this resolution and target" }, 404);
    }
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    c.header("Content-Type", "application/json; charset=utf-8");
    return c.body(post.evidence);
  });
}
