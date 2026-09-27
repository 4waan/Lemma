import type { CatalogIndex } from "@lemma/catalog";
import {
  Address,
  AdoptionReceipt,
  type AgentId,
  type CapabilityId,
  CapabilityRelease,
  Hex32,
  PatchBundle,
  Preview,
  Resolution,
  SignatureBytes,
  type WarrantyActionKind,
  WarrantyActionRef,
  type WarrantyActionState,
  WarrantyOutcome,
  WarrantyVoucher,
  WarrantyWithdrawal,
  canonicalize,
  fileDigest,
  isFinalActionState,
} from "@lemma/core";
import { z } from "zod";

import type { PreviewStore } from "./store.js";

export type ResolutionState = "prepared" | "settled" | "expired";

export interface ResolutionRow {
  readonly resolutionId: Hex32;
  readonly previewId: Hex32;
  readonly payer: Address;
  readonly state: ResolutionState;
  /** The payment authorization's nonce, so the reconciler can check it on chain. */
  readonly nonce: string;
  readonly validBefore: Date;
  readonly settlementRef: string | null;
  /**
   * The buyer's warranty credit commitment (core `warrantyClaimHash`), sent
   * with the paid call; null when the purchase carried none. The server never
   * learns the secret or the refund address behind it.
   */
  readonly claimHash: Hex32 | null;
  readonly resolution: Resolution;
}

/** A stored receipt the signature check has not reached a verdict on. */
export interface UncheckedReceipt {
  readonly receipt: AdoptionReceipt;
  readonly receiptDigest: Hex32;
}

export interface DemandBucket {
  readonly day: string;
  readonly bucket: string;
  /** Distinct salted profile digests. */
  readonly profiles: number;
  /** Distinct salted client addresses: a caller can make up profiles, but not as easily addresses. */
  readonly sources: number;
}

/** What re-arming an expired resolution did. */
export type RearmResult = "REARMED" | "NOT_EXPIRED" | "PAYMENT_REUSED";

/** Where a page of `listUnsettled` ended: the last row's window end and resolution id. */
export interface UnsettledCursor {
  readonly validBefore: Date;
  readonly resolutionId: Hex32;
}

/** The order `listUnsettled` pages in: by window end, then resolution id. */
export function compareUnsettled(a: UnsettledCursor, b: UnsettledCursor): number {
  const byTime = a.validBefore.getTime() - b.validBefore.getTime();
  if (byTime !== 0) return byTime;
  return a.resolutionId < b.resolutionId ? -1 : a.resolutionId > b.resolutionId ? 1 : 0;
}

/** A stored adoption receipt, with the ERC-8004 agent id its buyer opted in with (the outcome feed reads it). */
export interface StoredReceipt {
  readonly receipt: AdoptionReceipt;
  readonly verified: boolean;
  readonly buyerAgentId: AgentId | null;
}

/**
 * Who an ERC-8004 feedback is for: the provider's agent, or the buyer agent
 * that opted in. Its feedback file is served under `provider` or `buyer-agent`
 * (`evidencePath`).
 */
export type ReputationTarget = "provider" | "buyer";

/** `posted` and `skipped` are final; `pending` rows are attempted when due. */
export type ReputationPostState = "pending" | "posted" | "skipped";

/** One feedback the attester owes, as it is queued. */
export interface NewReputationPost {
  readonly resolutionId: Hex32;
  readonly target: ReputationTarget;
  readonly agentId: AgentId;
  /** `tag2`. */
  readonly capability: CapabilityId;
  /** 100 for a pass, 0 for a failure (valueDecimals 0). */
  readonly value: 0 | 100;
  readonly feedbackHash: Hex32;
  /** This feedback's own file (core `AdoptionFeedbackFile`), as the bytes served at its feedback URI; `feedbackHash` is their keccak256. */
  readonly evidence: string;
}

export interface ReputationPost extends NewReputationPost {
  readonly state: ReputationPostState;
  /** Sends begun. Above zero, the chain is searched for the feedback before any further send. */
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  /** The block (decimal) before the first send: where the chain search starts. */
  readonly fromBlock: string | null;
  readonly txHash: Hex32 | null;
  /** Why the row was skipped, or the last failure's code. */
  readonly note: string | null;
}

/** Fields the attester changes on a row, only while it is pending with the attempts it read. */
export interface ReputationPostChange {
  readonly state?: ReputationPostState;
  readonly attempts?: number;
  readonly nextAttemptAt?: Date;
  readonly fromBlock?: string;
  readonly txHash?: Hex32;
  readonly note?: string | null;
}

/**
 * What a warranty outbox action carries: a voucher to activate, an outcome to
 * finalize, a credit withdrawal to relay, or only its resolution (an expiry,
 * a withdrawal once it is over, or an action closed before it had anything to
 * carry). Stores keep it as canonical JSON and re-parse it with its core
 * schema on every read.
 */
export type WarrantyPayload = WarrantyVoucher | WarrantyOutcome | WarrantyWithdrawal | WarrantyActionRef;

const PAYLOAD_SCHEMAS = {
  activate: z.union([WarrantyVoucher, WarrantyActionRef]),
  finalize: z.union([WarrantyOutcome, WarrantyActionRef]),
  expire: WarrantyActionRef,
  withdraw: z.union([WarrantyWithdrawal, WarrantyActionRef]),
} as const satisfies Record<WarrantyActionKind, z.ZodType>;

/** Parses a payload for an action of `kind` on `resolutionId`; throws when it is not one, or names another resolution. */
export function parseWarrantyPayload(kind: WarrantyActionKind, resolutionId: Hex32, payload: unknown): WarrantyPayload {
  const parsed = PAYLOAD_SCHEMAS[kind].parse(payload) as WarrantyPayload;
  if (parsed.resolutionId !== resolutionId) throw new TypeError(`a ${kind} payload names another resolution`);
  return parsed;
}

/** A payload's stored form: its canonical JSON, after checking it fits the action. */
export function encodeWarrantyPayload(kind: WarrantyActionKind, resolutionId: Hex32, payload: WarrantyPayload): string {
  return canonicalize(parseWarrantyPayload(kind, resolutionId, payload));
}

export function decodeWarrantyPayload(kind: WarrantyActionKind, resolutionId: Hex32, body: string): WarrantyPayload {
  return parseWarrantyPayload(kind, resolutionId, JSON.parse(body));
}

/** An EIP-712 signature as stored with an action (core `SignatureBytes`), or null. */
export function checkSignature(signature: string | null): string | null {
  return signature === null ? null : SignatureBytes.parse(signature);
}

/** One warranty action as it is first written to the outbox. */
export interface NewWarrantyAction {
  readonly resolutionId: Hex32;
  readonly kind: WarrantyActionKind;
  readonly payload: WarrantyPayload;
  /** The EIP-712 signature over the payload (activate and finalize), null until signed. */
  readonly signature: string | null;
  /** Usually `queued` (due at `nextAttemptAt`) or `review` (waits for an operator); a final state closes it at once. */
  readonly state: WarrantyActionState;
  readonly nextAttemptAt: Date;
  /** Why it is in this state, when a code says more than the state (a skip's reason, say). */
  readonly lastCode?: string | null;
}

/**
 * A warranty outbox row: one per resolution and kind. `attempts` counts sends
 * begun; once it is above zero a transaction may be out, and the job reads
 * the recorded transaction's receipt and the registry's state before it ever
 * sends again.
 */
export interface WarrantyAction {
  readonly resolutionId: Hex32;
  readonly kind: WarrantyActionKind;
  readonly payload: WarrantyPayload;
  readonly signature: string | null;
  readonly state: WarrantyActionState;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  /** The last transaction sent for it, if any. */
  readonly txHash: Hex32 | null;
  readonly sentAt: Date | null;
  /** The last failure's code, or why it was skipped or abandoned. */
  readonly lastCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Fields a job changes on an action, only while it still has the state and attempts the job read. */
export interface WarrantyActionChange {
  readonly state?: WarrantyActionState;
  readonly payload?: WarrantyPayload;
  readonly signature?: string | null;
  readonly attempts?: number;
  readonly nextAttemptAt?: Date;
  readonly txHash?: Hex32 | null;
  readonly sentAt?: Date | null;
  readonly lastCode?: string | null;
}

/** What `updateWarrantyAction` compares before it changes a row. */
export interface WarrantyActionExpectation {
  readonly attempts: number;
  readonly state: WarrantyActionState;
}

/**
 * The warranty registry's events the indexer stores, in the registry's own
 * names. `Paused` and `Unpaused` are kept too: every second the registry is
 * paused moves each active warranty's claim deadline later.
 */
export const REGISTRY_EVENT_NAMES = ["ResolutionActivated", "OutcomeFinalized", "EngineRecordFailed", "ResolutionExpired", "CreditWithdrawn", "EngineSet", "Paused", "Unpaused"] as const;

export type RegistryEventName = (typeof REGISTRY_EVENT_NAMES)[number];

export function isRegistryEventName(name: string): name is RegistryEventName {
  return (REGISTRY_EVENT_NAMES as readonly string[]).includes(name);
}

/**
 * One registry log as the indexer stored it, with its block's timestamp.
 * Fields an event does not have are null: `resolutionId` for `EngineSet`,
 * `Paused` and `Unpaused`; `releaseDigest` except for `ResolutionActivated`,
 * `OutcomeFinalized` and `ResolutionExpired`; `profileIndex` and
 * `claimDeadline` (Unix seconds) for `ResolutionActivated`; `verdict`,
 * `weightBps` and `evidenceHash` for `OutcomeFinalized`; `amount` (atomic
 * USDC) for `ResolutionActivated`, `ResolutionExpired` and `CreditWithdrawn`;
 * `engine` (the new engine, zero when disabled) for `EngineSet`. The payment
 * reference of an activation is never stored.
 */
export interface RegistryEventRow {
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly txHash: Hex32;
  readonly blockTime: Date;
  readonly name: RegistryEventName;
  readonly resolutionId: Hex32 | null;
  readonly releaseDigest: Hex32 | null;
  readonly profileIndex: number | null;
  readonly verdict: number | null;
  readonly weightBps: number | null;
  readonly evidenceHash: Hex32 | null;
  readonly amount: string | null;
  readonly claimDeadline: bigint | null;
  readonly engine: Address | null;
}

/** Where a log sits in the chain: registry events are read and ordered by block, then log index. */
export interface EventPosition {
  readonly blockNumber: bigint;
  readonly logIndex: number;
}

export function compareEventPositions(a: EventPosition, b: EventPosition): number {
  return a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex;
}

/** Which stored registry events to list: after a position, of one resolution, of some names; all of them when empty. */
export interface RegistryEventQuery {
  readonly after?: EventPosition | undefined;
  readonly resolutionId?: Hex32 | undefined;
  readonly names?: readonly RegistryEventName[] | undefined;
}

/**
 * The wash-adoption damper's question: this payer's outcomes with a weight
 * above zero for one release digest and profile index, finalized (indexed
 * `OutcomeFinalized`, PASSED or FAILED) or in flight (an outbox finalization
 * not skipped or abandoned, not VOID), since `since`, other than `exclude`.
 */
export interface DamperQuery {
  readonly payer: Address;
  readonly releaseDigest: Hex32;
  readonly profileIndex: number;
  readonly since: Date;
  readonly exclude: Hex32;
}

/** Whether an in-flight finalization's payload counts for the damper: a PASSED or FAILED outcome with weight. */
export function countsForDamper(payload: WarrantyPayload): boolean {
  const outcome = WarrantyOutcome.safeParse(payload);
  return outcome.success && outcome.data.verdict !== "void" && outcome.data.weightBps > 0;
}

/** The outbox states a finalization counts for the damper in: not given up and not skipped. */
export const DAMPER_ACTION_STATES: readonly WarrantyActionState[] = ["review", "queued", "sent", "done"];

/**
 * Everything the server persists. `MemoryStore` serves development and tests;
 * `PgStore` (drizzle over postgres.js or PGlite) serves production. One
 * contract suite runs against both, so they cannot drift apart.
 */
export interface LemmaStore extends PreviewStore {
  /** Resolves when the store can answer a query; the status view reports a store that cannot. */
  ping(): Promise<void>;
  /** Upserts every release, bundle and the catalog snapshot; digests make this idempotent. */
  saveCatalog(index: CatalogIndex, now: Date): Promise<void>;
  getRelease(releaseDigest: Hex32): Promise<CapabilityRelease | undefined>;
  getBundle(payloadDigest: Hex32): Promise<PatchBundle | undefined>;

  /**
   * Inserts a prepared row; false when a row with this id already exists, or
   * when another row already holds this payer's authorization nonce (one
   * authorization can back one resolution only).
   */
  insertPrepared(row: ResolutionRow, now: Date): Promise<boolean>;
  /**
   * Re-arms an expired row with a new authorization (and the claim hash sent
   * with it), unless that authorization already backs another row.
   */
  rearmExpired(resolutionId: Hex32, nonce: string, validBefore: Date, now: Date, claimHash: Hex32 | null): Promise<RearmResult>;
  getResolution(resolutionId: Hex32): Promise<ResolutionRow | undefined>;
  /**
   * Marks a row settled by the authorization that settled it; false when there
   * is no such row, it is already settled, or its nonce is another
   * authorization's (a stale settlement must not land on a re-armed row).
   * `settlementRef` is the transaction that used the authorization; one
   * transaction may use several authorizations, so it may settle several rows.
   */
  markSettled(resolutionId: Hex32, nonce: string, settlementRef: string, now: Date): Promise<boolean>;
  /**
   * Marks a prepared row expired, only if it still holds the authorization the
   * reconciler judged and that authorization's window has closed; false
   * otherwise (a stale decision never lands on a re-armed row).
   */
  markExpired(resolutionId: Hex32, nonce: string, now: Date): Promise<boolean>;
  /**
   * Prepared rows whose authorization ended before `before`, oldest window
   * first (then by resolution id), starting after `after` when given, so a
   * caller can page through all of them.
   */
  listUnsettled(before: Date, limit: number, after?: UnsettledCursor): Promise<ResolutionRow[]>;

  /**
   * Stores a receipt, with the ERC-8004 agent id the buyer opted in with, if
   * any; false when one already exists for the resolution (first write wins).
   */
  insertReceipt(receipt: AdoptionReceipt, receiptDigest: Hex32, now: Date, buyerAgentId?: AgentId | null): Promise<boolean>;
  getReceipt(resolutionId: Hex32): Promise<StoredReceipt | undefined>;
  /** Receipts whose signature check has not reached a verdict yet, oldest first. */
  listUncheckedReceipts(limit: number): Promise<UncheckedReceipt[]>;
  /**
   * Records that the receipt's signature is the resolution buyer's: sets
   * `verified`. False unless the stored receipt has this digest and has no
   * verdict yet, so a verdict is never recorded twice or for another receipt.
   */
  markReceiptVerified(resolutionId: Hex32, receiptDigest: Hex32, now: Date): Promise<boolean>;
  /**
   * Records a verdict that leaves the receipt unverified (unsigned, or a
   * signature that is not the buyer's), so it is not checked again. Same
   * conditions as `markReceiptVerified`.
   */
  markReceiptChecked(resolutionId: Hex32, receiptDigest: Hex32, now: Date): Promise<boolean>;

  /** Queues feedback for the attester; a post already queued for its resolution and target is kept as it is. Returns how many were new. */
  enqueueReputationPosts(posts: readonly NewReputationPost[], now: Date): Promise<number>;
  /** Pending posts due at `now`, the longest waiting first. */
  dueReputationPosts(now: Date, limit: number): Promise<ReputationPost[]>;
  /** One post, with its feedback file: the evidence route serves the file from here. */
  getReputationPost(resolutionId: Hex32, target: ReputationTarget): Promise<ReputationPost | undefined>;
  /**
   * Applies `change` only while the post is pending and still has
   * `expectedAttempts`, so two attesters never both send the same attempt;
   * false when the row moved on.
   */
  updateReputationPost(resolutionId: Hex32, target: ReputationTarget, expectedAttempts: number, change: ReputationPostChange, now: Date): Promise<boolean>;

  /**
   * Adds one salted profile digest and one salted source to a bucket for its
   * day. A day that is already closed is not reopened: a late write is dropped.
   */
  recordDemand(day: string, bucket: string, profileDigest: Hex32, source: string): Promise<void>;
  /**
   * Collapses every open day before `today` into counts and discards its salt
   * and digests. Safe to run twice or concurrently: each digest is counted by
   * whichever close removes it.
   */
  closeDemandDaysBefore(today: string): Promise<number>;
  /** Closed-day buckets with at least `minProfiles` distinct profiles and as many distinct sources. */
  demandBuckets(minProfiles: number): Promise<DemandBucket[]>;

  /**
   * Deletes offer previews that expired before `before` unless a settled
   * resolution needs them, and resolutions that expired unpaid before then.
   */
  purgeExpiredOffers(before: Date): Promise<number>;

  /** Where the named chain reader goes on: the next block to read, or undefined before its first run. */
  getChainCursor(name: string): Promise<bigint | undefined>;
  /**
   * Stores `events` (each once: a (transaction, log index) already stored is
   * kept as it is) and moves the named cursor to `next`, in one step, only
   * while the cursor is still at `expected` (undefined for a cursor that does
   * not exist yet); false, changing nothing, when another reader moved it.
   */
  advanceChainCursor(name: string, expected: bigint | undefined, next: bigint, events: readonly RegistryEventRow[], now: Date): Promise<boolean>;
  /** Stored registry events that match `query`, in chain order (block, then log index). */
  listRegistryEvents(query: RegistryEventQuery, limit: number): Promise<RegistryEventRow[]>;

  /** Adds an outbox action; false when the resolution already has one of this kind (kept as it is). */
  insertWarrantyAction(action: NewWarrantyAction, now: Date): Promise<boolean>;
  getWarrantyAction(resolutionId: Hex32, kind: WarrantyActionKind): Promise<WarrantyAction | undefined>;
  /** Actions of `kind` to attempt at `now` (`queued` or `sent`, due), the longest waiting first. */
  dueWarrantyActions(kind: WarrantyActionKind, now: Date, limit: number): Promise<WarrantyAction[]>;
  /** Actions of a kind and state (each optional), oldest first. */
  listWarrantyActions(filter: { readonly kind?: WarrantyActionKind; readonly state?: WarrantyActionState }, limit: number): Promise<WarrantyAction[]>;
  /**
   * Applies `change` only while the action still has `expected` state and
   * attempts, so two jobs never both begin the same attempt; false when the
   * row moved on. A final state (done, skipped, abandoned) never changes.
   */
  updateWarrantyAction(resolutionId: Hex32, kind: WarrantyActionKind, expected: WarrantyActionExpectation, change: WarrantyActionChange, now: Date): Promise<boolean>;

  /** Settled resolutions bought with a claim that have no activation action yet, the longest settled first. */
  listResolutionsToActivate(limit: number): Promise<ResolutionRow[]>;
  /**
   * Indexed activations still active (no `OutcomeFinalized` or
   * `ResolutionExpired` indexed for them) whose receipt is verified and that
   * have no finalization action yet, in chain order.
   */
  listWarrantiesToEvaluate(limit: number): Promise<RegistryEventRow[]>;
  /**
   * Indexed activations still active whose claim deadline at activation is
   * before `before` (Unix seconds, the chain's clock), with no expiry action
   * and no finalization queued or sent, earliest deadline first. A pause may
   * have moved the deadline in force later: the expirer reads it on chain.
   */
  listWarrantiesToExpire(before: bigint, limit: number): Promise<RegistryEventRow[]>;
  /** How many of the payer's outcomes the damper counts (`DamperQuery`): distinct resolutions. */
  countDamperOutcomes(query: DamperQuery): Promise<number>;
}

/** The salted digest counted for distinct profiles or sources; the salt never leaves the store. */
export function saltedDigest(salt: string, value: string): Hex32 {
  return fileDigest(`${salt}:${value}`);
}

export const encode = (value: unknown): string => canonicalize(value);

export function decodePreview(body: string): Preview {
  return Preview.parse(JSON.parse(body));
}

export function decodeResolution(body: string): Resolution {
  return Resolution.parse(JSON.parse(body));
}

const postKey = (resolutionId: Hex32, target: ReputationTarget) => `${resolutionId}\n${target}`;

const actionKey = (resolutionId: Hex32, kind: WarrantyActionKind) => `${resolutionId}\n${kind}`;

/** A stored action as the memory store keeps it: the payload as canonical JSON, like a table row. */
type StoredAction = Omit<WarrantyAction, "payload"> & { readonly body: string };

const FINAL_EVENTS: ReadonlySet<RegistryEventName> = new Set(["OutcomeFinalized", "ResolutionExpired"]);

/** The most offers the memory store holds; beyond it, saving fails and the preview says so. */
export const MAX_MEMORY_OFFERS = 50_000;

/**
 * Process-memory store for development and tests. Offers are bounded: when the
 * store fills, expired offers nobody bought are swept, and past the cap a save
 * fails, so the preview answers with an error instead of the process growing
 * without limit.
 */
export class MemoryStore implements LemmaStore {
  private readonly releases = new Map<string, string>();
  private readonly bundles = new Map<string, string>();
  private readonly snapshots = new Map<string, string>();
  private readonly previews = new Map<string, { body: string; validUntil: Date }>();
  private readonly resolutions = new Map<string, ResolutionRow>();
  private readonly receipts = new Map<string, { body: string; digest: Hex32; verified: boolean; receivedAt: Date; checkedAt: Date | null; buyerAgentId: AgentId | null }>();
  private readonly posts = new Map<string, ReputationPost>();
  private readonly actions = new Map<string, StoredAction>();
  private readonly cursors = new Map<string, bigint>();
  /** Registry events in chain order, and the (transaction, log index) keys already stored. */
  private events: RegistryEventRow[] = [];
  private readonly eventKeys = new Set<string>();
  private readonly salts = new Map<string, string>();
  private readonly seen = new Map<string, { profiles: Set<string>; sources: Set<string> }>();
  private readonly daily = new Map<string, DemandBucket>();

  private readonly newSalt: () => string;
  private readonly clock: () => Date;
  private readonly capacity: number;

  constructor(options: { newSalt?: () => string; clock?: () => Date; capacity?: number } = {}) {
    this.newSalt = options.newSalt ?? (() => crypto.randomUUID());
    this.clock = options.clock ?? (() => new Date());
    this.capacity = options.capacity ?? MAX_MEMORY_OFFERS;
  }

  async ping(): Promise<void> {}

  async saveCatalog(index: CatalogIndex, _now?: Date): Promise<void> {
    for (const r of index.releases) {
      if (!this.releases.has(r.releaseDigest)) this.releases.set(r.releaseDigest, encode(r.release));
      if (!this.bundles.has(r.release.payloadDigest)) this.bundles.set(r.release.payloadDigest, encode(r.bundle));
    }
    if (!this.snapshots.has(index.catalogDigest)) this.snapshots.set(index.catalogDigest, encode(index.releases.map((r) => r.releaseDigest)));
  }

  async getRelease(releaseDigest: Hex32) {
    const body = this.releases.get(releaseDigest);
    return body === undefined ? undefined : CapabilityRelease.parse(JSON.parse(body));
  }

  async getBundle(payloadDigest: Hex32) {
    const body = this.bundles.get(payloadDigest);
    return body === undefined ? undefined : PatchBundle.parse(JSON.parse(body));
  }

  async saveOffer(preview: Preview): Promise<void> {
    if (!("offer" in preview) || preview.offer === null) throw new Error("only offer-bearing previews are stored");
    if (!this.previews.has(preview.previewId) && this.previews.size >= this.capacity) {
      await this.purgeExpiredOffers(this.clock());
      if (this.previews.size >= this.capacity) throw new Error("the preview store is full");
    }
    this.previews.set(preview.previewId, { body: encode(preview), validUntil: new Date(preview.offer.validUntil) });
  }

  /** Offers currently held. */
  get offerCount(): number {
    return this.previews.size;
  }

  async getPreview(previewId: Hex32) {
    const row = this.previews.get(previewId);
    return row === undefined ? undefined : decodePreview(row.body);
  }

  async insertPrepared(row: ResolutionRow, _now?: Date): Promise<boolean> {
    if (this.resolutions.has(row.resolutionId) || this.nonceHeld(row.payer, row.nonce, row.resolutionId)) return false;
    this.resolutions.set(row.resolutionId, { ...row, resolution: Resolution.parse(row.resolution) });
    return true;
  }

  async rearmExpired(resolutionId: Hex32, nonce: string, validBefore: Date, _now: Date, claimHash: Hex32 | null): Promise<RearmResult> {
    const row = this.resolutions.get(resolutionId);
    if (row?.state !== "expired") return "NOT_EXPIRED";
    if (this.nonceHeld(row.payer, nonce, resolutionId)) return "PAYMENT_REUSED";
    this.resolutions.set(resolutionId, { ...row, state: "prepared", nonce, validBefore, claimHash });
    return "REARMED";
  }

  private nonceHeld(payer: Address, nonce: string, except: Hex32): boolean {
    return [...this.resolutions.values()].some((r) => r.resolutionId !== except && r.payer === payer && r.nonce === nonce);
  }

  async getResolution(resolutionId: Hex32) {
    return this.resolutions.get(resolutionId);
  }

  async markSettled(resolutionId: Hex32, nonce: string, settlementRef: string, _now?: Date): Promise<boolean> {
    const row = this.resolutions.get(resolutionId);
    if (row === undefined || row.state === "settled" || row.nonce !== nonce) return false;
    this.resolutions.set(resolutionId, { ...row, state: "settled", settlementRef });
    return true;
  }

  async markExpired(resolutionId: Hex32, nonce: string, now: Date): Promise<boolean> {
    const row = this.resolutions.get(resolutionId);
    if (row?.state !== "prepared" || row.nonce !== nonce || row.validBefore >= now) return false;
    this.resolutions.set(resolutionId, { ...row, state: "expired" });
    return true;
  }

  async listUnsettled(before: Date, limit: number, after?: UnsettledCursor) {
    return [...this.resolutions.values()]
      .filter((r) => r.state === "prepared" && r.validBefore < before && (after === undefined || compareUnsettled(r, after) > 0))
      .sort(compareUnsettled)
      .slice(0, limit);
  }

  async insertReceipt(receipt: AdoptionReceipt, receiptDigest: Hex32, now: Date, buyerAgentId: AgentId | null = null): Promise<boolean> {
    if (this.receipts.has(receipt.resolutionId)) return false;
    this.receipts.set(receipt.resolutionId, { body: encode(receipt), digest: receiptDigest, verified: false, receivedAt: now, checkedAt: null, buyerAgentId });
    return true;
  }

  async getReceipt(resolutionId: Hex32): Promise<StoredReceipt | undefined> {
    const row = this.receipts.get(resolutionId);
    return row === undefined ? undefined : { receipt: AdoptionReceipt.parse(JSON.parse(row.body)), verified: row.verified, buyerAgentId: row.buyerAgentId };
  }

  async enqueueReputationPosts(posts: readonly NewReputationPost[], now: Date): Promise<number> {
    let added = 0;
    for (const post of posts) {
      const key = postKey(post.resolutionId, post.target);
      if (this.posts.has(key)) continue;
      this.posts.set(key, { ...post, state: "pending", attempts: 0, nextAttemptAt: now, fromBlock: null, txHash: null, note: null });
      added++;
    }
    return added;
  }

  async dueReputationPosts(now: Date, limit: number): Promise<ReputationPost[]> {
    return [...this.posts.values()]
      .filter((p) => p.state === "pending" && p.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, limit);
  }

  async getReputationPost(resolutionId: Hex32, target: ReputationTarget): Promise<ReputationPost | undefined> {
    return this.posts.get(postKey(resolutionId, target));
  }

  async updateReputationPost(resolutionId: Hex32, target: ReputationTarget, expectedAttempts: number, change: ReputationPostChange, _now?: Date): Promise<boolean> {
    const key = postKey(resolutionId, target);
    const row = this.posts.get(key);
    if (row?.state !== "pending" || row.attempts !== expectedAttempts) return false;
    const defined = Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)) as ReputationPostChange;
    this.posts.set(key, { ...row, ...defined });
    return true;
  }

  async listUncheckedReceipts(limit: number): Promise<UncheckedReceipt[]> {
    return [...this.receipts.values()]
      .filter((r) => r.checkedAt === null)
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
      .slice(0, limit)
      .map((r) => ({ receipt: AdoptionReceipt.parse(JSON.parse(r.body)), receiptDigest: r.digest }));
  }

  async markReceiptVerified(resolutionId: Hex32, receiptDigest: Hex32, now: Date): Promise<boolean> {
    return this.verdict(resolutionId, receiptDigest, now, true);
  }

  async markReceiptChecked(resolutionId: Hex32, receiptDigest: Hex32, now: Date): Promise<boolean> {
    return this.verdict(resolutionId, receiptDigest, now, false);
  }

  private verdict(resolutionId: Hex32, receiptDigest: Hex32, now: Date, verified: boolean): boolean {
    const row = this.receipts.get(resolutionId);
    if (row === undefined || row.digest !== receiptDigest || row.checkedAt !== null) return false;
    this.receipts.set(resolutionId, { ...row, verified, checkedAt: now });
    return true;
  }

  async recordDemand(day: string, bucket: string, profileDigest: Hex32, source: string): Promise<void> {
    if ([...this.daily.values()].some((b) => b.day === day)) return;
    let salt = this.salts.get(day);
    if (salt === undefined) {
      salt = this.newSalt();
      this.salts.set(day, salt);
    }
    const key = `${day}\n${bucket}`;
    const sets = this.seen.get(key) ?? { profiles: new Set<string>(), sources: new Set<string>() };
    sets.profiles.add(saltedDigest(salt, profileDigest));
    sets.sources.add(saltedDigest(salt, `source:${source}`));
    this.seen.set(key, sets);
  }

  async closeDemandDaysBefore(today: string): Promise<number> {
    const days = new Set<string>();
    for (const [key, sets] of this.seen) {
      const [day, bucket] = key.split("\n") as [string, string];
      if (day >= today) continue;
      days.add(day);
      const existing = this.daily.get(key);
      this.daily.set(key, { day, bucket, profiles: (existing?.profiles ?? 0) + sets.profiles.size, sources: (existing?.sources ?? 0) + sets.sources.size });
      this.seen.delete(key);
    }
    for (const day of days) this.salts.delete(day);
    return days.size;
  }

  async demandBuckets(minProfiles: number) {
    return [...this.daily.values()]
      .filter((b) => b.profiles >= minProfiles && b.sources >= minProfiles)
      .sort((a, b) => (a.day + a.bucket < b.day + b.bucket ? -1 : 1));
  }

  async getChainCursor(name: string): Promise<bigint | undefined> {
    return this.cursors.get(name);
  }

  async advanceChainCursor(name: string, expected: bigint | undefined, next: bigint, events: readonly RegistryEventRow[], _now?: Date): Promise<boolean> {
    if (this.cursors.get(name) !== expected) return false;
    // Checked before anything changes, so a bad row leaves the store as it was.
    const checked = events.map(checkRegistryEvent);
    const fresh = new Map<string, RegistryEventRow>();
    for (const e of checked) {
      const key = `${e.txHash}:${e.logIndex}`;
      if (!this.eventKeys.has(key) && !fresh.has(key)) fresh.set(key, e);
    }
    for (const key of fresh.keys()) this.eventKeys.add(key);
    this.events = [...this.events, ...fresh.values()].sort(compareEventPositions);
    this.cursors.set(name, next);
    return true;
  }

  async listRegistryEvents(query: RegistryEventQuery, limit: number): Promise<RegistryEventRow[]> {
    return this.events
      .filter(
        (e) =>
          (query.after === undefined || compareEventPositions(e, query.after) > 0) &&
          (query.resolutionId === undefined || e.resolutionId === query.resolutionId) &&
          (query.names === undefined || query.names.includes(e.name)),
      )
      .slice(0, limit);
  }

  async insertWarrantyAction(action: NewWarrantyAction, now: Date): Promise<boolean> {
    const key = actionKey(action.resolutionId, action.kind);
    if (this.actions.has(key)) return false;
    this.actions.set(key, {
      resolutionId: action.resolutionId,
      kind: action.kind,
      body: encodeWarrantyPayload(action.kind, action.resolutionId, action.payload),
      signature: checkSignature(action.signature),
      state: action.state,
      attempts: 0,
      nextAttemptAt: action.nextAttemptAt,
      txHash: null,
      sentAt: null,
      lastCode: action.lastCode ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return true;
  }

  async getWarrantyAction(resolutionId: Hex32, kind: WarrantyActionKind): Promise<WarrantyAction | undefined> {
    const row = this.actions.get(actionKey(resolutionId, kind));
    return row === undefined ? undefined : toAction(row);
  }

  async dueWarrantyActions(kind: WarrantyActionKind, now: Date, limit: number): Promise<WarrantyAction[]> {
    return [...this.actions.values()]
      .filter((a) => a.kind === kind && (a.state === "queued" || a.state === "sent") && a.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, limit)
      .map(toAction);
  }

  async listWarrantyActions(filter: { readonly kind?: WarrantyActionKind; readonly state?: WarrantyActionState }, limit: number): Promise<WarrantyAction[]> {
    return [...this.actions.values()]
      .filter((a) => (filter.kind === undefined || a.kind === filter.kind) && (filter.state === undefined || a.state === filter.state))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.resolutionId < b.resolutionId ? -1 : a.resolutionId > b.resolutionId ? 1 : 0))
      .slice(0, limit)
      .map(toAction);
  }

  async updateWarrantyAction(resolutionId: Hex32, kind: WarrantyActionKind, expected: WarrantyActionExpectation, change: WarrantyActionChange, now: Date): Promise<boolean> {
    const key = actionKey(resolutionId, kind);
    const row = this.actions.get(key);
    if (row === undefined || isFinalActionState(row.state) || row.state !== expected.state || row.attempts !== expected.attempts) return false;
    const { payload, ...rest } = change;
    const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Omit<WarrantyActionChange, "payload">;
    const body = payload === undefined ? row.body : encodeWarrantyPayload(kind, resolutionId, payload);
    const signature = change.signature === undefined ? row.signature : checkSignature(change.signature);
    this.actions.set(key, { ...row, ...defined, body, signature, updatedAt: now });
    return true;
  }

  async listResolutionsToActivate(limit: number): Promise<ResolutionRow[]> {
    return [...this.resolutions.values()]
      .filter((r) => r.state === "settled" && r.claimHash !== null && !this.actions.has(actionKey(r.resolutionId, "activate")))
      .slice(0, limit);
  }

  async listWarrantiesToEvaluate(limit: number): Promise<RegistryEventRow[]> {
    return this.activeWarranties()
      .filter((a) => this.receipts.get(a.resolutionId as string)?.verified === true && !this.actions.has(actionKey(a.resolutionId as Hex32, "finalize")))
      .slice(0, limit);
  }

  async listWarrantiesToExpire(before: bigint, limit: number): Promise<RegistryEventRow[]> {
    return this.activeWarranties()
      .filter((a) => {
        const id = a.resolutionId as Hex32;
        const finalize = this.actions.get(actionKey(id, "finalize"));
        return (a.claimDeadline ?? 0n) < before && !this.actions.has(actionKey(id, "expire")) && finalize?.state !== "queued" && finalize?.state !== "sent";
      })
      .sort((a, b) => ((a.claimDeadline ?? 0n) < (b.claimDeadline ?? 0n) ? -1 : (a.claimDeadline ?? 0n) > (b.claimDeadline ?? 0n) ? 1 : (a.resolutionId as string) < (b.resolutionId as string) ? -1 : 1))
      .slice(0, limit);
  }

  async countDamperOutcomes(query: DamperQuery): Promise<number> {
    const counted = new Set<Hex32>();
    const matches = (id: Hex32 | null): id is Hex32 => {
      if (id === null || id === query.exclude || this.resolutions.get(id)?.payer !== query.payer) return false;
      const activation = this.events.find((e) => e.name === "ResolutionActivated" && e.resolutionId === id);
      return activation?.releaseDigest === query.releaseDigest && activation.profileIndex === query.profileIndex;
    };
    for (const e of this.events) {
      if (e.name === "OutcomeFinalized" && (e.verdict === 1 || e.verdict === 2) && (e.weightBps ?? 0) > 0 && e.blockTime >= query.since && matches(e.resolutionId)) counted.add(e.resolutionId);
    }
    for (const a of this.actions.values()) {
      if (a.kind !== "finalize" || !DAMPER_ACTION_STATES.includes(a.state) || a.createdAt < query.since || !matches(a.resolutionId)) continue;
      if (countsForDamper(decodeWarrantyPayload("finalize", a.resolutionId, a.body))) counted.add(a.resolutionId);
    }
    return counted.size;
  }

  /** Indexed activations with no finalization or expiry indexed, in chain order. */
  private activeWarranties(): RegistryEventRow[] {
    const ended = new Set(this.events.filter((e) => FINAL_EVENTS.has(e.name)).map((e) => e.resolutionId));
    return this.events.filter((e) => e.name === "ResolutionActivated" && e.resolutionId !== null && !ended.has(e.resolutionId));
  }

  async purgeExpiredOffers(before: Date): Promise<number> {
    const settled = new Set([...this.resolutions.values()].filter((r) => r.state === "settled").map((r) => r.previewId));
    for (const [id, row] of this.resolutions) {
      if (row.state === "expired" && row.validBefore < before) this.resolutions.delete(id);
    }
    let n = 0;
    for (const [id, row] of this.previews) {
      if (row.validUntil < before && !settled.has(id as Hex32)) {
        this.previews.delete(id);
        n++;
      }
    }
    return n;
  }
}

function toAction(row: StoredAction): WarrantyAction {
  const { body, ...rest } = row;
  return { ...rest, payload: decodeWarrantyPayload(row.kind, row.resolutionId, body) };
}

/** Checks a registry event row's fields before it is stored or after it is read (a store never keeps a row it could not have read). */
export function checkRegistryEvent(row: RegistryEventRow): RegistryEventRow {
  const hex32 = (v: string | null) => (v === null ? null : Hex32.parse(v));
  if (!isRegistryEventName(row.name)) throw new TypeError(`unknown registry event ${String(row.name)}`);
  if (row.blockNumber < 0n || !Number.isSafeInteger(row.logIndex) || row.logIndex < 0) throw new RangeError("invalid log position");
  return {
    blockNumber: row.blockNumber,
    logIndex: row.logIndex,
    txHash: Hex32.parse(row.txHash),
    blockTime: row.blockTime,
    name: row.name,
    resolutionId: hex32(row.resolutionId),
    releaseDigest: hex32(row.releaseDigest),
    profileIndex: row.profileIndex,
    verdict: row.verdict,
    weightBps: row.weightBps,
    evidenceHash: hex32(row.evidenceHash),
    amount: row.amount,
    claimDeadline: row.claimDeadline,
    engine: row.engine === null ? null : Address.parse(row.engine),
  };
}
