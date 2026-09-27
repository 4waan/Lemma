import { randomBytes } from "node:crypto";

import { type Hex32, type WarrantyActionRef, WarrantyVoucher } from "@lemma/core";

import { describeError } from "../errors.js";
import type { NewWarrantyAction, WarrantyAction } from "../persistence.js";
import {
  type ActionJobDeps,
  type ActionReport,
  type ActionRules,
  ActionSender,
  type Decision,
  RELEASE_INACTIVE,
  RELEASE_NOT_REGISTERED,
  RELEASE_ROLES_MISMATCH,
  type RunContext,
  type SettledDecision,
  emptyReport,
  releaseProblem,
  runContext,
} from "./actions.js";
import type { RegistryResolution, RegistryRevert, WarrantyChain } from "./chain.js";
import { type Jitter, cryptoJitter, runEvery } from "./loop.js";

/** How often the outbox jobs run. */
export const ACTIONS_INTERVAL_MS = 30_000;
/** A voucher is signed to be submitted within this many seconds of the chain's clock (`activateBy`). */
export const ACTIVATION_WINDOW_SECONDS = 900;
/**
 * A signed deadline this close to the chain's clock is signed again before a
 * send: longer than the send's own deadline, so a voucher or outcome never
 * reaches the registry already expired.
 */
export const SIGN_MARGIN_SECONDS = 180;
/** How long an activation keeps retrying while the release's bond is short, before it is abandoned. */
export const BOND_RETRY_MS = 24 * 3_600_000;
/** `WARRANTY_ACTIVATION_JITTER_SECONDS`'s default. */
export const DEFAULT_ACTIVATION_JITTER_SECONDS = 300;

/** Why an activation was closed without a voucher to send: a price the registry cannot reserve, say. */
export const NO_VOUCHER = "NO_VOUCHER";
/** The alert code of an activation abandoned after a day of a short bond. */
export const BOND_EXHAUSTED = "BOND_EXHAUSTED";

export interface ActivatorDeps extends ActionJobDeps {
  /**
   * `WARRANTY_ACTIVATION_JITTER_SECONDS`: each new activation waits a
   * uniformly random whole number of seconds up to this (from `jitter`,
   * `crypto.randomInt` by default), so activations do not line up with the
   * settlements that paid for them. 0 sends at once (tests, local runs).
   */
  readonly jitterSeconds: number;
  /** Makes a payment reference: 32 random bytes (`crypto.randomBytes` by default). */
  readonly paymentRef?: () => Hex32;
}

export interface ActivatorReport extends ActionReport {
  /** Activations written to the outbox this run. */
  readonly queued: number;
}

const randomRef = (): Hex32 => `0x${randomBytes(32).toString("hex")}`;

/**
 * Activates the warranty of every settled resolution bought with a claim,
 * on the registry, as the provider.
 *
 * Each run first writes one `activate` action per such resolution: its
 * voucher is the resolution's release digest and profile index, `amount`
 * the resolution's price (the warranty equals the price), a `paymentRef` of
 * 32 random bytes made once and kept in the action (never derived from the
 * payer, the nonce or the settlement, and one per resolution, so one
 * transaction that paid several resolutions still activates each), and the
 * resolution's `claimHash`. The action is due after a random delay of up to
 * `jitterSeconds`.
 *
 * Then it attempts the due ones (`ActionSender`'s discipline). Before signing
 * it checks on chain that the release is registered, active, and names this
 * provider and evaluator; otherwise the action is `skipped` with a code, and
 * nothing is signed. The provider signs the voucher with `activateBy` =
 * the chain's clock + 900 s, again (same `paymentRef`) whenever that has
 * come within `SIGN_MARGIN_SECONDS`, and sends it. A short bond
 * (`InsufficientAvailableBond`) backs off and retries for a day, then the
 * action is `abandoned` with the alert `warranty.bond_exhausted`.
 */
export class WarrantyActivator {
  private readonly sender: ActionSender;
  private readonly jitter: Jitter;

  constructor(private readonly deps: ActivatorDeps) {
    this.sender = new ActionSender(deps, activationRules(deps.chain, deps.logger));
    this.jitter = deps.jitter ?? cryptoJitter;
  }

  async runOnce(): Promise<ActivatorReport> {
    const queued = await this.discover();
    const report = emptyReport();
    const ctx = await runContext(this.deps, "activate");
    if (ctx !== undefined) await this.sender.sendDue(ctx, report);
    return { queued, ...report };
  }

  /** Writes an activation for each settled resolution with a claim that has none yet. */
  private async discover(): Promise<number> {
    const { store, logger } = this.deps;
    let queued = 0;
    try {
      for (const row of await store.listResolutionsToActivate(this.deps.batch ?? 25)) {
        const now = this.deps.clock();
        const dueAt = new Date(now.getTime() + this.jitter(Math.max(0, Math.floor(this.deps.jitterSeconds))) * 1000);
        const voucher = WarrantyVoucher.safeParse({
          schemaVersion: "1",
          resolutionId: row.resolutionId,
          releaseDigest: row.resolution.release.releaseDigest,
          profileIndex: row.resolution.release.profileIndex,
          amount: row.resolution.terms.amount,
          paymentRef: (this.deps.paymentRef ?? randomRef)(),
          claimHash: row.claimHash,
          // Signed again at the send, from the chain's clock; set here so the stored voucher is complete.
          activateBy: Math.floor(dueAt.getTime() / 1000) + ACTIVATION_WINDOW_SECONDS,
        });
        const action: NewWarrantyAction = voucher.success
          ? { resolutionId: row.resolutionId, kind: "activate", payload: voucher.data, signature: null, state: "queued", nextAttemptAt: dueAt }
          : { resolutionId: row.resolutionId, kind: "activate", payload: ref(row.resolutionId), signature: null, state: "skipped", nextAttemptAt: now, lastCode: NO_VOUCHER };
        if (await store.insertWarrantyAction(action, now)) {
          queued++;
          if (!voucher.success) logger.log("warn", "warranty.skipped", { kind: "activate", resolutionId: row.resolutionId, code: NO_VOUCHER });
        }
      }
    } catch (error) {
      logger.log("warn", "warranty.outbox_failed", { kind: "activate", error: describeError(error) });
    }
    return queued;
  }

  /** Runs now and then every `intervalMs`, one run at a time; returns a stop function. */
  start(intervalMs: number = ACTIONS_INTERVAL_MS): () => void {
    return runEvery(intervalMs, () => this.runOnce(), this.deps.logger, "warranty.activator_failed");
  }
}

const ref = (resolutionId: Hex32): WarrantyActionRef => ({ schemaVersion: "1", resolutionId });

function activationRules(chain: WarrantyChain, logger: ActionJobDeps["logger"]): ActionRules {
  /** A short bond: retry for a day from when the activation was written, then give up loudly. */
  const bondShort = (action: WarrantyAction, ctx: RunContext, releaseDigest: Hex32): SettledDecision => {
    if (ctx.now.getTime() - action.createdAt.getTime() < BOND_RETRY_MS) return { kind: "backoff", code: "INSUFFICIENT_AVAILABLE_BOND" };
    logger.log("error", "warranty.bond_exhausted", { resolutionId: action.resolutionId, releaseDigest, code: BOND_EXHAUSTED });
    return { kind: "finish", state: "abandoned", code: BOND_EXHAUSTED };
  };

  return {
    kind: "activate",
    fn: "activateResolution",

    async prepare(action: WarrantyAction, resolution: RegistryResolution, ctx: RunContext): Promise<Decision> {
      // Activated already: by this job's earlier send, or by anyone who relayed the voucher.
      if (resolution.status !== "none") return { kind: "finish", state: "done", code: null };
      const parsed = WarrantyVoucher.safeParse(action.payload);
      if (!parsed.success) return { kind: "finish", state: "skipped", code: NO_VOUCHER };
      const voucher = parsed.data;
      const release = await ctx.release(voucher.releaseDigest);
      const problem = releaseProblem(release, chain, true);
      if (problem !== undefined) {
        logger.log("warn", "warranty.release_refused", { releaseDigest: voucher.releaseDigest, code: problem });
        return { kind: "finish", state: "skipped", code: problem };
      }
      if (release.available < BigInt(voucher.amount)) return bondShort(action, ctx, voucher.releaseDigest);
      // Signed again, with the same payment reference, when its deadline is near or the registry said it passed.
      const stale = action.signature === null || BigInt(voucher.activateBy) <= ctx.chainNow + BigInt(SIGN_MARGIN_SECONDS) || action.lastCode === "VOUCHER_EXPIRED";
      if (!stale) return { kind: "send", call: { fn: "activateResolution", voucher, signature: action.signature as `0x${string}` } };
      const signed: WarrantyVoucher = { ...voucher, activateBy: Number(ctx.chainNow) + ACTIVATION_WINDOW_SECONDS };
      const signature = await chain.signVoucher(signed);
      return { kind: "send", call: { fn: "activateResolution", voucher: signed, signature }, payload: signed, signature };
    },

    async onRevert(action: WarrantyAction, revert: RegistryRevert, ctx: RunContext): Promise<SettledDecision> {
      switch (revert.code) {
        case "RESOLUTION_ALREADY_EXISTS":
          return { kind: "finish", state: "done", code: null };
        case "VOUCHER_EXPIRED":
          return { kind: "wait", until: ctx.now, code: revert.code };
        case "INSUFFICIENT_AVAILABLE_BOND":
          return bondShort(action, ctx, (action.payload as WarrantyVoucher).releaseDigest);
        case "UNKNOWN_RELEASE":
          return { kind: "finish", state: "skipped", code: RELEASE_NOT_REGISTERED };
        case "RELEASE_NOT_ACTIVE":
          return { kind: "finish", state: "skipped", code: RELEASE_INACTIVE };
        case "INVALID_PROVIDER_SIGNATURE":
          return { kind: "finish", state: "skipped", code: RELEASE_ROLES_MISMATCH };
        case "PAYMENT_REF_ALREADY_USED":
        case "ZERO_AMOUNT":
        case "INVALID_VOUCHER":
          return { kind: "finish", state: "abandoned", code: revert.code };
        default:
          // A pause (ENFORCED_PAUSE) and anything unexpected: later.
          return { kind: "backoff", code: revert.code };
      }
    },
  };
}
