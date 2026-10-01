import { type AdoptionReceipt, Hex32, WarrantyOutcome } from "@lemma/core";

import { schemaIsCurrent } from "../db/migrations.js";
import { type Db, PgStore } from "../db/store.js";
import type { LemmaStore } from "../persistence.js";
import { claimDeadlinesInForce } from "./outcomes.js";

/**
 * One failed outcome waiting for an operator's decision, as the evaluator
 * command lists it: the resolution, its release and profile, what the
 * buyer's receipt said, how long it has waited, and until when it can be
 * decided. Nothing about the buyer.
 */
export interface ReviewItem {
  readonly resolutionId: Hex32;
  /** `releaseId@version`. */
  readonly release: string;
  readonly releaseDigest: Hex32;
  readonly profileIndex: number;
  readonly receiptOutcome: AdoptionReceipt["outcome"] | null;
  readonly exitCode: number | null;
  readonly ageSeconds: number;
  /**
   * The claim deadline in force, from the indexed events (null when the
   * activation is not indexed). Undecided by then, the warranty expires: its
   * bond goes back to the provider, and a FAILED outcome can no longer credit
   * the buyer.
   */
  readonly claimDeadline: Date | null;
}

/** How many outcomes in review the evaluator command lists, and the evaluator job watches for their deadlines. */
export const REVIEW_LIST_LIMIT = 100;

/** The finalizations in review, oldest first. */
export async function listReview(store: Pick<LemmaStore, "listWarrantyActions" | "getResolution" | "getReceipt" | "listRegistryEvents">, now: Date, limit = REVIEW_LIST_LIMIT): Promise<ReviewItem[]> {
  const actions = await store.listWarrantyActions({ kind: "finalize", state: "review" }, limit);
  const deadlines = await claimDeadlinesInForce(store, actions.map((a) => a.resolutionId), BigInt(Math.floor(now.getTime() / 1000)));
  const items: ReviewItem[] = [];
  for (const action of actions) {
    const [row, receipt] = await Promise.all([store.getResolution(action.resolutionId), store.getReceipt(action.resolutionId)]);
    const release = row?.resolution.release;
    const deadline = deadlines.get(action.resolutionId);
    items.push({
      resolutionId: action.resolutionId,
      release: release === undefined ? "unknown" : `${release.releaseId}@${release.version}`,
      releaseDigest: release?.releaseDigest ?? action.resolutionId,
      profileIndex: release?.profileIndex ?? 0,
      receiptOutcome: receipt?.receipt.outcome ?? null,
      exitCode: receipt?.receipt.acceptance.exitCode ?? null,
      ageSeconds: Math.max(0, Math.floor((now.getTime() - action.createdAt.getTime()) / 1000)),
      claimDeadline: deadline === undefined ? null : new Date(Number(deadline) * 1000),
    });
  }
  return items;
}

/** What a decision did: queued the finalization, found no finalization in review for it, or no finalization at all. */
export type DecisionResult = "QUEUED" | "NOT_IN_REVIEW" | "UNKNOWN_RESOLUTION";

/**
 * An operator's decision on a failed outcome in review: `failed` finalizes
 * it FAILED (with the weight the evaluator gave it, so the damper still
 * applies), `void` finalizes it VOID with weight 0. The action moves to
 * `queued`, due now; the evaluator job signs and sends it. Only an action
 * still in review changes (compare-and-set), so deciding twice, or after the
 * warranty ended, does nothing.
 */
export async function decideReview(store: Pick<LemmaStore, "getWarrantyAction" | "updateWarrantyAction">, resolutionId: string, verdict: "failed" | "void", now: Date): Promise<DecisionResult> {
  const id = Hex32.safeParse(resolutionId);
  if (!id.success) return "UNKNOWN_RESOLUTION";
  const action = await store.getWarrantyAction(id.data, "finalize");
  if (action === undefined) return "UNKNOWN_RESOLUTION";
  const outcome = WarrantyOutcome.safeParse(action.payload);
  if (action.state !== "review" || !outcome.success) return "NOT_IN_REVIEW";
  const decided: WarrantyOutcome = { ...outcome.data, verdict, weightBps: verdict === "void" ? 0 : outcome.data.weightBps };
  const moved = await store.updateWarrantyAction(id.data, "finalize", { attempts: action.attempts, state: "review" }, { state: "queued", payload: decided, signature: null, nextAttemptAt: now, lastCode: null }, now);
  return moved ? "QUEUED" : "NOT_IN_REVIEW";
}

/** `3h 20m`, `45s`: an age for the operator's list. */
export function formatAge(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

/** One line of the operator's list, at `now`. */
export function formatReviewItem(item: ReviewItem, now: Date): string {
  const receipt = item.receiptOutcome === null ? "no receipt" : `receipt ${item.receiptOutcome} (exit ${item.exitCode ?? "none"})`;
  return `${item.resolutionId}  ${item.release}  profile ${item.profileIndex}  ${receipt}  waiting ${formatAge(item.ageSeconds)}  ${formatDeadline(item.claimDeadline, now)}`;
}

/** `decide by 2026-10-04T00:00:00Z (in 5h 20m)`, or that the window closed, or that no activation is indexed. */
function formatDeadline(deadline: Date | null, now: Date): string {
  if (deadline === null) return "decide by: unknown (activation not indexed)";
  const left = Math.floor((deadline.getTime() - now.getTime()) / 1000);
  return `decide by ${deadline.toISOString().replace(".000Z", "Z")} (${left > 0 ? `in ${formatAge(left)}` : "window closed"})`;
}

export type EvaluatorCommand = { readonly command: "list" } | { readonly command: "decide"; readonly resolutionId: Hex32; readonly verdict: "failed" | "void" };

export const EVALUATOR_USAGE = "usage: npm run evaluator -w @lemma/server -- list | decide <resolutionId> failed|void";

/** What the evaluator command printed: lines for standard output, and why it failed (for standard error), or null. */
export interface EvaluatorCommandResult {
  readonly lines: readonly string[];
  readonly error: string | null;
}

/**
 * The evaluator command (`npm run evaluator`, `src/scripts/evaluator.ts`)
 * over a database: it refuses a schema behind this build, then lists the
 * failed outcomes in review or queues an operator's decision on one. It
 * prints nothing about the buyer and needs no key: the evaluator job signs.
 */
export async function runEvaluatorCommand(db: Db, command: EvaluatorCommand, now: Date): Promise<EvaluatorCommandResult> {
  const schema = await schemaIsCurrent(db);
  if (!schema.current) return { lines: [], error: `the database schema is behind this build (applied ${schema.applied ?? "none"}, expected ${schema.expected}); run npm run db:migrate first` };
  const store = new PgStore(db);
  if (command.command === "list") {
    const items = await listReview(store, now);
    return { lines: items.length === 0 ? ["no failed outcome waits for a decision"] : items.map((item) => formatReviewItem(item, now)), error: null };
  }
  const result = await decideReview(store, command.resolutionId, command.verdict, now);
  if (result === "QUEUED") return { lines: [`queued ${command.resolutionId} as ${command.verdict}; the evaluator job signs and sends it`], error: null };
  if (result === "NOT_IN_REVIEW") return { lines: [], error: `${command.resolutionId} is not waiting for a decision (decided already, or its warranty ended)` };
  return { lines: [], error: `no finalization is held for ${command.resolutionId}` };
}

/** Parses the evaluator command's arguments; an error message for anything else. */
export function parseEvaluatorArgs(args: readonly string[]): EvaluatorCommand | { readonly error: string } {
  if (args.length === 1 && args[0] === "list") return { command: "list" };
  if (args.length === 3 && args[0] === "decide") {
    const id = Hex32.safeParse(args[1]);
    if (!id.success) return { error: "the resolution id must be 0x and 64 lowercase hex digits" };
    if (args[2] !== "failed" && args[2] !== "void") return { error: "the decision must be failed or void" };
    return { command: "decide", resolutionId: id.data, verdict: args[2] };
  }
  return { error: EVALUATOR_USAGE };
}
