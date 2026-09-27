import { VERDICT_FAILED, type WarrantyWithdrawalAnswer, type WarrantyWithdrawalRefusal, WarrantyWithdrawal, WarrantyWithdrawalRequest, warrantyClaimHash } from "@lemma/core";

import type { Logger } from "../log.js";
import type { LemmaStore, WarrantyAction, WarrantyPayload } from "../persistence.js";
import { type ActionJobDeps, type ActionReport, type ActionRules, ActionSender, type Decision, type RunContext,
  type SettledDecision, emptyReport, refPayload, runContext } from "./actions.js";
import { ACTIONS_INTERVAL_MS } from "./activator.js";
import type { RegistryResolution, RegistryRevert, WarrantyChain } from "./chain.js";
import { runEvery } from "./loop.js";

export const NO_CREDIT = "NO_CREDIT";

/**
 * Relays buyers' credit withdrawals (`withdrawCredit`), as the evaluator,
 * which pays the gas: the buyer's agent holds no ETH. The route
 * (`requestWithdrawal`) queues one `withdraw` action per resolution; this
 * job sends it once due. The claim secret is the only authorization, and it
 * can only pay the refund address it was committed with, so relaying it is
 * safe; it is never logged, and the action keeps it (and the refund address)
 * only until it is closed, then only the resolution id. A credit already
 * withdrawn (by anyone) closes the action `done`; no credit at all closes it
 * `abandoned`. It works while the registry is paused, as the registry does.
 */
export class CreditRelay {
  private readonly sender: ActionSender;

  constructor(private readonly deps: ActionJobDeps) {
    this.sender = new ActionSender(deps, withdrawalRules(deps.chain));
  }

  async runOnce(): Promise<ActionReport> {
    const report = emptyReport();
    const ctx = await runContext(this.deps, "withdraw");
    if (ctx !== undefined) await this.sender.sendDue(ctx, report);
    return report;
  }

  /** Runs now and then every `intervalMs`, one run at a time; returns a stop function. */
  start(intervalMs: number = ACTIONS_INTERVAL_MS): () => void {
    return runEvery(intervalMs, () => this.runOnce(), this.deps.logger, "warranty.relay_failed");
  }
}

function endedBy(resolution: RegistryResolution): SettledDecision {
  return resolution.status === "refunded" ? { kind: "finish", state: "done", code: null } : { kind: "finish", state: "abandoned", code: NO_CREDIT };
}

function withdrawalRules(chain: WarrantyChain): ActionRules {
  return {
    kind: "withdraw",
    fn: "withdrawCredit",

    async prepare(action: WarrantyAction, resolution: RegistryResolution): Promise<Decision> {
      // Withdrawn already (by this job, or the buyer's own relay), or no credit to withdraw.
      if (resolution.status !== "failed") return endedBy(resolution);
      const claim = WarrantyWithdrawal.safeParse(action.payload);
      if (!claim.success) return { kind: "finish", state: "abandoned", code: "NO_CLAIM" };
      return { kind: "send", call: { fn: "withdrawCredit", resolutionId: claim.data.resolutionId, claimSecret: claim.data.claimSecret, to: claim.data.to } };
    },

    async onRevert(action: WarrantyAction, revert: RegistryRevert, _ctx: RunContext): Promise<SettledDecision> {
      switch (revert.code) {
        case "NO_CREDIT":
          return endedBy(await chain.resolution(action.resolutionId));
        case "INVALID_CLAIM":
        case "INVALID_RECIPIENT":
          return { kind: "finish", state: "abandoned", code: revert.code };
        default:
          return { kind: "backoff", code: revert.code };
      }
    },

    closedPayload(action: WarrantyAction): WarrantyPayload {
      return refPayload(action.resolutionId);
    },
  };
}

/** The route's answer: 202 with the relay's state, or a 4xx refusal code (core `WarrantyWithdrawalRefusal`). */
export type WithdrawalResult =
  | { readonly status: 202; readonly body: WarrantyWithdrawalAnswer }
  | { readonly status: 400 | 403 | 404 | 409; readonly body: WarrantyWithdrawalRefusal };

/** The relay's state as the route answers it. */
export function withdrawalState(action: WarrantyAction): WarrantyWithdrawalAnswer["state"] {
  switch (action.state) {
    case "sent":
      return "sent";
    case "done":
      return "done";
    case "skipped":
    case "abandoned":
      return "abandoned";
    default:
      return "queued";
  }
}

/**
 * Checks a withdrawal request and queues its relay: the body must be a strict
 * `WarrantyWithdrawalRequest`, `warrantyClaimHash(resolutionId, claimSecret,
 * to)` must equal the claim hash stored with the resolution, and the indexed
 * registry events must show the warranty finalized FAILED with its credit not
 * withdrawn. Then it queues one `withdraw` action and answers its state. The
 * same request answers the same action's state (queued, sent, done or
 * abandoned) from then on, whatever the chain says since. Anything else is a
 * refusal that queues nothing. Nothing about the claim is logged.
 */
export async function requestWithdrawal(
  deps: { readonly store: Pick<LemmaStore, "getResolution" | "getWarrantyAction" | "insertWarrantyAction" | "listRegistryEvents">; readonly clock: () => Date; readonly logger: Logger },
  body: unknown,
): Promise<WithdrawalResult> {
  const parsed = WarrantyWithdrawalRequest.safeParse(body);
  if (!parsed.success) return { status: 400, body: { error: "BAD_REQUEST" } };
  const { resolutionId, claimSecret, to } = parsed.data;
  const row = await deps.store.getResolution(resolutionId);
  if (row === undefined || row.claimHash === null) return { status: 404, body: { error: "UNKNOWN_RESOLUTION" } };
  // Neither the secret nor the address is told apart: either one wrong is the same refusal.
  if (warrantyClaimHash(resolutionId, claimSecret, to) !== row.claimHash) return { status: 403, body: { error: "CLAIM_MISMATCH" } };
  const existing = await deps.store.getWarrantyAction(resolutionId, "withdraw");
  if (existing !== undefined) return { status: 202, body: { resolutionId, state: withdrawalState(existing) } };
  const events = await deps.store.listRegistryEvents({ resolutionId, names: ["OutcomeFinalized", "CreditWithdrawn"] }, 10);
  const failed = events.some((e) => e.name === "OutcomeFinalized" && e.verdict === VERDICT_FAILED);
  const withdrawn = events.some((e) => e.name === "CreditWithdrawn");
  if (!failed || withdrawn) return { status: 409, body: { error: "NO_CREDIT" } };
  const now = deps.clock();
  if (await deps.store.insertWarrantyAction({ resolutionId, kind: "withdraw", payload: { schemaVersion: "1", resolutionId, claimSecret, to }, signature: null, state: "queued", nextAttemptAt: now }, now)) {
    deps.logger.log("info", "warranty.withdrawal_queued", { resolutionId });
  }
  // Whoever queued it first, the action there now answers.
  const action = await deps.store.getWarrantyAction(resolutionId, "withdraw");
  return { status: 202, body: { resolutionId, state: action === undefined ? "queued" : withdrawalState(action) } };
}
