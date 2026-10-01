import {
  type Address,
  AdoptionReceipt,
  AgentId,
  Hex32,
  type PatchBundle,
  type PaymentTerms,
  type Preview,
  Resolution,
  type ResolutionDelivery,
  adoptionReceiptDigest,
  bundleDigest,
  deriveResolutionId,
} from "@lemma/core";

import { z } from "zod";

import { describeError, safeStore } from "./errors.js";
import type { Logger } from "./log.js";
import type { LemmaStore, ResolutionRow, UnsettledCursor } from "./persistence.js";
import type { ResolutionReader } from "./store.js";

export type QuoteResult =
  | { readonly ok: true; readonly terms: PaymentTerms; readonly preview: Preview }
  | { readonly ok: false; readonly reason: "NOT_FOUND" | "NO_OFFER" | "QUOTE_EXPIRED" };

export type PrepareResult =
  | { readonly ok: true; readonly resolution: Resolution; readonly bundle: PatchBundle }
  | { readonly ok: false; readonly reason: "NOT_FOUND" | "NO_OFFER" | "QUOTE_EXPIRED" | "IN_FLIGHT" | "ALREADY_SETTLED" | "PAYMENT_REUSED" | "PAYLOAD_MISSING" };

/** What the payment work passes to `prepare`, taken from the verified x402 payload, never from tool arguments. */
export interface VerifiedPayment {
  readonly payer: Address;
  /** The EIP-3009 authorization nonce, so the reconciler can check it on chain. Compared case-insensitively. */
  readonly nonce: string;
  /** The authorization's `validBefore`. */
  readonly validBefore: Date;
}

/**
 * What `commit` did: `COMMITTED` settled the row; `UNCHANGED` found no row
 * to settle (none unsettled with this nonce: already settled, say); `FAILED`
 * could not reach the store (logged, left for the reconciler).
 */
export type CommitResult = "COMMITTED" | "UNCHANGED" | "FAILED";

/** What the payment work passes to `commit` once settlement succeeded. */
export interface Settlement {
  /** The nonce of the authorization that settled, so a stale settlement never lands on a re-armed row. */
  readonly nonce: string;
  /**
   * The transaction that used the authorization. An authorization settles one
   * resolution, once; one transaction may use several authorizations (anyone
   * may submit them), so it may settle several resolutions, each paid.
   */
  readonly settlementRef: string;
}

/**
 * ACCEPTED and DUPLICATE are final. NOT_SETTLED and TOO_EARLY (a `recordedAt`
 * ahead of the server's clock) are worth retrying later. UNKNOWN_RESOLUTION and
 * MISMATCH mean the receipt can never be accepted.
 */
export type ReceiptResult = "ACCEPTED" | "DUPLICATE" | "NOT_SETTLED" | "TOO_EARLY" | "UNKNOWN_RESOLUTION" | "MISMATCH";

/**
 * A receipt as the buyer's bridge submits it: the receipt, and the preview id
 * it bought. The preview id is the recovery secret, known only to the buyer's
 * bridge, so it proves the submitter is the buyer. A resolution id is public
 * and proves nothing. `agentId` is the buyer's ERC-8004 agent, when its bridge
 * opted in (LEMMA_AGENT_ID): it is stored with the receipt, and the attester
 * gives that agent feedback on the outcome only if the buyer's address controls it.
 */
export const ReceiptSubmission = z.strictObject({ receipt: AdoptionReceipt, previewId: Hex32, agentId: AgentId.optional() });

export type ReceiptSubmission = z.infer<typeof ReceiptSubmission>;

/** How far a receipt's `recordedAt` may disagree with the server's clock, either way. */
export const RECEIPT_CLOCK_SKEW_MS = 5 * 60_000;

/** Normalized so the same authorization cannot pass as two by changing case. */
const normalizeNonce = (nonce: string) => nonce.toLowerCase();

/** The UTC day of an ISO timestamp (`2026-10-01T12:00:03.123Z` is `2026-10-01`). */
const utcDay = (iso: string) => new Date(iso).toISOString().slice(0, 10);

/**
 * What anyone may see about a resolution: no preview id (the recovery secret), no buyer, no bundle, and no time
 * finer than the day it was created (core `ResolutionView.createdOn`), because a warranted resolution's id is
 * public on chain and a precise time would point at the settlement that paid for it.
 */
export interface PublicResolution {
  readonly resolutionId: Hex32;
  readonly state: ResolutionRow["state"];
  readonly release: Resolution["release"];
  readonly payloadDigest: Hex32;
  readonly terms: PaymentTerms;
  /** The UTC day, `YYYY-MM-DD`. */
  readonly createdOn: string;
  readonly receipt: { readonly outcome: AdoptionReceipt["outcome"]; readonly verified: boolean } | null;
}

/**
 * The seam the payment work wraps x402 around (docs/architecture.md).
 *
 * - `quote` gives the exact terms of a stored offer.
 * - `prepare` runs inside the paid tool's handler, before settlement. It writes
 *   one `prepared` row keyed by `deriveResolutionId(previewId, payer)` with a
 *   single conditional insert. A second payment for the same resolution sees
 *   IN_FLIGHT or ALREADY_SETTLED, and the wrapper answers with `isError`, which
 *   makes x402 cancel that settlement: no double charge.
 *   One authorization (payer and nonce) backs one resolution only: a second
 *   resolution paid with it gets PAYMENT_REUSED.
 * - `commit` runs after settlement and only changes state, for the
 *   authorization that settled, and answers whether it did (`CommitResult`).
 *   It never throws, because a throw there would tell a buyer who already paid
 *   that settlement failed; failures are logged and left to the reconciler
 *   (`listUnsettled`, `expire`).
 * - `expire` takes the nonce the reconciler judged, and only expires a row that
 *   still holds it after its window closed.
 * - `recover` (free tool) returns only settled resolutions.
 *
 * The payment path (`payments/`) drives it: the paid tool's handler calls
 * `prepare`, x402's settlement hook calls `commit`, and the settlement
 * reconciler calls `listUnsettled`, `commit` and `expire`.
 *
 * A store failure rejects with a `StoreError` that carries only the error's
 * name and code (never SQL, parameters or a connection string), so the
 * payment work can log it as it is.
 */
export class ResolutionService implements ResolutionReader {
  private readonly store: LemmaStore;

  constructor(
    store: LemmaStore,
    private readonly clock: () => Date,
    private readonly logger: Logger,
  ) {
    this.store = safeStore(store);
  }

  async quote(previewId: Hex32, now: Date = this.clock()): Promise<QuoteResult> {
    const preview = await this.store.getPreview(previewId);
    if (preview === undefined) return { ok: false, reason: "NOT_FOUND" };
    if (!("offer" in preview) || preview.offer === null) return { ok: false, reason: "NO_OFFER" };
    if (now.getTime() >= Date.parse(preview.offer.validUntil)) return { ok: false, reason: "QUOTE_EXPIRED" };
    return { ok: true, terms: preview.offer.terms, preview };
  }

  /**
   * `claimHash` is the buyer's warranty credit commitment from the paid call
   * (core `BuyInput`); it is stored with the row, and a re-armed row takes the
   * new payment's one.
   */
  async prepare(previewId: Hex32, payment: VerifiedPayment, now: Date = this.clock(), claimHash: Hex32 | null = null): Promise<PrepareResult> {
    const quote = await this.quote(previewId, now);
    if (!quote.ok) return quote;
    const preview = quote.preview;
    if (!("release" in preview)) return { ok: false, reason: "NO_OFFER" };
    const release = await this.store.getRelease(preview.release.releaseDigest);
    const bundle = release === undefined ? undefined : await this.store.getBundle(release.payloadDigest);
    if (release === undefined || bundle === undefined || bundleDigest(bundle) !== release.payloadDigest) {
      this.logger.log("error", "prepare.payload_missing", { releaseDigest: preview.release.releaseDigest });
      return { ok: false, reason: "PAYLOAD_MISSING" };
    }
    const nonce = normalizeNonce(payment.nonce);
    const resolutionId = deriveResolutionId(previewId, payment.payer);
    const resolution = Resolution.parse({
      schemaVersion: "1",
      resolutionId,
      previewId,
      release: preview.release,
      profileDigest: preview.profileDigest,
      payloadDigest: release.payloadDigest,
      buyer: payment.payer,
      terms: quote.terms,
      createdAt: now.toISOString(),
    });
    const row: ResolutionRow = { resolutionId, previewId, payer: payment.payer, state: "prepared", nonce, validBefore: payment.validBefore, settlementRef: null, claimHash, resolution };
    if (await this.store.insertPrepared(row, now)) return { ok: true, resolution, bundle };

    const existing = await this.store.getResolution(resolutionId);
    // Nothing under this id, so the insert met another resolution's authorization.
    if (existing === undefined) return { ok: false, reason: "PAYMENT_REUSED" };
    if (existing.state === "settled") return { ok: false, reason: "ALREADY_SETTLED" };
    if (existing.state === "expired") {
      const rearmed = await this.store.rearmExpired(resolutionId, nonce, payment.validBefore, now, claimHash);
      if (rearmed === "REARMED") return { ok: true, resolution: existing.resolution, bundle };
      if (rearmed === "PAYMENT_REUSED") return { ok: false, reason: "PAYMENT_REUSED" };
    }
    const current = await this.store.getResolution(resolutionId);
    return { ok: false, reason: current?.state === "settled" ? "ALREADY_SETTLED" : "IN_FLIGHT" };
  }

  /** Records settlement by the authorization that settled, and says whether it did. Never throws. */
  async commit(resolutionId: Hex32, settlement: Settlement): Promise<CommitResult> {
    try {
      const changed = await this.store.markSettled(resolutionId, normalizeNonce(settlement.nonce), settlement.settlementRef, this.clock());
      if (changed) return "COMMITTED";
      this.logger.log("warn", "commit.no_change", { resolutionId });
      return "UNCHANGED";
    } catch (error) {
      this.logger.log("error", "commit.failed", { resolutionId, error: describeError(error) });
      return "FAILED";
    }
  }

  /**
   * Prepared rows whose authorization ended before `before`, oldest window
   * first, after `after` when given: the payment reconciler pages through
   * them and checks each on chain.
   */
  listUnsettled(before: Date, limit = 100, after?: UnsettledCursor): Promise<ResolutionRow[]> {
    return this.store.listUnsettled(before, limit, after);
  }

  /**
   * Called by the reconciler once the authorization it checked (`nonce`, from
   * `listUnsettled`) can no longer settle. False when the row has moved on:
   * settled, re-armed with another authorization, or its window still open.
   */
  expire(resolutionId: Hex32, nonce: string): Promise<boolean> {
    return this.store.markExpired(resolutionId, normalizeNonce(nonce), this.clock());
  }

  async recover(previewId: Hex32, buyer: Address): Promise<ResolutionDelivery | "IN_FLIGHT" | "NOT_FOUND"> {
    const row = await this.store.getResolution(deriveResolutionId(previewId, buyer));
    if (row === undefined || row.state === "expired") return "NOT_FOUND";
    if (row.state === "prepared") return "IN_FLIGHT";
    const bundle = await this.store.getBundle(row.resolution.payloadDigest);
    if (bundle === undefined) {
      this.logger.log("error", "recover.payload_missing", { resolutionId: row.resolutionId });
      return "NOT_FOUND";
    }
    return { resolution: row.resolution, bundle };
  }

  /**
   * Accepts the buyer's adoption receipt for a settled resolution. Only the
   * holder of the preview id (the buyer's bridge) can submit it, so nobody
   * else can take the resolution's one receipt slot. The first accepted
   * receipt wins, signed or not; its signature is checked later against the
   * resolution's buyer by the receipt verifier (`payments/receipts.ts`), and
   * until then it counts for nothing (`verified: false`). A resolution whose
   * preview id does not match is answered as unknown, so the answer confirms
   * nothing to anyone else.
   */
  async acceptReceipt(submission: ReceiptSubmission): Promise<ReceiptResult> {
    const { receipt, previewId, agentId } = ReceiptSubmission.parse(submission);
    const row = await this.store.getResolution(receipt.resolutionId);
    if (row === undefined || row.previewId !== previewId) return "UNKNOWN_RESOLUTION";
    if (row.state !== "settled") return "NOT_SETTLED";
    const now = this.clock();
    const recordedAt = Date.parse(receipt.recordedAt);
    // Clocks disagree both ways: a buyer clock running slow may date a real receipt a little before the resolution.
    if (recordedAt < Date.parse(row.resolution.createdAt) - RECEIPT_CLOCK_SKEW_MS) return "MISMATCH";
    // A buyer clock running fast: the signed receipt stays valid, so the bridge keeps it and sends it again later.
    if (recordedAt > now.getTime() + RECEIPT_CLOCK_SKEW_MS) return "TOO_EARLY";
    return (await this.store.insertReceipt(receipt, adoptionReceiptDigest(receipt), now, agentId ?? null)) ? "ACCEPTED" : "DUPLICATE";
  }

  async publicResolution(resolutionId: Hex32): Promise<PublicResolution | undefined> {
    const row = await this.store.getResolution(resolutionId);
    if (row === undefined) return undefined;
    const receipt = await this.store.getReceipt(resolutionId);
    const r = row.resolution;
    return {
      resolutionId: row.resolutionId,
      state: row.state,
      release: r.release,
      payloadDigest: r.payloadDigest,
      terms: r.terms,
      createdOn: utcDay(r.createdAt),
      receipt: receipt === undefined ? null : { outcome: receipt.receipt.outcome, verified: receipt.verified },
    };
  }
}
