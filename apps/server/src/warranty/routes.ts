import type { Hono } from "hono";

import type { Logger } from "../log.js";
import type { LemmaStore } from "../persistence.js";
import { requestWithdrawal } from "./relay.js";

export const WITHDRAWALS_PATH = "/api/v1/warranty/withdrawals";

export interface WarrantyRouteDeps {
  /** Whether the warranty pipeline runs: without it, the route answers `WARRANTY_OFF`. */
  readonly enabled: boolean;
  readonly store: Pick<LemmaStore, "getResolution" | "getWarrantyAction" | "insertWarrantyAction" | "listRegistryEvents">;
  readonly clock: () => Date;
  readonly logger: Logger;
}

/**
 * `POST /api/v1/warranty/withdrawals`, body core `WarrantyWithdrawalRequest`
 * (`{ resolutionId, claimSecret, to }`): relays a failed warranty's credit
 * to the refund address the buyer committed to (`requestWithdrawal`). 202
 * with core `WarrantyWithdrawalAnswer` (`{ resolutionId, state }`: queued,
 * sent, done or abandoned; the same request answers the same state), or a
 * 4xx with core `WarrantyWithdrawalRefusal` (`{ error: <code> }`). Browser
 * requests (an Origin header) are refused: only the buyer's bridge posts it.
 * It is rate limited with the rest of `/api/v1`, and never cached.
 */
export function registerWarrantyRoutes(app: Hono, deps: WarrantyRouteDeps): void {
  app.post(WITHDRAWALS_PATH, async (c) => {
    c.header("Cache-Control", "no-store");
    if (c.req.header("origin") !== undefined) return c.json({ error: "BROWSER_REQUEST" }, 403);
    if (!deps.enabled) return c.json({ error: "WARRANTY_OFF" }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "BAD_REQUEST" }, 400);
    }
    // A store failure reaches onError (500, logged by name and code only): the bridge asks again.
    const result = await requestWithdrawal(deps, body);
    return c.json(result.body, result.status);
  });
}
