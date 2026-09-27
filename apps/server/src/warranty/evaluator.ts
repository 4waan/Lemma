import { type Address, type AdoptionReceipt, type Hex32, MAX_OUTCOME_WEIGHT_BPS, WarrantyOutcome, type WarrantyVerdict, adoptionReceiptDigest } from "@lemma/core";

import { describeError } from "../errors.js";
import type { RegistryEventRow, WarrantyAction } from "../persistence.js";
import { type ActionJobDeps, type ActionReport, type ActionRules, ActionSender, type Decision, RELEASE_ROLES_MISMATCH, type RunContext,
  type SettledDecision, StaleReadError, emptyReport, releaseProblem, runContext } from "./actions.js";
import { ACTIONS_INTERVAL_MS, SIGN_MARGIN_SECONDS } from "./activator.js";
import type { RegistryResolution, RegistryRevert, WarrantyChain } from "./chain.js";
import { runEvery } from "./loop.js";

/** An outcome is signed to be submitted within this many seconds of the chain's clock, and never after the claim deadline. */
export const OUTCOME_WINDOW_SECONDS = 3600;
/** The wash-adoption damper: a buyer's weighted outcomes per release digest and profile index over this window... */
export const DAMPER_WINDOW_MS = 30 * 86_400_000;
/** ...count at most this many; the next ones finalize with weight 0. */
export const DAMPER_LIMIT = 3;

/** `EVALUATOR_FAILURES`: `review` (an operator decides each failed outcome) or `auto` (a failed receipt finalizes as FAILED). */
export type EvaluatorFailures = "review" | "auto";

/** Why an action closed without a finalization of its own. */
export const WARRANTY_ENDED = "WARRANTY_ENDED";
export const CLAIM_WINDOW_CLOSED = "CLAIM_WINDOW_CLOSED";

export interface EvaluatorDeps extends ActionJobDeps {
  readonly failures: EvaluatorFailures;
}

export interface EvaluatorReport extends ActionReport {
  /** Finalizations written to the outbox this run (queued or waiting for review). */
  readonly queued: number;
  /** Of those, the ones waiting for an operator. */
  readonly review: number;
  /** Actions in review closed because their warranty ended first. */
  readonly closed: number;
}

/** The verdict a verified receipt's outcome stands for: passed PASSED, abandoned VOID, failed FAILED (after review, unless automatic). */
export function verdictForReceipt(outcome: AdoptionReceipt["outcome"]): WarrantyVerdict {
  return outcome === "passed" ? "passed" : outcome === "abandoned" ? "void" : "failed";
}

/**
 * Finalizes each active warranty whose buyer sent a verified receipt, as the
 * evaluator. It never finalizes on an unverified or missing receipt: such a
 * warranty runs to its expiry.
 *
 * For each active warranty (indexed activation, no indexed finalization or
 * expiry) with a verified receipt and no finalization yet, it writes a
 * `finalize` action:
 *
 * - verdict: the receipt's `passed` is PASSED and `abandoned` VOID; `failed`
 *   is FAILED with `EVALUATOR_FAILURES=auto`, and otherwise waits in `review`
 *   until an operator decides FAILED or VOID (`decideReview`).
 * - weight: 10000, or 0 when this buyer (the resolution's payer, which only
 *   the server knows) already has `DAMPER_LIMIT` outcomes with a weight for
 *   the same release digest and profile index, finalized or in flight, in the
 *   last 30 days (the wash-adoption damper). VOID always weighs 0: the
 *   registry never records it.
 * - `evidenceHash`: core `adoptionReceiptDigest` of the receipt. (The
 *   ERC-8004 evidence file names the finalization time, so it cannot be
 *   hashed before finalization.)
 *
 * Then it attempts the due finalizations (`ActionSender`'s discipline): the
 * warranty must still be active on chain and its claim window open (else
 * the action is `done` when it was finalized, and `abandoned` otherwise),
 * the release must name this evaluator, and the evaluator signs the outcome
 * with `validUntil` = min(the chain's clock + 3600 s, `claimDeadlineOf`),
 * again when that comes near, and sends it. Actions still in review when
 * their warranty ended are closed.
 */
export class WarrantyEvaluator {
  private readonly sender: ActionSender;

  constructor(private readonly deps: EvaluatorDeps) {
    this.sender = new ActionSender(deps, finalizationRules(deps.chain, deps.logger));
  }

  async runOnce(): Promise<EvaluatorReport> {
    const { queued, review } = await this.discover();
    const closed = await this.closeEndedReviews();
    const report = emptyReport();
    const ctx = await runContext(this.deps, "finalize");
    if (ctx !== undefined) await this.sender.sendDue(ctx, report);
    return { queued, review, closed, ...report };
  }

  private async discover(): Promise<{ queued: number; review: number }> {
    const { store, logger } = this.deps;
    let queued = 0;
    let review = 0;
    try {
      for (const activation of await store.listWarrantiesToEvaluate(this.deps.batch ?? 25)) {
        const id = activation.resolutionId as Hex32;
        const [receipt, row] = await Promise.all([store.getReceipt(id), store.getResolution(id)]);
        // The query asked for a verified receipt; a resolution this server never sold has no payer to weigh.
        if (receipt?.verified !== true || row === undefined) continue;
        const now = this.deps.clock();
        const verdict = verdictForReceipt(receipt.receipt.outcome);
        const damped = verdict !== "void" && (await this.damped(row.payer, activation, now));
        const outcome: WarrantyOutcome = {
          schemaVersion: "1",
          resolutionId: id,
          verdict,
          weightBps: verdict === "void" || damped ? 0 : MAX_OUTCOME_WEIGHT_BPS,
          evidenceHash: adoptionReceiptDigest(receipt.receipt),
          // Set again from the chain's clock and the deadline in force when it is signed.
          validUntil: Math.max(1, Math.min(Math.floor(now.getTime() / 1000) + OUTCOME_WINDOW_SECONDS, Number(activation.claimDeadline ?? 1n))),
        };
        const state = verdict === "failed" && this.deps.failures === "review" ? "review" : "queued";
        if (!(await store.insertWarrantyAction({ resolutionId: id, kind: "finalize", payload: outcome, signature: null, state, nextAttemptAt: now }, now))) continue;
        queued++;
        if (state === "review") review++;
        logger.log("info", "warranty.outcome_queued", { resolutionId: id, verdict, weightBps: outcome.weightBps, review: state === "review", ...(damped ? { code: "DAMPED" } : {}) });
      }
    } catch (error) {
      logger.log("warn", "warranty.outbox_failed", { kind: "finalize", error: describeError(error) });
    }
    return { queued, review };
  }

  /** Whether this payer already has the damper's limit of weighted outcomes on the warranty's release and profile. */
  private async damped(payer: Address, activation: RegistryEventRow, now: Date): Promise<boolean> {
    const counted = await this.deps.store.countDamperOutcomes({
      payer,
      releaseDigest: activation.releaseDigest as Hex32,
      profileIndex: activation.profileIndex ?? 0,
      since: new Date(now.getTime() - DAMPER_WINDOW_MS),
      exclude: activation.resolutionId as Hex32,
    });
    return counted >= DAMPER_LIMIT;
  }

  /** Closes actions still in review whose warranty was finalized or expired meanwhile: nothing can be decided for them. */
  private async closeEndedReviews(): Promise<number> {
    const { store, logger } = this.deps;
    let closed = 0;
    try {
      for (const action of await store.listWarrantyActions({ kind: "finalize", state: "review" }, this.deps.batch ?? 25)) {
        const ended = await store.listRegistryEvents({ resolutionId: action.resolutionId, names: ["OutcomeFinalized", "ResolutionExpired"] }, 1);
        if (ended.length === 0) continue;
        if (await store.updateWarrantyAction(action.resolutionId, "finalize", { attempts: action.attempts, state: "review" }, { state: "abandoned", lastCode: WARRANTY_ENDED }, this.deps.clock())) {
          closed++;
          logger.log("warn", "warranty.abandoned", { kind: "finalize", resolutionId: action.resolutionId, code: WARRANTY_ENDED });
        }
      }
    } catch (error) {
      logger.log("warn", "warranty.outbox_failed", { kind: "finalize", error: describeError(error) });
    }
    return closed;
  }

  /** Runs now and then every `intervalMs`, one run at a time; returns a stop function. */
  start(intervalMs: number = ACTIONS_INTERVAL_MS): () => void {
    return runEvery(intervalMs, () => this.runOnce(), this.deps.logger, "warranty.evaluator_failed");
  }
}

/** How an action ends when the registry says its warranty is no longer active: done when it was finalized, abandoned otherwise. */
function endedBy(resolution: RegistryResolution, code: string): SettledDecision {
  const finalized = resolution.status === "passed" || resolution.status === "failed" || resolution.status === "voided" || resolution.status === "refunded";
  return finalized ? { kind: "finish", state: "done", code: null } : { kind: "finish", state: "abandoned", code };
}

function finalizationRules(chain: WarrantyChain, logger: ActionJobDeps["logger"]): ActionRules {
  return {
    kind: "finalize",
    fn: "finalizeOutcome",

    async prepare(action: WarrantyAction, resolution: RegistryResolution, ctx: RunContext): Promise<Decision> {
      // The indexer confirmed the activation: a node that answers none is behind it.
      if (resolution.status === "none") throw new StaleReadError();
      // Finalized already (by this job's earlier send, or anyone relaying its signature), or expired.
      if (resolution.status !== "active") return endedBy(resolution, resolution.status === "expired" ? "RESOLUTION_EXPIRED" : "RESOLUTION_NOT_ACTIVE");
      const parsed = WarrantyOutcome.safeParse(action.payload);
      if (!parsed.success) return { kind: "finish", state: "abandoned", code: "NO_OUTCOME" };
      const problem = releaseProblem(await ctx.release(resolution.releaseDigest), chain, false);
      if (problem !== undefined) {
        logger.log("warn", "warranty.release_refused", { releaseDigest: resolution.releaseDigest, code: problem });
        return { kind: "finish", state: "skipped", code: problem };
      }
      if (ctx.chainNow > resolution.claimDeadline) return { kind: "finish", state: "abandoned", code: CLAIM_WINDOW_CLOSED };
      const outcome = parsed.data;
      const latest = ctx.chainNow + BigInt(OUTCOME_WINDOW_SECONDS) < resolution.claimDeadline ? ctx.chainNow + BigInt(OUTCOME_WINDOW_SECONDS) : resolution.claimDeadline;
      const valid = BigInt(outcome.validUntil);
      const stale = action.signature === null || valid <= ctx.chainNow + BigInt(SIGN_MARGIN_SECONDS) || valid > resolution.claimDeadline || action.lastCode === "OUTCOME_EXPIRED";
      if (!stale) return { kind: "send", call: { fn: "finalizeOutcome", outcome, signature: action.signature as `0x${string}` } };
      const signed: WarrantyOutcome = { ...outcome, validUntil: Number(latest) };
      const signature = await chain.signOutcome(signed);
      return { kind: "send", call: { fn: "finalizeOutcome", outcome: signed, signature }, payload: signed, signature };
    },

    async onRevert(action: WarrantyAction, revert: RegistryRevert, ctx: RunContext): Promise<SettledDecision> {
      switch (revert.code) {
        case "CLAIM_WINDOW_CLOSED":
        case "RESOLUTION_NOT_ACTIVE":
          return endedBy(await chain.resolution(action.resolutionId), revert.code);
        case "OUTCOME_EXPIRED":
          return { kind: "wait", until: ctx.now, code: revert.code };
        case "INVALID_EVALUATOR_SIGNATURE":
          return { kind: "finish", state: "skipped", code: RELEASE_ROLES_MISMATCH };
        case "INVALID_VERDICT":
        case "INVALID_WEIGHT":
          return { kind: "finish", state: "abandoned", code: revert.code };
        default:
          // A pause (ENFORCED_PAUSE), too little gas for the engine (INSUFFICIENT_GAS_FOR_ENGINE) and anything else: later.
          return { kind: "backoff", code: revert.code };
      }
    },
  };
}
