import type { CatalogIndex } from "@lemma/catalog";
import { type Address, AdoptionReceipt, CapabilityRelease, type Hex32, PatchBundle, type Preview } from "@lemma/core";
import { and, asc, eq, gte, lt, ne, notExists, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { type DemandBucket, type LemmaStore, type RearmResult, type ResolutionRow, decodePreview, decodeResolution, encode, saltedDigest } from "../persistence.js";
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
        body: encode(row.resolution),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: t.resolutions.resolutionId });
    return inserted.length === 1;
  }

  async rearmExpired(resolutionId: Hex32, nonce: string, validBefore: Date, now: Date): Promise<RearmResult> {
    try {
      const updated = await this.db
        .update(t.resolutions)
        .set({ state: "prepared", nonce, validBefore, updatedAt: now })
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
    try {
      const updated = await this.db
        .update(t.resolutions)
        .set({ state: "settled", settlementRef, updatedAt: now })
        .where(and(eq(t.resolutions.resolutionId, resolutionId), eq(t.resolutions.nonce, nonce), ne(t.resolutions.state, "settled")))
        .returning({ id: t.resolutions.resolutionId });
      return updated.length === 1;
    } catch (error) {
      // This settlement already settled another resolution (resolutions_settlement_idx).
      if (sqlState(error) === UNIQUE_VIOLATION) return false;
      throw error;
    }
  }

  async markExpired(resolutionId: Hex32, nonce: string, now: Date): Promise<boolean> {
    const updated = await this.db
      .update(t.resolutions)
      .set({ state: "expired", updatedAt: now })
      .where(and(eq(t.resolutions.resolutionId, resolutionId), eq(t.resolutions.state, "prepared"), eq(t.resolutions.nonce, nonce), lt(t.resolutions.validBefore, now)))
      .returning({ id: t.resolutions.resolutionId });
    return updated.length === 1;
  }

  async listUnsettled(before: Date, limit: number): Promise<ResolutionRow[]> {
    const rows = await this.db
      .select()
      .from(t.resolutions)
      .where(and(eq(t.resolutions.state, "prepared"), lt(t.resolutions.validBefore, before)))
      .orderBy(asc(t.resolutions.validBefore))
      .limit(limit);
    return rows.map(toRow);
  }

  async insertReceipt(receipt: AdoptionReceipt, receiptDigest: Hex32, now: Date): Promise<boolean> {
    const inserted = await this.db
      .insert(t.adoptionReceipts)
      .values({ resolutionId: receipt.resolutionId, receiptDigest, body: encode(receipt), verified: false, receivedAt: now })
      .onConflictDoNothing()
      .returning({ id: t.adoptionReceipts.resolutionId });
    return inserted.length === 1;
  }

  async getReceipt(resolutionId: Hex32) {
    const [row] = await this.db.select().from(t.adoptionReceipts).where(eq(t.adoptionReceipts.resolutionId, resolutionId)).limit(1);
    return row === undefined ? undefined : { receipt: AdoptionReceipt.parse(JSON.parse(row.body)), verified: row.verified };
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
    resolution: decodeResolution(row.body),
  };
}

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
