import { type Hex32, type WarrantyActionKind, type WarrantyActionRef, isFinalActionState } from "@lemma/core";

import { describeError, errorCode } from "../errors.js";
import type { Logger } from "../log.js";
import type { LemmaStore, WarrantyAction, WarrantyActionChange, WarrantyActionExpectation, WarrantyPayload } from "../persistence.js";
import { ATTEMPT_LEASE_MS, SEND_DEADLINE_MS } from "../reputation/attester.js";
import { type RegistryCall, type RegistryRelease, type RegistryResolution, type RegistryRevert, SENDER_OF, type WarrantyChain, registryRevertOf } from "./chain.js";
import { type Backoff, DEFAULT_BACKOFF, type Jitter, backoffDelay, cryptoJitter } from "./loop.js";

/** What the outbox jobs read and write. */
export type WarrantyStore = Pick<
  LemmaStore,
  | "insertWarrantyAction"
  | "getWarrantyAction"
  | "dueWarrantyActions"
  | "listWarrantyActions"
  | "updateWarrantyAction"
  | "listResolutionsToActivate"
  | "listWarrantiesToEvaluate"
  | "listWarrantiesToExpire"
  | "countDamperOutcomes"
  | "listRegistryEvents"
  | "getResolution"
  | "getReceipt"
>;

/** What every outbox job shares. */
export interface ActionJobDeps {
  readonly store: WarrantyStore;
  readonly chain: WarrantyChain;
  /** The server's clock: it times claims, leases, backoff and each send's deadline. Every on-chain deadline is judged by the chain's clock (the head block's time). */
  readonly clock: () => Date;
  readonly logger: Logger;
  /** Retry delays per row (default 30 s doubling to an hour), each with up to a fifth more at random. */
  readonly backoff?: Backoff;
  /** Random whole numbers for jitter (default `crypto.randomInt`); tests pass a fixed one. */
  readonly jitter?: Jitter;
  /** Actions attempted per run, and rows discovered per run (default 25). */
  readonly batch?: number;
  /** How long to wait for a sender's own unmined transactions before looking again (default 15 s). */
  readonly pendingWaitMs?: number;
}

/** How a job's check before a send ends: close the action, look again later, or send this call. */
export type Decision =
  | { readonly kind: "finish"; readonly state: "done" | "skipped" | "abandoned"; readonly code: string | null }
  | { readonly kind: "wait"; readonly until: Date; readonly code: string }
  | { readonly kind: "backoff"; readonly code: string }
  | { readonly kind: "send"; readonly call: RegistryCall; readonly payload?: WarrantyPayload; readonly signature?: string | null };

/** A decision that sends nothing. */
export type SettledDecision = Exclude<Decision, { readonly kind: "send" }>;

/** What one run knows: the server's time and the chain's (read again before an attempt once `CONTEXT_MAX_AGE_MS` old), and each release's registry entry, read once. */
export interface RunContext {
  readonly now: Date;
  /** The head block's timestamp, in Unix seconds: the registry's clock. */
  readonly chainNow: bigint;
  release(releaseDigest: Hex32): Promise<RegistryRelease>;
}

/** One kind's rules: what to check before sending, and what a revert means. */
export interface ActionRules {
  readonly kind: WarrantyActionKind;
  /** The call's function, which fixes the sender (`SENDER_OF`). */
  readonly fn: RegistryCall["fn"];
  /**
   * Reads the registry and decides, before every send and resend: close the
   * action when its effect already happened (by this job or anyone), or
   * cannot; wait; or build the call (re-signing when a signed deadline is
   * near), with the payload and signature to write with the attempt's claim.
   */
  prepare(action: WarrantyAction, resolution: RegistryResolution, ctx: RunContext): Promise<Decision>;
  /** What a registry revert of this call means: never a send (the next attempt prepares again). */
  onRevert(action: WarrantyAction, revert: RegistryRevert, ctx: RunContext): Promise<SettledDecision>;
  /** The payload a closed action keeps (a withdrawal drops its claim); by default the one it has. */
  closedPayload?(action: WarrantyAction): WarrantyPayload;
}

/**
 * How old a run's reading of the chain's clock may be, on the server's clock,
 * when an action's attempt begins: older, the head is read again. A batch of
 * slow sends (each can wait half a minute for its receipt) would otherwise
 * judge its last actions' deadlines by a clock minutes old.
 */
export const CONTEXT_MAX_AGE_MS = 5_000;

/** Why an action waited or retried when nothing more specific applies. */
export const PENDING_TX = "PENDING_TX";
export const REVERTED = "REVERTED";
export const UNCONFIRMED = "UNCONFIRMED";
export const STALE_READ = "STALE_READ";

/**
 * A registry status the event an action came from rules out. Finalizations,
 * expiries and withdrawals are written only for events the indexer stored at
 * its confirmation depth, so a correct node never answers such a status for
 * them; a lagging backend of a load-balanced endpoint does, since the read's
 * block is its own old head. A `prepare` throws it rather than close the
 * action for good on a state that is not the chain's: the attempt then fails
 * like any other chain failure and is retried (30 s, doubling per attempt).
 */
export class StaleReadError extends Error {
  override name = "StaleReadError";
  readonly code = STALE_READ;

  constructor() {
    super("the registry answered a status the indexed events rule out");
  }
}

/** What a run did with its due actions. */
export interface ActionReport {
  readonly done: number;
  readonly skipped: number;
  readonly abandoned: number;
  /** Transactions broadcast. */
  readonly sent: number;
  /** Actions left for later: waiting, backing off, or claimed by another job. */
  readonly waiting: number;
  /** Actions the chain or the store failed on. */
  readonly failed: number;
}

type Tally = { -readonly [K in keyof ActionReport]: number };

export const emptyReport = (): Tally => ({ done: 0, skipped: 0, abandoned: 0, sent: 0, waiting: 0, failed: 0 });

/** A reference-only payload: what a closed withdrawal keeps. */
export const refPayload = (resolutionId: Hex32): WarrantyActionRef => ({ schemaVersion: "1", resolutionId });

/**
 * The outbox's send discipline, shared by the activator, the evaluator, the
 * expirer and the credit relay; it mirrors track F's attester, which was
 * reviewed for it:
 *
 * - An attempt is written to the outbox before anything is sent: the action
 *   moves to `sent` with one more attempt, the payload and signature about
 *   to be sent, and a lease (`ATTEMPT_LEASE_MS`) no other job starts the next
 *   attempt before, all compare-and-set on the state and attempts read, so
 *   two jobs never send the same attempt. The send gives up unbroadcast once
 *   `SEND_DEADLINE_MS` of the claim has passed.
 * - Before any resend (an action with attempts), it reads the recorded
 *   transaction's receipt, then the sender's nonces (and waits while the
 *   sender has unmined transactions), then the registry's state (the rules'
 *   `prepare`, which closes the action when its effect already happened, by
 *   this job or anyone). The resend carries the nonce read before that state
 *   check, so an earlier transaction mined after the check makes the resend
 *   a refused duplicate instead of a second effect. One transaction is out
 *   per action at a time.
 * - A registry revert is decoded into its custom error's code and handed to
 *   the rules; any other failure backs the action off (30 s doubling to an
 *   hour, with jitter). Nothing throws out of a run.
 * - Logs name codes and resolution ids only: never a key, a payer, a claim
 *   secret or a refund address.
 */
export class ActionSender {
  private readonly backoff: Backoff;
  private readonly jitter: Jitter;

  constructor(
    private readonly deps: ActionJobDeps,
    private readonly rules: ActionRules,
  ) {
    this.backoff = deps.backoff ?? DEFAULT_BACKOFF;
    this.jitter = deps.jitter ?? cryptoJitter;
  }

  /** The delay after attempt `attempt` failed, with jitter. */
  delayAfter(attempt: number): number {
    return backoffDelay(this.backoff, attempt, this.jitter);
  }

  /** Attempts every due action of this kind, up to the batch. */
  async sendDue(ctx: RunContext, report: Tally): Promise<void> {
    let due: WarrantyAction[];
    try {
      due = await this.deps.store.dueWarrantyActions(this.rules.kind, ctx.now, this.deps.batch ?? 25);
    } catch (error) {
      this.deps.logger.log("warn", "warranty.outbox_failed", { kind: this.rules.kind, error: describeError(error) });
      report.failed++;
      return;
    }
    let current = ctx;
    for (const action of due) {
      const fresh = await this.fresh(current);
      if (fresh === undefined) {
        report.failed++;
        break;
      }
      current = fresh;
      const outcome = await this.attempt(action, current, report);
      report[outcome]++;
      // The chain or the store is failing: leave the rest for the next run rather than fail each of them now.
      if (outcome === "failed") break;
    }
  }

  /** The context with the chain's head read again once it is `CONTEXT_MAX_AGE_MS` old; undefined when the chain does not answer. */
  private async fresh(ctx: RunContext): Promise<RunContext | undefined> {
    const now = this.deps.clock();
    if (now.getTime() - ctx.now.getTime() < CONTEXT_MAX_AGE_MS) return ctx;
    try {
      const head = await this.deps.chain.head();
      return { ...ctx, now, chainNow: chainSeconds(head.timestamp) };
    } catch (error) {
      this.deps.logger.log("warn", "warranty.chain_failed", { kind: this.rules.kind, error: describeError(error) });
      return undefined;
    }
  }

  /** One attempt at one action: how it ended (a broadcast is also counted in `report.sent`). */
  async attempt(action: WarrantyAction, ctx: RunContext, report: Pick<Tally, "sent">): Promise<Exclude<keyof ActionReport, "sent">> {
    const { chain, store, clock } = this.deps;
    const sender = SENDER_OF[this.rules.fn];
    let expected: WarrantyActionExpectation = { attempts: action.attempts, state: action.state };
    try {
      // A transaction may be out. Its receipt answers first.
      if (action.attempts > 0 && action.txHash !== null && (await chain.receiptStatus(action.txHash)) === "success") return await this.close(action, expected, "done", null);
      // The nonce read, the registry check and the send run inside the sender's queue, so no other job's send takes the nonce in between.
      const sent = await chain.exclusive(sender, async (): Promise<{ readonly txHash: Hex32; readonly attempts: number } | Exclude<keyof ActionReport, "sent">> => {
        let nonce: number | undefined;
        if (action.attempts > 0) {
          // A resend's nonce is read before the registry is: see the class comment.
          const counts = await chain.nonces(sender);
          if (counts.pending > counts.mined) return await this.wait(action, expected, new Date(ctx.now.getTime() + (this.deps.pendingWaitMs ?? 15_000)), PENDING_TX);
          nonce = counts.mined;
        }
        const decision = await this.rules.prepare(action, await chain.resolution(action.resolutionId), ctx);
        if (decision.kind !== "send") return await this.apply(action, expected, decision);

        const attempts = action.attempts + 1;
        const claimedAt = clock().getTime();
        const lease = new Date(claimedAt + Math.max(this.delayAfter(attempts), ATTEMPT_LEASE_MS));
        const claim: WarrantyActionChange = {
          state: "sent",
          attempts,
          nextAttemptAt: lease,
          lastCode: null,
          ...(decision.payload === undefined ? {} : { payload: decision.payload }),
          ...(decision.signature === undefined ? {} : { signature: decision.signature }),
        };
        if (!(await store.updateWarrantyAction(action.resolutionId, this.rules.kind, expected, claim, clock()))) return "waiting";
        expected = { attempts, state: "sent" };
        return { txHash: await chain.send(decision.call, { notAfter: new Date(claimedAt + SEND_DEADLINE_MS), clock, nonce }), attempts };
      });
      if (typeof sent === "string") return sent;
      const { txHash, attempts } = sent;
      report.sent++;
      await store.updateWarrantyAction(action.resolutionId, this.rules.kind, expected, { txHash, sentAt: clock() }, clock());
      this.deps.logger.log("info", "warranty.sent", { kind: this.rules.kind, resolutionId: action.resolutionId, attempt: attempts, txHash });
      const mined = await chain.waitForReceipt(txHash);
      if (mined === "success") return await this.close({ ...action, attempts, state: "sent" }, expected, "done", null);
      // Reverted when mined: the next attempt reads the registry again. Unknown: its receipt is read first.
      const code = mined === "reverted" ? REVERTED : UNCONFIRMED;
      await store.updateWarrantyAction(action.resolutionId, this.rules.kind, expected, { nextAttemptAt: this.retryAt(attempts), lastCode: code }, clock());
      this.deps.logger.log("warn", "warranty.not_confirmed", { kind: this.rules.kind, resolutionId: action.resolutionId, attempt: attempts, code });
      return "waiting";
    } catch (error) {
      const revert = registryRevertOf(error);
      const current = { ...action, attempts: expected.attempts, state: expected.state };
      if (revert !== undefined) {
        try {
          return await this.apply(current, expected, await this.rules.onRevert(current, revert, ctx));
        } catch (inner) {
          return this.failed(current, expected, inner);
        }
      }
      return this.failed(current, expected, error);
    }
  }

  /** Applies a decision other than a send. */
  private async apply(action: WarrantyAction, expected: WarrantyActionExpectation, decision: Exclude<Decision, { kind: "send" }>): Promise<"done" | "skipped" | "abandoned" | "waiting"> {
    switch (decision.kind) {
      case "finish":
        return this.close(action, expected, decision.state, decision.code);
      case "wait":
        return this.wait(action, expected, decision.until, decision.code);
      case "backoff":
        await this.deps.store.updateWarrantyAction(action.resolutionId, this.rules.kind, expected, { nextAttemptAt: this.backoffAt(action), lastCode: decision.code }, this.deps.clock());
        this.deps.logger.log("warn", "warranty.retry", { kind: this.rules.kind, resolutionId: action.resolutionId, code: decision.code });
        return "waiting";
    }
  }

  /** Closes an action for good: done, skipped or abandoned. */
  private async close(action: WarrantyAction, expected: WarrantyActionExpectation, state: "done" | "skipped" | "abandoned", code: string | null): Promise<"done" | "skipped" | "abandoned" | "waiting"> {
    if (isFinalActionState(action.state)) return "waiting";
    const payload = this.rules.closedPayload?.(action);
    const closed = await this.deps.store.updateWarrantyAction(
      action.resolutionId,
      this.rules.kind,
      expected,
      { state, lastCode: code, ...(payload === undefined ? {} : { payload }) },
      this.deps.clock(),
    );
    if (!closed) return "waiting";
    this.deps.logger.log(state === "done" ? "info" : "warn", `warranty.${state}`, { kind: this.rules.kind, resolutionId: action.resolutionId, ...(code === null ? {} : { code }) });
    return state;
  }

  private async wait(action: WarrantyAction, expected: WarrantyActionExpectation, until: Date, code: string): Promise<"waiting"> {
    await this.deps.store.updateWarrantyAction(action.resolutionId, this.rules.kind, expected, { nextAttemptAt: until, lastCode: code }, this.deps.clock());
    return "waiting";
  }

  /** A failure that is not the registry's answer (the chain, the store, a send past its deadline): back off, and end the run's sends. */
  private async failed(action: WarrantyAction, expected: WarrantyActionExpectation, error: unknown): Promise<"failed"> {
    const code = errorCode(error) ?? (error instanceof Error ? error.name : "ERROR");
    this.deps.logger.log("warn", "warranty.attempt_failed", { kind: this.rules.kind, resolutionId: action.resolutionId, attempt: expected.attempts, error: describeError(error) });
    await this.deps.store
      .updateWarrantyAction(action.resolutionId, this.rules.kind, expected, { nextAttemptAt: this.retryAt(Math.max(1, expected.attempts)), lastCode: code }, this.deps.clock())
      .catch(() => false);
    return "failed";
  }

  private retryAt(attempt: number): Date {
    return new Date(this.deps.clock().getTime() + this.delayAfter(attempt));
  }

  /**
   * When to look again after a refusal: the attempts' backoff, or half the
   * action's age when that is longer (up to the most), so a refusal met before
   * anything was claimed (a short bond, say) still waits longer each time.
   */
  private backoffAt(action: WarrantyAction): Date {
    const now = this.deps.clock().getTime();
    const byAge = Math.min(Math.max(0, now - action.createdAt.getTime()) / 2, this.backoff.maxMs);
    return new Date(now + Math.max(this.delayAfter(Math.max(1, action.attempts)), byAge));
  }
}

/**
 * A run's context: the server's time, the chain's head time, and each
 * release's registry entry read at most once. Undefined when the chain does
 * not answer (the run sends nothing then).
 */
export async function runContext(deps: Pick<ActionJobDeps, "chain" | "clock" | "logger">, kind: WarrantyActionKind): Promise<RunContext | undefined> {
  let head: Awaited<ReturnType<WarrantyChain["head"]>>;
  try {
    head = await deps.chain.head();
  } catch (error) {
    deps.logger.log("warn", "warranty.chain_failed", { kind, error: describeError(error) });
    return undefined;
  }
  const releases = new Map<Hex32, Promise<RegistryRelease>>();
  return {
    now: deps.clock(),
    chainNow: chainSeconds(head.timestamp),
    release(releaseDigest) {
      let entry = releases.get(releaseDigest);
      if (entry === undefined) {
        entry = deps.chain.release(releaseDigest);
        // A failed read is not remembered: the next action of the release asks again.
        entry.catch(() => releases.delete(releaseDigest));
        releases.set(releaseDigest, entry);
      }
      return entry;
    },
  };
}

/** A head block's timestamp in Unix seconds: the registry's clock. */
const chainSeconds = (timestamp: Date): bigint => BigInt(Math.floor(timestamp.getTime() / 1000));

/** Why a release's warranties are never signed for: not registered, deactivated, or registered with other roles. */
export const RELEASE_NOT_REGISTERED = "RELEASE_NOT_REGISTERED";
export const RELEASE_INACTIVE = "RELEASE_INACTIVE";
export const RELEASE_ROLES_MISMATCH = "RELEASE_ROLES_MISMATCH";

/**
 * Whether the registry's entry for a release names this server's provider and
 * evaluator: checked on chain before anything is signed for it. A code when
 * it does not; `requireActive` also refuses a deactivated release (for
 * activations: existing warranties keep running after a deactivation).
 */
export function releaseProblem(release: RegistryRelease, chain: Pick<WarrantyChain, "provider" | "evaluator">, requireActive: boolean): string | undefined {
  if (release.provider === "0x0000000000000000000000000000000000000000") return RELEASE_NOT_REGISTERED;
  if (release.provider !== chain.provider || release.evaluator !== chain.evaluator) return RELEASE_ROLES_MISMATCH;
  if (requireActive && !release.active) return RELEASE_INACTIVE;
  return undefined;
}
