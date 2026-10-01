import type { AgentId, Hex32 } from "@lemma/core";

import { describeError, errorCode } from "../errors.js";
import type { Logger } from "../log.js";
import type { LemmaStore, NewReputationPost, ReputationPost, ReputationPostChange, ReputationTarget } from "../persistence.js";
import { type FeedbackRefusal, type ReputationChain, isRevert, refusalOf } from "./chain.js";
import { buildEvidence, feedbackRequest } from "./evidence.js";
import { FinalizedOutcome, type OutcomeFeed } from "./feed.js";

/** The attester's ledger and the resolution rows it checks a buyer agent against. */
export type AttesterStore = Pick<LemmaStore, "enqueueReputationPosts" | "dueReputationPosts" | "updateReputationPost" | "getResolution">;

export interface AttesterDeps {
  readonly store: AttesterStore;
  readonly chain: ReputationChain;
  readonly feed: OutcomeFeed;
  /** The provider's ERC-8004 agent id: every outcome's feedback goes to it. */
  readonly providerAgentId: AgentId;
  /** `PUBLIC_BASE_URL`: feedback URIs are `${publicBaseUrl}/api/v1/evidence/<resolutionId>/<provider|buyer-agent>`. */
  readonly publicBaseUrl: string;
  /** Times everything the attester decides: claims and their leases, backoff, and each send's deadline (the chain client reads it on this clock too). */
  readonly clock: () => Date;
  readonly logger: Logger;
  /** Retry delays: `baseMs * 2^(attempt-1)`, at most `maxMs`. */
  readonly backoff?: { readonly baseMs: number; readonly maxMs: number };
  /** How long to wait for the attester's own unmined transactions before looking again. */
  readonly pendingWaitMs?: number;
  /** Outcomes read from the feed per page, and posts attempted per tick. */
  readonly batch?: number;
}

export interface TickResult {
  readonly queued: number;
  readonly posted: number;
  readonly skipped: number;
  readonly failed: number;
}

/** Why a buyer agent's feedback was not posted: its agent is not owned by, or wired to, the address that paid. */
export const AGENT_NOT_BUYER = "AGENT_NOT_BUYER";

/**
 * Why a post was never sent: its stored feedback file does not fit the call
 * this attester would make (`feedbackRequest`). It names another client or
 * identity registry, because it was queued before the attester key or the
 * identity registry changed, or it is not the post's own file.
 */
export const FILE_MISMATCH = "FILE_MISMATCH";

const DEFAULT_BACKOFF = { baseMs: 30_000, maxMs: 3_600_000 } as const;

/**
 * How long a claimed attempt holds its post: no attester starts the post's
 * next attempt before then. It outlasts everything the attempt does: the send
 * (broadcast within `SEND_DEADLINE_MS` of the claim or never, plus one request
 * of at most 10 seconds) and the wait for its receipt (30 seconds, plus one
 * request).
 */
export const ATTEMPT_LEASE_MS = 5 * 60_000;

/** An attempt's transaction is broadcast within this long of its claim, or not at all. */
export const SEND_DEADLINE_MS = 2 * 60_000;

/**
 * Posts ERC-8004 feedback for finalized outcomes, after the fact and off every
 * request path. Each tick:
 *
 * 1. Reads new outcomes from the feed and queues one post per outcome for the
 *    provider's agent, and one for the buyer's agent when the buyer opted in
 *    (unless it names the provider's agent). Queueing is idempotent: one row
 *    per resolution and target. Each post has its own feedback file (core
 *    `AdoptionFeedbackFile`, which names the target agent), stored as the
 *    bytes its `feedbackHash` covers.
 * 2. Attempts every due post: `giveFeedback(agentId, 100 or 0, 0,
 *    "lemma.adoption", capability, "", feedbackURI, feedbackHash)`, with
 *    `feedbackURI` the post's own file (`evidencePath`) and every other
 *    argument equal to that file's fields.
 *
 * It never double-posts: an attempt is claimed in the ledger (conditionally
 * on the attempts read, so two attesters never send the same one) before the
 * transaction is sent. The claim holds the post for `ATTEMPT_LEASE_MS`, and
 * the send gives up unbroadcast once `SEND_DEADLINE_MS` has passed, so a slow
 * send never goes out after another attester has taken the post over. Once a
 * post has an attempt, every later attempt first searches the chain for the
 * attester's `NewFeedback` to the post's agent with the hash of the post's own
 * file, and waits while the attester has unmined transactions, so a crash
 * between a send and the ledger update finds the feedback instead of sending
 * it again. A resend carries the nonce read before that search, so an earlier
 * transaction mined just after it cannot be joined by the resend. Failures
 * back off exponentially (30 s doubling to an hour) and never throw.
 *
 * Buyer agents are opt-in, and the buyer must control the agent it names:
 * feedback goes to it only if the address that paid owns it or is its agent
 * wallet; otherwise the post is skipped (`AGENT_NOT_BUYER`).
 *
 * Each call is read from the post's stored file just before it is sent. A
 * file that names another client or identity registry (queued before the
 * attester key or `ERC8004_IDENTITY_REGISTRY` changed) is skipped
 * (`FILE_MISMATCH`), so no feedback ever points at a file that misnames it.
 *
 * The registry refuses some feedback for good: self-feedback (from the agent's
 * owner, its approved address or an operator of its owner) and feedback to an
 * agent that does not exist. The attester checks the provider's agent by that
 * rule before its first tick, and a refusal met later while sending is final
 * too: it stops the attester for the provider's agent, and skips a buyer
 * agent's post (`SELF_FEEDBACK` or `NO_SUCH_AGENT`), rather than retry it.
 */
export class Attester {
  private cursor: string | null = null;
  private running = false;
  private halted = false;
  private providerChecked = false;
  private readonly backoff: { readonly baseMs: number; readonly maxMs: number };
  private readonly pendingWaitMs: number;
  private readonly batch: number;

  constructor(private readonly deps: AttesterDeps) {
    this.backoff = deps.backoff ?? DEFAULT_BACKOFF;
    this.pendingWaitMs = deps.pendingWaitMs ?? 15_000;
    this.batch = deps.batch ?? 50;
  }

  /** The delay before attempt `attempt + 1`, after attempt `attempt` failed. */
  delayAfter(attempt: number): number {
    return Math.min(this.backoff.baseMs * 2 ** Math.max(0, attempt - 1), this.backoff.maxMs);
  }

  /** Runs `tick` every `intervalMs` (the first one now); returns a function that stops it. */
  start(intervalMs = 60_000): () => void {
    const timer = setInterval(() => void this.tick(), intervalMs);
    timer.unref();
    void this.tick();
    return () => clearInterval(timer);
  }

  /** One pass: queue new outcomes, then attempt the due posts. Never throws; overlapping calls do nothing. */
  async tick(): Promise<TickResult> {
    const result = { queued: 0, posted: 0, skipped: 0, failed: 0 };
    if (this.running || this.halted) return result;
    this.running = true;
    try {
      if (!(await this.checkProviderAgent())) return result;
      result.queued = await this.queue();
      const now = this.deps.clock();
      let due: ReputationPost[];
      try {
        due = await this.deps.store.dueReputationPosts(now, this.batch);
      } catch (error) {
        this.deps.logger.log("warn", "reputation.ledger_failed", { error: describeError(error) });
        return result;
      }
      for (const post of due) {
        const outcome = await this.attempt(post, this.deps.clock());
        if (outcome === "posted") result.posted++;
        else if (outcome === "skipped") result.skipped++;
        else if (outcome === "retry") result.failed++;
        else if (outcome === "failed") {
          result.failed++;
          // The chain or the ledger is failing: leave the rest for the next tick rather than fail each of them now.
          break;
        }
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  /**
   * Whether the registry takes the attester's feedback to the provider's agent.
   * A refusal is a misconfiguration: the attester owns the agent or was approved
   * for it (the owner key and the attester key must differ, and the owner must
   * not approve the attester), or `LEMMA_AGENT_ID` names no agent. Stop, and say
   * so once.
   */
  private async checkProviderAgent(): Promise<boolean> {
    if (this.providerChecked) return true;
    try {
      const refusal = await this.deps.chain.feedbackRefusal(BigInt(this.deps.providerAgentId));
      if (refusal !== undefined) {
        this.halt(refusal);
        return false;
      }
      this.providerChecked = true;
      return true;
    } catch (error) {
      this.deps.logger.log("warn", "reputation.chain_failed", { step: "provider-check", error: describeError(error) });
      return false;
    }
  }

  /** Stops the attester for good (until a restart) because the registry refuses its feedback to the provider's agent. */
  private halt(refusal: FeedbackRefusal): void {
    this.halted = true;
    const fields = { agentId: this.deps.providerAgentId, attester: this.deps.chain.attester };
    if (refusal === "SELF_FEEDBACK") {
      this.deps.logger.log("error", "reputation.self_feedback", {
        ...fields,
        note: "the registry refuses feedback from the agent's owner and anyone it approved: use a separate attester key, and do not approve it",
      });
    } else {
      this.deps.logger.log("error", "reputation.no_such_agent", { ...fields, note: "LEMMA_AGENT_ID names no agent in the identity registry" });
    }
  }

  /** Queues the posts for new outcomes; the cursor only advances past what was queued. */
  private async queue(): Promise<number> {
    let queued = 0;
    for (;;) {
      let page: Awaited<ReturnType<OutcomeFeed["read"]>>;
      try {
        page = await this.deps.feed.read(this.cursor, this.batch);
      } catch (error) {
        this.deps.logger.log("warn", "reputation.feed_failed", { error: describeError(error) });
        return queued;
      }
      const posts = page.outcomes.flatMap((o) => this.postsFor(o));
      try {
        queued += await this.deps.store.enqueueReputationPosts(posts, this.deps.clock());
      } catch (error) {
        this.deps.logger.log("warn", "reputation.ledger_failed", { error: describeError(error) });
        return queued;
      }
      const before = this.cursor;
      this.cursor = page.cursor;
      // A short page is the end; a cursor that did not move would read the same page forever.
      if (page.outcomes.length < this.batch || page.cursor === before) return queued;
    }
  }

  private postsFor(raw: unknown): NewReputationPost[] {
    const parsed = FinalizedOutcome.safeParse(raw);
    if (!parsed.success) {
      const id = typeof raw === "object" && raw !== null ? (raw as { resolutionId?: unknown }).resolutionId : undefined;
      this.deps.logger.log("warn", "reputation.outcome_invalid", { resolutionId: typeof id === "string" && /^0x[0-9a-f]{64}$/.test(id) ? id : "unknown" });
      return [];
    }
    const outcome = parsed.data;
    const targets: Array<readonly [ReputationTarget, AgentId]> = [["provider", this.deps.providerAgentId]];
    // A buyer naming the provider's own agent would post the same feedback to it twice.
    if (outcome.buyerAgentId !== null && outcome.buyerAgentId !== this.deps.providerAgentId) targets.push(["buyer", outcome.buyerAgentId]);
    try {
      // One file per feedback, since it names the agent: each post has its own bytes and hash. The post's value and
      // tag2 come from its file, so the call it makes equals the file it points at.
      return targets.map(([target, agentId]) => {
        const { file, bytes, feedbackHash } = buildEvidence(outcome, agentId, this.deps.chain);
        return { resolutionId: outcome.resolutionId, target, agentId, capability: file.tag2, value: file.value, feedbackHash, evidence: bytes };
      });
    } catch {
      // For example a verdict its exit code contradicts: never published.
      this.deps.logger.log("warn", "reputation.outcome_invalid", { resolutionId: outcome.resolutionId });
      return [];
    }
  }

  /**
   * One attempt at a post: `retry` when this post failed on its own (a
   * revert), `failed` when the chain or the ledger did, which ends the tick.
   */
  private async attempt(post: ReputationPost, now: Date): Promise<"posted" | "skipped" | "waiting" | "retry" | "failed"> {
    const { chain, store } = this.deps;
    const update = (expected: number, change: ReputationPostChange) => store.updateReputationPost(post.resolutionId, post.target, expected, change, this.deps.clock());
    const agentId = BigInt(post.agentId);
    let claimed: number | undefined;
    // A resend's nonce; a first send takes the attester's next one.
    let nonce: number | undefined;
    try {
      if (post.attempts > 0) {
        // A send may have landed after the last ledger write: look before ever sending again. The last known
        // transaction's receipt answers first; the log search also finds a send the ledger never recorded.
        if (post.txHash !== null && (await chain.receiptStatus(post.txHash)) === "success") {
          return (await this.finish(post, post.attempts, post.txHash)) ? "posted" : "waiting";
        }
        // The resend's nonce is read before the search. An earlier transaction still unmined then holds that nonce
        // (none is pending), so if it is mined after the search missed it, the resend is refused instead of mined too.
        const counts = await chain.nonces();
        if (counts.pending > counts.mined) {
          await update(post.attempts, { nextAttemptAt: new Date(now.getTime() + this.pendingWaitMs), note: "PENDING_TX" });
          return "waiting";
        }
        const found = await chain.findFeedback({ agentId, feedbackHash: post.feedbackHash, fromBlock: BigInt(post.fromBlock ?? "0") });
        if (found !== undefined) return (await this.finish(post, post.attempts, found)) ? "posted" : "waiting";
        nonce = counts.mined;
      }
      // The call is read from the post's own file, so it equals what its feedbackURI serves. A file that does not fit this
      // attester (queued under another attester key or identity registry) would name another client: never sent.
      const request = feedbackRequest(post, chain, this.deps.publicBaseUrl);
      if (request === undefined) {
        await update(post.attempts, { state: "skipped", note: FILE_MISMATCH });
        this.deps.logger.log("warn", "reputation.skipped", { resolutionId: post.resolutionId, target: post.target, reason: FILE_MISMATCH });
        return "skipped";
      }
      if (post.target === "buyer" && post.attempts === 0) {
        const payer = (await store.getResolution(post.resolutionId))?.payer;
        if (payer === undefined || !(await chain.controlsAgent(agentId, payer))) {
          await update(0, { state: "skipped", note: AGENT_NOT_BUYER });
          this.deps.logger.log("info", "reputation.skipped", { resolutionId: post.resolutionId, target: post.target, reason: AGENT_NOT_BUYER });
          return "skipped";
        }
      }
      const fromBlock = post.fromBlock ?? (await chain.blockNumber()).toString();
      const attempts = post.attempts + 1;
      // Claimed before the send, so after a crash the next attempt searches the chain first. The claim is a lease that
      // outlasts the whole attempt: no other attester starts the next one while this send may still go out.
      const claimedAt = this.deps.clock().getTime();
      const lease = new Date(claimedAt + Math.max(this.delayAfter(attempts), ATTEMPT_LEASE_MS));
      if (!(await update(post.attempts, { attempts, fromBlock, nextAttemptAt: lease }))) return "waiting";
      claimed = attempts;
      const txHash = await chain.giveFeedback(
        request,
        // The deadline is read on the clock that set it and that times the lease, never on the wall clock.
        { notAfter: new Date(claimedAt + SEND_DEADLINE_MS), clock: this.deps.clock, nonce },
      );
      await update(attempts, { txHash });
      const mined = await chain.feedbackOutcome(txHash);
      if (mined === "success") return (await this.finish(post, attempts, txHash)) ? "posted" : "waiting";
      // Reverted: nothing was posted, and the next attempt (after its search) sends again. Unknown: the search will tell.
      await update(attempts, { note: mined === "reverted" ? "REVERTED" : "UNCONFIRMED", nextAttemptAt: this.retryAt(attempts) });
      this.deps.logger.log("warn", "reputation.not_confirmed", { resolutionId: post.resolutionId, target: post.target, attempt: attempts, result: mined });
      return mined === "reverted" ? "retry" : "waiting";
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal !== undefined) return this.refused(post, claimed ?? post.attempts, refusal);
      const code = isRevert(error) ? "REVERT" : (errorCode(error) ?? (error instanceof Error ? error.name : "ERROR"));
      this.deps.logger.log("warn", "reputation.attempt_failed", { resolutionId: post.resolutionId, target: post.target, attempt: claimed ?? post.attempts, error: describeError(error) });
      // Either way the post backs off from its attempts so far; a claimed attempt is over, so its lease gives way.
      const retry = claimed === undefined ? new Date(now.getTime() + this.delayAfter(post.attempts + 1)) : this.retryAt(claimed);
      await update(claimed ?? post.attempts, { nextAttemptAt: retry, note: code }).catch(() => false);
      return code === "REVERT" ? "retry" : "failed";
    }
  }

  /**
   * The registry refused the post's feedback for good, before anything was
   * sent: for the provider's agent the attester stops (the post stays pending
   * for after a restart), and a buyer agent's post is skipped.
   */
  private async refused(post: ReputationPost, attempts: number, refusal: FeedbackRefusal): Promise<"skipped" | "failed"> {
    const update = (change: ReputationPostChange) => this.deps.store.updateReputationPost(post.resolutionId, post.target, attempts, change, this.deps.clock()).catch(() => false);
    if (post.target === "provider") {
      this.halt(refusal);
      await update({ nextAttemptAt: this.retryAt(attempts), note: refusal });
      return "failed";
    }
    await update({ state: "skipped", note: refusal });
    this.deps.logger.log("info", "reputation.skipped", { resolutionId: post.resolutionId, target: post.target, reason: refusal });
    return "skipped";
  }

  /** When the next attempt is due after attempt `attempt` ended without posting. */
  private retryAt(attempt: number): Date {
    return new Date(this.deps.clock().getTime() + this.delayAfter(attempt));
  }

  private async finish(post: ReputationPost, attempts: number, txHash: Hex32): Promise<boolean> {
    const done = await this.deps.store.updateReputationPost(post.resolutionId, post.target, attempts, { state: "posted", txHash, note: null }, this.deps.clock());
    if (done) this.deps.logger.log("info", "reputation.posted", { resolutionId: post.resolutionId, target: post.target, txHash });
    return done;
  }
}
