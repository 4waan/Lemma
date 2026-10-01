import type { Hex32 } from "@lemma/core";

import { describeError } from "../errors.js";
import type { WarrantyAction } from "../persistence.js";
import { type ActionJobDeps, type ActionReport, type ActionRules, ActionSender, type Decision, type RunContext,
  type SettledDecision, StaleReadError, emptyReport, refPayload, runContext } from "./actions.js";
import { ACTIONS_INTERVAL_MS } from "./activator.js";
import type { RegistryResolution, RegistryRevert, WarrantyChain } from "./chain.js";
import { runEvery } from "./loop.js";

/** How long an expiry waits for a finalization of the same warranty that is queued or out. */
export const FINALIZATION_WAIT_MS = 5 * 60_000;
/** Once a claim window closes, the expiry waits this much more of the chain's time. */
export const EXPIRY_MARGIN_SECONDS = 60n;

export const FINALIZATION_PENDING = "FINALIZATION_PENDING";
export const CLAIM_WINDOW_OPEN = "CLAIM_WINDOW_OPEN";

export interface ExpirerReport extends ActionReport {
  /** Expiries written to the outbox this run. */
  readonly queued: number;
}

/**
 * Expires each active warranty whose claim window closed without an
 * outcome, as the provider (it gets its bond back).
 *
 * Each run writes an `expire` action for every active warranty (indexed
 * activation, no indexed finalization or expiry) whose deadline set at
 * activation is behind the chain's clock and that has no finalization queued
 * or sent. Before sending, the registry's `claimDeadlineOf` decides: a pause
 * moves the deadline later, and the action then waits for the new one. An
 * expiry also waits while a finalization of the same warranty is queued or
 * out. A warranty no longer active is `done` when it expired (by anyone) and
 * `skipped` when it was finalized meanwhile.
 */
export class WarrantyExpirer {
  private readonly sender: ActionSender;

  constructor(private readonly deps: ActionJobDeps) {
    this.sender = new ActionSender(deps, expiryRules(deps));
  }

  async runOnce(): Promise<ExpirerReport> {
    const report = emptyReport();
    const ctx = await runContext(this.deps, "expire");
    if (ctx === undefined) return { queued: 0, ...report };
    const queued = await this.discover(ctx);
    await this.sender.sendDue(ctx, report);
    return { queued, ...report };
  }

  private async discover(ctx: RunContext): Promise<number> {
    const { store, logger } = this.deps;
    let queued = 0;
    try {
      for (const activation of await store.listWarrantiesToExpire(ctx.chainNow, this.deps.batch ?? 25)) {
        const id = activation.resolutionId as Hex32;
        if (await store.insertWarrantyAction({ resolutionId: id, kind: "expire", payload: refPayload(id), signature: null, state: "queued", nextAttemptAt: ctx.now }, ctx.now)) queued++;
      }
    } catch (error) {
      logger.log("warn", "warranty.outbox_failed", { kind: "expire", error: describeError(error) });
    }
    return queued;
  }

  /** Runs now and then every `intervalMs`, one run at a time; returns a stop function. */
  start(intervalMs: number = ACTIONS_INTERVAL_MS): () => void {
    return runEvery(intervalMs, () => this.runOnce(), this.deps.logger, "warranty.expirer_failed");
  }
}

/** When to look again at a warranty whose window closes at `deadline` (chain seconds): just after, on the server's clock. */
function afterDeadline(ctx: RunContext, deadline: bigint): Date {
  const seconds = deadline + EXPIRY_MARGIN_SECONDS - ctx.chainNow;
  return new Date(ctx.now.getTime() + Number(seconds > 0n ? seconds : 0n) * 1000);
}

function endedBy(resolution: RegistryResolution): SettledDecision {
  return resolution.status === "expired" ? { kind: "finish", state: "done", code: null } : { kind: "finish", state: "skipped", code: "RESOLUTION_NOT_ACTIVE" };
}

function expiryRules(deps: ActionJobDeps & { readonly chain: WarrantyChain }): ActionRules {
  return {
    kind: "expire",
    fn: "expireResolution",

    async prepare(action: WarrantyAction, resolution: RegistryResolution, ctx: RunContext): Promise<Decision> {
      // The indexer confirmed the activation: a node that answers none is behind it.
      if (resolution.status === "none") throw new StaleReadError();
      if (resolution.status !== "active") return endedBy(resolution);
      const finalization = await deps.store.getWarrantyAction(action.resolutionId, "finalize");
      if (finalization?.state === "queued" || finalization?.state === "sent") return { kind: "wait", until: new Date(ctx.now.getTime() + FINALIZATION_WAIT_MS), code: FINALIZATION_PENDING };
      // The deadline in force: every second paused since activation moved it later.
      if (ctx.chainNow <= resolution.claimDeadline) return { kind: "wait", until: afterDeadline(ctx, resolution.claimDeadline), code: CLAIM_WINDOW_OPEN };
      return { kind: "send", call: { fn: "expireResolution", resolutionId: action.resolutionId } };
    },

    async onRevert(action: WarrantyAction, revert: RegistryRevert, ctx: RunContext): Promise<SettledDecision> {
      switch (revert.code) {
        case "CLAIM_WINDOW_OPEN": {
          const deadline = typeof revert.args[0] === "bigint" ? revert.args[0] : ctx.chainNow;
          return { kind: "wait", until: afterDeadline(ctx, deadline), code: CLAIM_WINDOW_OPEN };
        }
        case "RESOLUTION_NOT_ACTIVE":
          return endedBy(await deps.chain.resolution(action.resolutionId));
        default:
          // A pause (ENFORCED_PAUSE) and anything else: later.
          return { kind: "backoff", code: revert.code };
      }
    },
  };
}
