import { type Address, type Hex32, VERDICT_FAILED, VERDICT_PASSED, WarrantyView, type WarrantyState } from "@lemma/core";

import type { LemmaStore, RegistryEventRow } from "../persistence.js";
import type { RegistrySnapshot } from "./outcomes.js";

/** What the server's routes read about warranties: the view of one, and the engine in force. From memory and the store; never the chain. */
export interface WarrantyReads {
  /** The warranty view of a resolution (`ResolutionView.warranty`). */
  forResolution(resolutionId: Hex32): Promise<WarrantyView>;
  /** The compatibility engine the registry records into now (`StatusView.chain.engine`), or null. */
  engine(): Address | null;
}

const FEEDBACK_STATES: ReadonlySet<WarrantyState> = new Set(["passed", "failed", "refunded"]);

/**
 * `ResolutionView.warranty` from the indexed registry events, the only
 * source of chain facts, so an action anyone relayed shows up too:
 *
 * - activated (an indexed `ResolutionActivated`): `active`, then `passed`,
 *   `failed` (credit outstanding), `refunded` (a `CreditWithdrawn`) or `void`
 *   by the indexed `OutcomeFinalized`'s verdict, or `expired`; with the
 *   activation's amount, the claim deadline in force (the one set at
 *   activation plus every second the registry was paused while the warranty
 *   ran) and each event's transaction hash;
 * - not activated: `pending` while a settled resolution bought with a claim
 *   waits for its activation, and `none` otherwise (no claim, not paid, or
 *   the activation was skipped or abandoned).
 *
 * `feedback` is the attester's posted feedback to the provider's agent about
 * the outcome (track F's `reputation_posts`). Nothing names the buyer, the
 * payer, the claim or the payment reference.
 */
export class WarrantyViews implements WarrantyReads {
  constructor(
    private readonly deps: {
      readonly store: Pick<LemmaStore, "listRegistryEvents" | "getResolution" | "getWarrantyAction" | "getReputationPost">;
      readonly snapshot: RegistrySnapshot;
      readonly clock: () => Date;
    },
  ) {}

  async forResolution(resolutionId: Hex32): Promise<WarrantyView> {
    const { store } = this.deps;
    const events = await store.listRegistryEvents({ resolutionId }, 16);
    const first = (name: RegistryEventRow["name"]) => events.find((e) => e.name === name);
    const activation = first("ResolutionActivated");
    if (activation === undefined) return WarrantyView.parse({ ...EMPTY, state: await this.waiting(resolutionId) });
    const finalized = first("OutcomeFinalized");
    const expired = first("ResolutionExpired");
    const withdrawn = first("CreditWithdrawn");
    const state: WarrantyState =
      finalized !== undefined
        ? finalized.verdict === VERDICT_PASSED
          ? "passed"
          : finalized.verdict === VERDICT_FAILED
            ? withdrawn === undefined
              ? "failed"
              : "refunded"
            : "void"
        : expired !== undefined
          ? "expired"
          : "active";
    const ended = finalized ?? expired;
    const nowSeconds = BigInt(Math.floor(this.deps.clock().getTime() / 1000));
    const deadline = (activation.claimDeadline ?? 0n) + this.deps.snapshot.pausedSecondsAfter(activation, nowSeconds, ended);
    const post = FEEDBACK_STATES.has(state) ? await store.getReputationPost(resolutionId, "provider") : undefined;
    return WarrantyView.parse({
      state,
      amount: activation.amount,
      claimDeadline: new Date(Number(deadline) * 1000).toISOString(),
      activation: activation.txHash,
      outcome: finalized?.txHash ?? null,
      expiry: expired?.txHash ?? null,
      withdrawal: withdrawn?.txHash ?? null,
      feedback: post?.state === "posted" ? post.txHash : null,
    });
  }

  engine(): Address | null {
    return this.deps.snapshot.engine();
  }

  /** A warranty not activated: pending while its activation is on its way, none when there is none to come. */
  private async waiting(resolutionId: Hex32): Promise<"pending" | "none"> {
    const row = await this.deps.store.getResolution(resolutionId);
    if (row?.state !== "settled" || row.claimHash === null) return "none";
    const action = await this.deps.store.getWarrantyAction(resolutionId, "activate");
    return action?.state === "skipped" || action?.state === "abandoned" ? "none" : "pending";
  }
}

const EMPTY = { amount: null, claimDeadline: null, activation: null, outcome: null, expiry: null, withdrawal: null, feedback: null };
