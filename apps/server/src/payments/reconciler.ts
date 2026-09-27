import type { Hex32 } from "@lemma/core";

import { describeError } from "../errors.js";
import type { Logger } from "../log.js";
import type { ResolutionRow, UnsettledCursor } from "../persistence.js";
import type { ResolutionService } from "../service.js";
import type { ChainHead, PaymentChain } from "./chain.js";

/** How often the reconciler runs. */
export const RECONCILE_INTERVAL_MS = 60_000;
/**
 * A row is looked at only this long after its authorization's `validBefore`
 * by this server's clock, which leaves a late settlement time to land and its
 * log time to be indexed. Whether the window has really closed is then judged
 * by the chain's clock (the head block's timestamp), never by this one.
 */
export const RECONCILE_GRACE_MS = 2 * 60_000;
/** The longest a row that stays undecided waits before it is looked at again. */
export const RECONCILE_MAX_BACKOFF_MS = 60 * 60_000;
/** Log searches start this long before the authorization could first have been signed. */
const SEARCH_MARGIN_MS = 10 * 60_000;
/** Rows read per store query while a run pages through the unsettled ones. */
const PAGE_SIZE = 100;

export interface ReconcileReport {
  /** Rows settled from an AuthorizationUsed log whose transaction paid the quoted terms. */
  readonly settled: number;
  /** Rows expired: the authorization went unused, the buyer canceled it, or its transaction paid other terms. */
  readonly expired: number;
  /** Rows left for a later run: the chain has not passed their window yet, or used but no log found yet. */
  readonly waiting: number;
  /** Rows the chain (or the store) could not be asked about. */
  readonly failed: number;
  /** Rows not looked at this run: an earlier run could not decide them, and their next look is later. */
  readonly deferred: number;
  /**
   * Rows judged whose commit or expiry changed nothing: the row moved on
   * meanwhile (the payment hook settled it, say), or the store refused the
   * change. One that is still unsettled is looked at again after a backoff.
   */
  readonly unchanged: number;
}

/** The report while a run fills it in. */
type Tally = { -readonly [K in keyof ReconcileReport]: number };

/**
 * Settles the rows whose paid response was lost or whose settlement
 * outlived its call, and frees the rows whose payment never happened. Every
 * minute, for each `prepared` row whose authorization window closed
 * (`listUnsettled`, with a grace period), it reads USDC's
 * `authorizationState(payer, nonce)` at the chain's head block:
 *
 * - used, with an `AuthorizationUsed` log, by a transaction that paid the
 *   row's quoted terms (USDC's Transfer right after that log moved exactly
 *   the quoted amount from the payer to the quoted payee): it commits the row
 *   with that transaction (one transaction may have used several rows'
 *   authorizations, and settles each of them);
 * - used by a transaction that moved anything else (the buyer can sign the
 *   nonce into another authorization of their own): the quoted payment can
 *   never land, so the row expires, logged as `reconcile.transfer_mismatch`,
 *   and is never committed;
 * - used, with an `AuthorizationCanceled` log: the buyer canceled it, so no
 *   transfer can happen and the row expires;
 * - unused at a block at or past the window's end: USDC refuses it in every
 *   later block, so the row expires and a new payment may re-arm it.
 *
 * The window is judged by the chain's clock, not this server's: while the
 * head block (as the RPC serves it) is still inside a row's window, the row
 * waits, so a lagging RPC node can never make a payment that still lands
 * look unused. `commit` and `expire` only land on a row that still holds the
 * nonce judged, so a decision never touches a re-armed row.
 *
 * A run pages through every unsettled row, oldest first, and asks the chain
 * about at most `batch` of them. A row is decided only when this run settled
 * or expired it. Any other row (no log found, a failed read, or a commit or
 * expiry that changed nothing) is looked at again after a backoff that
 * doubles from one interval up to an hour, so rows that stay unsettled, for
 * whatever reason, never take a run's whole batch from newer ones; a row that
 * left the unsettled set is simply not listed again. The backoff is kept in
 * memory: after a restart each such row is looked at once more. Chain reads
 * go through the injected `PaymentChain`; nothing here is on a buyer's
 * request path.
 */
export class SettlementReconciler {
  private running = false;
  private readonly backoff = new Map<string, { readonly attempts: number; readonly next: number }>();

  constructor(
    private readonly deps: {
      readonly service: ResolutionService;
      readonly chain: PaymentChain;
      readonly clock: () => Date;
      readonly logger: Logger;
      readonly graceMs?: number;
      /** The most rows asked about on chain in one run (default 100). */
      readonly batch?: number;
    },
  ) {}

  async runOnce(): Promise<ReconcileReport> {
    const { service, chain, logger } = this.deps;
    const now = this.deps.clock();
    const batch = this.deps.batch ?? 100;
    const before = new Date(now.getTime() - (this.deps.graceMs ?? RECONCILE_GRACE_MS));
    const report: Tally = { settled: 0, expired: 0, waiting: 0, failed: 0, deferred: 0, unchanged: 0 };
    const seen = new Set<string>();
    let head: ChainHead | undefined;
    let asked = 0;
    let scannedAll = true;
    let after: UnsettledCursor | undefined;
    scan: for (;;) {
      const page = await service.listUnsettled(before, PAGE_SIZE, after);
      for (const row of page) {
        const key = backoffKey(row);
        seen.add(key);
        if ((this.backoff.get(key)?.next ?? 0) > now.getTime()) {
          report.deferred++;
          continue;
        }
        if (asked >= batch) {
          scannedAll = false;
          break scan;
        }
        if (head === undefined) {
          try {
            head = await chain.head();
          } catch (error) {
            logger.log("warn", "reconcile.chain_failed", { error: describeError(error) });
            report.failed++;
            scannedAll = false;
            break scan;
          }
        }
        // USDC accepts the authorization in any block before validBefore: until the head is past it, "unused" is not final.
        if (head.timestamp.getTime() < row.validBefore.getTime()) {
          report.waiting++;
          continue;
        }
        asked++;
        const decided = await this.judge(row, head, report);
        if (decided) this.backoff.delete(key);
        else this.defer(key, now);
      }
      const last = page.at(-1);
      if (page.length < PAGE_SIZE || last === undefined) break;
      after = { validBefore: last.validBefore, resolutionId: last.resolutionId };
    }
    // Forget rows that left the unsettled set (settled by the hook, say), once a run has seen all of it.
    if (scannedAll) for (const key of this.backoff.keys()) if (!seen.has(key)) this.backoff.delete(key);
    if (seen.size > 0) logger.log("info", "reconcile.done", report);
    return report;
  }

  /** Reads one row's authorization on chain and acts on it; true only when this run settled or expired the row. */
  private async judge(row: ResolutionRow, head: ChainHead, report: Tally): Promise<boolean> {
    const { service, chain, logger } = this.deps;
    const nonce = row.nonce as Hex32;
    try {
      // Awaited here, so a store failure while expiring is caught below like any other.
      if (!(await chain.authorizationUsed(row.payer, nonce, head.number))) return await this.expire(row, report);
      const from = new Date(row.validBefore.getTime() - row.resolution.terms.maxTimeoutSeconds * 1000 - SEARCH_MARGIN_MS);
      const outcome = await chain.authorizationOutcome(row.payer, nonce, row.resolution.terms, { from });
      if (outcome.kind === "canceled") return await this.expire(row, report);
      if (outcome.kind === "mismatched") {
        // Spent on a transfer that did not pay the quoted terms, so the payment can never land.
        logger.log("warn", "reconcile.transfer_mismatch", { resolutionId: row.resolutionId });
        return await this.expire(row, report);
      }
      if (outcome.kind === "unknown") {
        logger.log("warn", "reconcile.log_not_found", { resolutionId: row.resolutionId });
        report.waiting++;
        return false;
      }
      const committed = await service.commit(row.resolutionId, { nonce: row.nonce, settlementRef: outcome.transaction });
      if (committed === "COMMITTED") {
        report.settled++;
        return true;
      }
      if (committed === "FAILED") {
        report.failed++;
        return false;
      }
      return this.unchanged(row, "commit", report);
    } catch (error) {
      logger.log("warn", "reconcile.chain_failed", { resolutionId: row.resolutionId, error: describeError(error) });
      report.failed++;
      return false;
    }
  }

  private async expire(row: ResolutionRow, report: Tally): Promise<boolean> {
    if (!(await this.deps.service.expire(row.resolutionId, row.nonce))) return this.unchanged(row, "expire", report);
    report.expired++;
    return true;
  }

  /** A judged row the store did not change: counted and backed off, never taken as decided, so it cannot come back every run. */
  private unchanged(row: ResolutionRow, action: "commit" | "expire", report: Tally): false {
    this.deps.logger.log("warn", "reconcile.unchanged", { resolutionId: row.resolutionId, action });
    report.unchanged++;
    return false;
  }

  /** The next look at an undecided row: one interval after its first failure, doubling up to an hour. */
  private defer(key: string, now: Date): void {
    const attempts = (this.backoff.get(key)?.attempts ?? 0) + 1;
    const delay = Math.min(RECONCILE_INTERVAL_MS * 2 ** Math.min(attempts - 1, 20), RECONCILE_MAX_BACKOFF_MS);
    this.backoff.set(key, { attempts, next: now.getTime() + delay });
  }

  /** Runs now and then every `intervalMs`, one run at a time; returns a stop function. */
  start(intervalMs: number = RECONCILE_INTERVAL_MS): () => void {
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.runOnce();
      } catch (error) {
        this.deps.logger.log("warn", "reconcile.failed", { error: describeError(error) });
      } finally {
        this.running = false;
      }
    };
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref();
    void tick();
    return () => clearInterval(timer);
  }
}

/** A row's authorization: a re-armed row (same resolution and nonce, a new window) starts without backoff. */
const backoffKey = (row: ResolutionRow) => `${row.resolutionId}:${row.nonce}:${row.validBefore.getTime()}`;
