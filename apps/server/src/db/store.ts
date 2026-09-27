import type { CatalogIndex } from "@lemma/catalog";
import {
  type Address,
  AdoptionReceipt,
  type AgentId,
  type CapabilityId,
  CapabilityRelease,
  type Hex32,
  PatchBundle,
  type Preview,
  type WarrantyActionKind,
  type WarrantyActionState,
  isFinalActionState,
} from "@lemma/core";
import { type SQL, and, asc, eq, getTableColumns, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, notExists, or, sql } from "drizzle-orm";
import { type PgColumn, type PgDatabase, type PgQueryResultHKT, alias } from "drizzle-orm/pg-core";

import {
  DAMPER_ACTION_STATES,
  type DamperQuery,
  type DemandBucket,
  type LemmaStore,
  type NewReputationPost,
  type NewWarrantyAction,
  type RearmResult,
  type RegistryEventQuery,
  type RegistryEventRow,
  type ReputationPost,
  type ReputationPostChange,
  type ReputationTarget,
  type ResolutionRow,
  type StoredReceipt,
  type UncheckedReceipt,
  type UnsettledCursor,
  type WarrantyAction,
  type WarrantyActionChange,
  type WarrantyActionExpectation,
  checkRegistryEvent,
  checkSignature,
  countsForDamper,
  decodePreview,
  decodeResolution,
  decodeWarrantyPayload,
  encode,
  encodeWarrantyPayload,
  isRegistryEventName,
  saltedDigest,
} from "../persistence.js";
import * as t from "./schema.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<PgQueryResultHKT, any>;

/**
 * The Postgres store. Every write that must not happen twice is a single
 * conditional statement (insert on conflict do nothing, update with the
 * expected state in the WHERE clause), so concurrent requests cannot both
 * succeed, and no read-modify-write races exist.
 */
export class PgStore implements LemmaStore {
  constructor(
    private readonly db: Db,
    private readonly newSalt: () => string = () => crypto.randomUUID(),
  ) {}

  async ping(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }

  async saveCatalog(index: CatalogIndex, now: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const r of index.releases) {
        await tx.insert(t.releases).values({ releaseDigest: r.releaseDigest, body: encode(r.release), firstLoadedAt: now }).onConflictDoNothing();
        await tx.insert(t.bundles).values({ payloadDigest: r.release.payloadDigest, body: encode(r.bundle) }).onConflictDoNothing();
      }
      await tx
        .insert(t.catalogSnapshots)
        .values({ catalogDigest: index.catalogDigest, releaseDigests: encode(index.releases.map((r) => r.releaseDigest)), firstServedAt: now })
        .onConflictDoNothing();
    });
  }

  async getRelease(releaseDigest: Hex32) {
    const [row] = await this.db.select({ body: t.releases.body }).from(t.releases).where(eq(t.releases.releaseDigest, releaseDigest)).limit(1);
    return row === undefined ? undefined : CapabilityRelease.parse(JSON.parse(row.body));
  }

  async getBundle(payloadDigest: Hex32) {
    const [row] = await this.db.select({ body: t.bundles.body }).from(t.bundles).where(eq(t.bundles.payloadDigest, payloadDigest)).limit(1);
    return row === undefined ? undefined : PatchBundle.parse(JSON.parse(row.body));
  }

  async saveOffer(preview: Preview): Promise<void> {
    if (!("offer" in preview) || preview.offer === null) throw new Error("only offer-bearing previews are stored");
    await this.db.insert(t.previews).values({
      previewId: preview.previewId,
      body: encode(preview),
      releaseDigest: preview.release.releaseDigest,
      validUntil: new Date(preview.offer.validUntil),
      createdAt: new Date(preview.createdAt),
    });
  }

  async getPreview(previewId: Hex32) {
    const [row] = await this.db.select({ body: t.previews.body }).from(t.previews).where(eq(t.previews.previewId, previewId)).limit(1);
    return row === undefined ? undefined : decodePreview(row.body);
  }

  async insertPrepared(row: ResolutionRow, now: Date): Promise<boolean> {
    const inserted = await this.db
      .insert(t.resolutions)
      .values({
        resolutionId: row.resolutionId,
        previewId: row.previewId,
        payer: row.payer,
        state: "prepared",
        nonce: row.nonce,
        validBefore: row.validBefore,
        settlementRef: null,
        claimHash: row.claimHash,
        body: encode(row.resolution),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: t.resolutions.resolutionId });
    return inserted.length === 1;
  }

  async rearmExpired(resolutionId: Hex32, nonce: string, validBefore: Date, now: Date, claimHash: Hex32 | null): Promise<RearmResult> {
    try {
      const updated = await this.db
        .update(t.resolutions)
        .set({ state: "prepared", nonce, validBefore, claimHash, updatedAt: now })
        .where(and(eq(t.resolutions.resolutionId, resolutionId), eq(t.resolutions.state, "expired")))
        .returning({ id: t.resolutions.resolutionId });
      return updated.length === 1 ? "REARMED" : "NOT_EXPIRED";
    } catch (error) {
      // The authorization already backs another resolution (resolutions_authorization_idx).
      if (sqlState(error) === UNIQUE_VIOLATION) return "PAYMENT_REUSED";
      throw error;
    }
  }

  async getResolution(resolutionId: Hex32): Promise<ResolutionRow | undefined> {
    const [row] = await this.db.select().from(t.resolutions).where(eq(t.resolutions.resolutionId, resolutionId)).limit(1);
    return row === undefined ? undefined : toRow(row);
  }

  async markSettled(resolutionId: Hex32, nonce: string, settlementRef: string, now: Date): Promise<boolean> {
    const updated = await this.db
      .update(t.resolutions)
      .set({ state: "settled", settlementRef, updatedAt: now })
      .where(and(eq(t.resolutions.resolutionId, resolutionId), eq(t.resolutions.nonce, nonce), ne(t.resolutions.state, "settled")))
      .returning({ id: t.resolutions.resolutionId });
    return updated.length === 1;
  }

  async markExpired(resolutionId: Hex32, nonce: string, now: Date): Promise<boolean> {
    const updated = await this.db
      .update(t.resolutions)
      .set({ state: "expired", updatedAt: now })
      .where(and(eq(t.resolutions.resolutionId, resolutionId), eq(t.resolutions.state, "prepared"), eq(t.resolutions.nonce, nonce), lt(t.resolutions.validBefore, now)))
      .returning({ id: t.resolutions.resolutionId });
    return updated.length === 1;
  }

  async listUnsettled(before: Date, limit: number, after?: UnsettledCursor): Promise<ResolutionRow[]> {
    const rows = await this.db
      .select()
      .from(t.resolutions)
      .where(
        and(
          eq(t.resolutions.state, "prepared"),
          lt(t.resolutions.validBefore, before),
          after === undefined
            ? undefined
            : or(gt(t.resolutions.validBefore, after.validBefore), and(eq(t.resolutions.validBefore, after.validBefore), gt(t.resolutions.resolutionId, after.resolutionId))),
        ),
      )
      .orderBy(asc(t.resolutions.validBefore), asc(t.resolutions.resolutionId))
      .limit(limit);
    return rows.map(toRow);
  }

  async insertReceipt(receipt: AdoptionReceipt, receiptDigest: Hex32, now: Date, buyerAgentId: AgentId | null = null): Promise<boolean> {
    const inserted = await this.db
      .insert(t.adoptionReceipts)
      .values({ resolutionId: receipt.resolutionId, receiptDigest, body: encode(receipt), verified: false, receivedAt: now, buyerAgentId })
      .onConflictDoNothing()
      .returning({ id: t.adoptionReceipts.resolutionId });
    return inserted.length === 1;
  }

  async getReceipt(resolutionId: Hex32): Promise<StoredReceipt | undefined> {
    const [row] = await this.db.select().from(t.adoptionReceipts).where(eq(t.adoptionReceipts.resolutionId, resolutionId)).limit(1);
    return row === undefined ? undefined : { receipt: AdoptionReceipt.parse(JSON.parse(row.body)), verified: row.verified, buyerAgentId: row.buyerAgentId };
  }

  async enqueueReputationPosts(posts: readonly NewReputationPost[], now: Date): Promise<number> {
    if (posts.length === 0) return 0;
    const inserted = await this.db
      .insert(t.reputationPosts)
      .values(posts.map((p) => ({ ...p, state: "pending" as const, attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now })))
      .onConflictDoNothing()
      .returning({ id: t.reputationPosts.resolutionId });
    return inserted.length;
  }

  async dueReputationPosts(now: Date, limit: number): Promise<ReputationPost[]> {
    const rows = await this.db
      .select()
      .from(t.reputationPosts)
      .where(and(eq(t.reputationPosts.state, "pending"), lte(t.reputationPosts.nextAttemptAt, now)))
      .orderBy(asc(t.reputationPosts.nextAttemptAt))
      .limit(limit);
    return rows.map(toPost);
  }

  async getReputationPost(resolutionId: Hex32, target: ReputationTarget): Promise<ReputationPost | undefined> {
    const [row] = await this.db
      .select()
      .from(t.reputationPosts)
      .where(and(eq(t.reputationPosts.resolutionId, resolutionId), eq(t.reputationPosts.target, target)))
      .limit(1);
    return row === undefined ? undefined : toPost(row);
  }

  async updateReputationPost(resolutionId: Hex32, target: ReputationTarget, expectedAttempts: number, change: ReputationPostChange, now: Date): Promise<boolean> {
    const updated = await this.db
      .update(t.reputationPosts)
      .set({ ...change, updatedAt: now })
      .where(
        and(
          eq(t.reputationPosts.resolutionId, resolutionId),
          eq(t.reputationPosts.target, target),
          eq(t.reputationPosts.state, "pending"),
          eq(t.reputationPosts.attempts, expectedAttempts),
        ),
      )
      .returning({ id: t.reputationPosts.resolutionId });
    return updated.length === 1;
  }

  async listUncheckedReceipts(limit: number): Promise<UncheckedReceipt[]> {
    const rows = await this.db
      .select({ body: t.adoptionReceipts.body, receiptDigest: t.adoptionReceipts.receiptDigest })
      .from(t.adoptionReceipts)
      .where(isNull(t.adoptionReceipts.checkedAt))
      .orderBy(asc(t.adoptionReceipts.receivedAt))
      .limit(limit);
    return rows.map((r) => ({ receipt: AdoptionReceipt.parse(JSON.parse(r.body)), receiptDigest: r.receiptDigest as Hex32 }));
  }

  async markReceiptVerified(resolutionId: Hex32, receiptDigest: Hex32, now: Date): Promise<boolean> {
    return this.verdict(resolutionId, receiptDigest, now, true);
  }

  async markReceiptChecked(resolutionId: Hex32, receiptDigest: Hex32, now: Date): Promise<boolean> {
    return this.verdict(resolutionId, receiptDigest, now, false);
  }

  /** One conditional update: a verdict lands once, and only on the receipt it was reached for. */
  private async verdict(resolutionId: Hex32, receiptDigest: Hex32, now: Date, verified: boolean): Promise<boolean> {
    const updated = await this.db
      .update(t.adoptionReceipts)
      .set({ verified, checkedAt: now })
      .where(and(eq(t.adoptionReceipts.resolutionId, resolutionId), eq(t.adoptionReceipts.receiptDigest, receiptDigest), isNull(t.adoptionReceipts.checkedAt)))
      .returning({ id: t.adoptionReceipts.resolutionId });
    return updated.length === 1;
  }

  async recordDemand(day: string, bucket: string, profileDigest: Hex32, source: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Shared per-day lock: a close of this day waits for in-flight writes, and a
      // write that starts after a close sees the day closed, so nothing is counted
      // twice and no salt is created for a closed day.
      await tx.execute(sql`select pg_advisory_xact_lock_shared(${DEMAND_LOCK}, hashtext(${day}))`);
      const salt = await this.saltFor(tx, day);
      if (salt === undefined) return;
      await tx.execute(sql`
        insert into demand_seen (day, bucket, salted_digest, salted_source)
        values (${day}, ${bucket}, ${saltedDigest(salt, profileDigest)}, ${saltedDigest(salt, `source:${source}`)})
        on conflict do nothing`);
    });
  }

  async closeDemandDaysBefore(today: string): Promise<number> {
    const days = await this.db.selectDistinct({ day: t.demandSeen.day }).from(t.demandSeen).where(lt(t.demandSeen.day, today));
    let closed = 0;
    let failure: unknown;
    // Each day closes on its own, so one failing day never blocks the others.
    for (const { day } of days) {
      try {
        await this.db.transaction(async (tx) => {
          // A large day can take longer than the request pool's statement limit.
          await tx.execute(sql`set local statement_timeout = '5min'`);
          await tx.execute(sql`select pg_advisory_xact_lock(${DEMAND_LOCK}, hashtext(${day}))`);
          await tx.execute(sql`
            with closed as (delete from demand_seen where day = ${day} returning bucket, salted_digest, salted_source)
            insert into demand_daily (day, bucket, profiles, sources)
            select ${day}, bucket, count(distinct salted_digest)::int, count(distinct salted_source)::int from closed group by bucket
            on conflict (day, bucket) do nothing`);
          await tx.delete(t.demandSalts).where(eq(t.demandSalts.day, day));
        });
        closed++;
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
    return closed;
  }

  async demandBuckets(minProfiles: number): Promise<DemandBucket[]> {
    return this.db
      .select({ day: t.demandDaily.day, bucket: t.demandDaily.bucket, profiles: t.demandDaily.profiles, sources: t.demandDaily.sources })
      .from(t.demandDaily)
      .where(and(gte(t.demandDaily.profiles, minProfiles), gte(t.demandDaily.sources, minProfiles)))
      .orderBy(asc(t.demandDaily.day), asc(t.demandDaily.bucket));
  }

  async purgeExpiredOffers(before: Date): Promise<number> {
    await this.db.delete(t.resolutions).where(and(eq(t.resolutions.state, "expired"), lt(t.resolutions.validBefore, before)));
    const deleted = await this.db
      .delete(t.previews)
      .where(
        and(
          lt(t.previews.validUntil, before),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(t.resolutions)
              .where(and(eq(t.resolutions.previewId, t.previews.previewId), eq(t.resolutions.state, "settled"))),
          ),
        ),
      )
      .returning({ id: t.previews.previewId });
    return deleted.length;
  }

  async getChainCursor(name: string): Promise<bigint | undefined> {
    const [row] = await this.db.select({ next: t.chainCursors.nextBlock }).from(t.chainCursors).where(eq(t.chainCursors.name, name)).limit(1);
    return row?.next;
  }

  async advanceChainCursor(name: string, expected: bigint | undefined, next: bigint, events: readonly RegistryEventRow[], now: Date): Promise<boolean> {
    // Checked before the transaction, so a bad row fails the call and changes nothing.
    const rows = events.map((e) => toEventValues(checkRegistryEvent(e)));
    return this.db.transaction(async (tx) => {
      // The cursor moves first, conditionally: a reader that lost the race stores nothing.
      const moved =
        expected === undefined
          ? await tx.insert(t.chainCursors).values({ name, nextBlock: next, updatedAt: now }).onConflictDoNothing().returning({ name: t.chainCursors.name })
          : await tx
              .update(t.chainCursors)
              .set({ nextBlock: next, updatedAt: now })
              .where(and(eq(t.chainCursors.name, name), eq(t.chainCursors.nextBlock, expected)))
              .returning({ name: t.chainCursors.name });
      if (moved.length !== 1) return false;
      for (let i = 0; i < rows.length; i += EVENT_INSERT_BATCH) {
        await tx.insert(t.registryEvents).values(rows.slice(i, i + EVENT_INSERT_BATCH)).onConflictDoNothing();
      }
      return true;
    });
  }

  async listRegistryEvents(query: RegistryEventQuery, limit: number): Promise<RegistryEventRow[]> {
    const e = t.registryEvents;
    if (query.names !== undefined && query.names.length === 0) return [];
    const after = query.after;
    const rows = await this.db
      .select()
      .from(e)
      .where(
        and(
          after === undefined ? undefined : or(gt(e.blockNumber, after.blockNumber), and(eq(e.blockNumber, after.blockNumber), gt(e.logIndex, after.logIndex))),
          query.resolutionId === undefined ? undefined : eq(e.resolutionId, query.resolutionId),
          query.names === undefined ? undefined : inArray(e.name, [...query.names]),
        ),
      )
      .orderBy(asc(e.blockNumber), asc(e.logIndex))
      .limit(limit);
    return rows.flatMap(toEvent);
  }

  async insertWarrantyAction(action: NewWarrantyAction, now: Date): Promise<boolean> {
    const inserted = await this.db
      .insert(t.warrantyActions)
      .values({
        resolutionId: action.resolutionId,
        kind: action.kind,
        payload: encodeWarrantyPayload(action.kind, action.resolutionId, action.payload),
        signature: checkSignature(action.signature),
        state: action.state,
        txHash: null,
        sentAt: null,
        attempts: 0,
        nextAttemptAt: action.nextAttemptAt,
        lastCode: action.lastCode ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: t.warrantyActions.resolutionId });
    return inserted.length === 1;
  }

  async getWarrantyAction(resolutionId: Hex32, kind: WarrantyActionKind): Promise<WarrantyAction | undefined> {
    const [row] = await this.db
      .select()
      .from(t.warrantyActions)
      .where(and(eq(t.warrantyActions.resolutionId, resolutionId), eq(t.warrantyActions.kind, kind)))
      .limit(1);
    return row === undefined ? undefined : toAction(row);
  }

  async dueWarrantyActions(kind: WarrantyActionKind, now: Date, limit: number): Promise<WarrantyAction[]> {
    const a = t.warrantyActions;
    const rows = await this.db
      .select()
      .from(a)
      .where(and(eq(a.kind, kind), inArray(a.state, ["queued", "sent"]), lte(a.nextAttemptAt, now)))
      // An activation batch (one due time) goes out by resolution id, never by insertion order, so purchase order does not show in the send order.
      // Other kinds keep their queue order: the evaluator's damper weighs outcomes in the order they were queued.
      .orderBy(...(kind === "activate" ? [asc(a.nextAttemptAt), asc(a.resolutionId)] : [asc(a.nextAttemptAt)]))
      .limit(limit);
    return rows.map(toAction);
  }

  async listWarrantyActions(filter: { readonly kind?: WarrantyActionKind; readonly state?: WarrantyActionState }, limit: number): Promise<WarrantyAction[]> {
    const a = t.warrantyActions;
    const rows = await this.db
      .select()
      .from(a)
      .where(and(filter.kind === undefined ? undefined : eq(a.kind, filter.kind), filter.state === undefined ? undefined : eq(a.state, filter.state)))
      .orderBy(asc(a.createdAt), asc(a.resolutionId))
      .limit(limit);
    return rows.map(toAction);
  }

  async updateWarrantyAction(resolutionId: Hex32, kind: WarrantyActionKind, expected: WarrantyActionExpectation, change: WarrantyActionChange, now: Date): Promise<boolean> {
    if (isFinalActionState(expected.state)) return false;
    const set: Partial<typeof t.warrantyActions.$inferInsert> = { updatedAt: now };
    if (change.state !== undefined) set.state = change.state;
    if (change.payload !== undefined) set.payload = encodeWarrantyPayload(kind, resolutionId, change.payload);
    if (change.signature !== undefined) set.signature = checkSignature(change.signature);
    if (change.attempts !== undefined) set.attempts = change.attempts;
    if (change.nextAttemptAt !== undefined) set.nextAttemptAt = change.nextAttemptAt;
    if (change.txHash !== undefined) set.txHash = change.txHash;
    if (change.sentAt !== undefined) set.sentAt = change.sentAt;
    if (change.lastCode !== undefined) set.lastCode = change.lastCode;
    const a = t.warrantyActions;
    const updated = await this.db
      .update(a)
      .set(set)
      .where(and(eq(a.resolutionId, resolutionId), eq(a.kind, kind), eq(a.state, expected.state), eq(a.attempts, expected.attempts)))
      .returning({ id: a.resolutionId });
    return updated.length === 1;
  }

  async listResolutionsToActivate(limit: number): Promise<ResolutionRow[]> {
    const r = t.resolutions;
    const rows = await this.db
      .select()
      .from(r)
      .where(and(eq(r.state, "settled"), isNotNull(r.claimHash), notExists(this.actionOf(r.resolutionId, "activate"))))
      .orderBy(asc(r.updatedAt), asc(r.resolutionId))
      .limit(limit);
    return rows.map(toRow);
  }

  async listWarrantiesToEvaluate(limit: number): Promise<RegistryEventRow[]> {
    const e = t.registryEvents;
    const rows = await this.db
      .select(getTableColumns(e))
      .from(e)
      .innerJoin(t.adoptionReceipts, eq(t.adoptionReceipts.resolutionId, e.resolutionId))
      .where(and(eq(e.name, "ResolutionActivated"), eq(t.adoptionReceipts.verified, true), notExists(this.endOf(e.resolutionId)), notExists(this.actionOf(e.resolutionId, "finalize"))))
      .orderBy(asc(e.blockNumber), asc(e.logIndex))
      .limit(limit);
    return rows.flatMap(toEvent);
  }

  async listWarrantiesToExpire(before: bigint, limit: number): Promise<RegistryEventRow[]> {
    const e = t.registryEvents;
    const rows = await this.db
      .select()
      .from(e)
      .where(
        and(
          eq(e.name, "ResolutionActivated"),
          lt(e.claimDeadline, before),
          notExists(this.endOf(e.resolutionId)),
          notExists(this.actionOf(e.resolutionId, "expire")),
          notExists(this.actionOf(e.resolutionId, "finalize", ["queued", "sent"])),
        ),
      )
      .orderBy(asc(e.claimDeadline), asc(e.resolutionId))
      .limit(limit);
    return rows.flatMap(toEvent);
  }

  async countDamperOutcomes(query: DamperQuery): Promise<number> {
    const e = t.registryEvents;
    const a = t.warrantyActions;
    const activation = alias(t.registryEvents, "activation");
    // The payer's resolutions of this release digest and profile index (known from their indexed activation), but the one asked about.
    const ofPayer = (id: PgColumn): SQL | undefined =>
      and(
        eq(activation.name, "ResolutionActivated"),
        eq(activation.releaseDigest, query.releaseDigest),
        eq(activation.profileIndex, query.profileIndex),
        eq(t.resolutions.payer, query.payer),
        ne(id, query.exclude),
      );
    const finalized = await this.db
      .select({ id: e.resolutionId })
      .from(e)
      .innerJoin(activation, eq(activation.resolutionId, e.resolutionId))
      .innerJoin(t.resolutions, eq(t.resolutions.resolutionId, e.resolutionId))
      .where(and(eq(e.name, "OutcomeFinalized"), inArray(e.verdict, [1, 2]), gt(e.weightBps, 0), gte(e.blockTime, query.since), ofPayer(e.resolutionId)));
    const inFlight = await this.db
      .select({ id: a.resolutionId, payload: a.payload })
      .from(a)
      .innerJoin(activation, eq(activation.resolutionId, a.resolutionId))
      .innerJoin(t.resolutions, eq(t.resolutions.resolutionId, a.resolutionId))
      .where(and(eq(a.kind, "finalize"), inArray(a.state, [...DAMPER_ACTION_STATES]), gte(a.createdAt, query.since), ofPayer(a.resolutionId)));
    const counted = new Set<string>();
    for (const row of finalized) if (row.id !== null) counted.add(row.id);
    for (const row of inFlight) if (countsForDamper(decodeWarrantyPayload("finalize", row.id as Hex32, row.payload))) counted.add(row.id);
    return counted.size;
  }

  /** An outbox action of `kind` (in one of `states`, when given) for the resolution in `id`: for `not exists`. */
  private actionOf(id: PgColumn, kind: WarrantyActionKind, states?: readonly WarrantyActionState[]) {
    const a = t.warrantyActions;
    return this.db
      .select({ one: sql`1` })
      .from(a)
      .where(and(eq(a.resolutionId, id), eq(a.kind, kind), states === undefined ? undefined : inArray(a.state, [...states])));
  }

  /** An indexed finalization or expiry of the resolution in `id`: for `not exists`. */
  private endOf(id: PgColumn) {
    const ended = alias(t.registryEvents, "ended");
    return this.db
      .select({ one: sql`1` })
      .from(ended)
      .where(and(eq(ended.resolutionId, id), inArray(ended.name, ["OutcomeFinalized", "ResolutionExpired"])));
  }

  /**
   * The day's salt, created on first use; undefined once the day is closed (it
   * is never re-created). Read under the day's lock on every call, never
   * cached: a salt cached before its transaction commits could be one that
   * rolled back, or one another connection cannot see yet.
   */
  private async saltFor(tx: Db, day: string): Promise<string | undefined> {
    await tx.execute(sql`
      insert into demand_salts (day, salt)
      select ${day}, ${this.newSalt()}
      where not exists (select 1 from demand_daily where day = ${day})
      on conflict do nothing`);
    const [row] = await tx.select({ salt: t.demandSalts.salt }).from(t.demandSalts).where(eq(t.demandSalts.day, day)).limit(1);
    return row?.salt;
  }

}

function toRow(row: typeof t.resolutions.$inferSelect): ResolutionRow {
  return {
    resolutionId: row.resolutionId as Hex32,
    previewId: row.previewId as Hex32,
    payer: row.payer as Address,
    state: row.state,
    nonce: row.nonce,
    validBefore: row.validBefore,
    settlementRef: row.settlementRef,
    claimHash: row.claimHash as Hex32 | null,
    resolution: decodeResolution(row.body),
  };
}

function toPost(row: typeof t.reputationPosts.$inferSelect): ReputationPost {
  return {
    resolutionId: row.resolutionId as Hex32,
    target: row.target,
    agentId: row.agentId,
    capability: row.capability as CapabilityId,
    value: row.value === 100 ? 100 : 0,
    feedbackHash: row.feedbackHash as Hex32,
    evidence: row.evidence,
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    fromBlock: row.fromBlock,
    txHash: row.txHash as Hex32 | null,
    note: row.note,
  };
}

function toAction(row: typeof t.warrantyActions.$inferSelect): WarrantyAction {
  const resolutionId = row.resolutionId as Hex32;
  return {
    resolutionId,
    kind: row.kind,
    payload: decodeWarrantyPayload(row.kind, resolutionId, row.payload),
    signature: checkSignature(row.signature),
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    txHash: row.txHash as Hex32 | null,
    sentAt: row.sentAt,
    lastCode: row.lastCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A stored registry event, or nothing for a row this build does not know (an event name added later). */
function toEvent(row: typeof t.registryEvents.$inferSelect): RegistryEventRow[] {
  if (!isRegistryEventName(row.name)) return [];
  return [
    checkRegistryEvent({
      blockNumber: row.blockNumber,
      logIndex: row.logIndex,
      txHash: row.txHash as Hex32,
      blockTime: row.blockTime,
      name: row.name,
      resolutionId: row.resolutionId as Hex32 | null,
      releaseDigest: row.releaseDigest as Hex32 | null,
      profileIndex: row.profileIndex,
      verdict: row.verdict,
      weightBps: row.weightBps,
      evidenceHash: row.evidenceHash as Hex32 | null,
      amount: row.amount,
      claimDeadline: row.claimDeadline,
      engine: row.engine as Address | null,
    }),
  ];
}

function toEventValues(row: RegistryEventRow): typeof t.registryEvents.$inferInsert {
  return { ...row };
}

/** Rows per insert statement: well inside Postgres's 65535 parameters at 14 columns a row. */
const EVENT_INSERT_BATCH = 1000;

const UNIQUE_VIOLATION = "23505";
/** The advisory-lock namespace for demand days (with `hashtext(day)` as the key). */
const DEMAND_LOCK = 0x4c44;

/** The SQLSTATE of a database error, through drizzle's wrapper. */
export function sqlState(error: unknown): string | undefined {
  const own = (error as { code?: unknown } | undefined)?.code;
  if (typeof own === "string") return own;
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return typeof cause === "string" ? cause : undefined;
}
