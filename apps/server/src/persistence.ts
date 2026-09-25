import type { CatalogIndex } from "@lemma/catalog";
import { type Address, AdoptionReceipt, CapabilityRelease, type Hex32, PatchBundle, Preview, Resolution, canonicalize, fileDigest } from "@lemma/core";

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
  readonly resolution: Resolution;
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
  /** Re-arms an expired row with a new authorization, unless that authorization already backs another row. */
  rearmExpired(resolutionId: Hex32, nonce: string, validBefore: Date, now: Date): Promise<RearmResult>;
  getResolution(resolutionId: Hex32): Promise<ResolutionRow | undefined>;
  /**
   * Marks a row settled by the authorization that settled it; false when there
   * is no such row, it is already settled, or its nonce is another
   * authorization's (a stale settlement must not land on a re-armed row).
   */
  markSettled(resolutionId: Hex32, nonce: string, settlementRef: string, now: Date): Promise<boolean>;
  /**
   * Marks a prepared row expired, only if it still holds the authorization the
   * reconciler judged and that authorization's window has closed; false
   * otherwise (a stale decision never lands on a re-armed row).
   */
  markExpired(resolutionId: Hex32, nonce: string, now: Date): Promise<boolean>;
  /** Prepared rows whose authorization ended before `before`, oldest first. */
  listUnsettled(before: Date, limit: number): Promise<ResolutionRow[]>;

  /** Stores a receipt; false when one already exists for the resolution (first write wins). */
  insertReceipt(receipt: AdoptionReceipt, receiptDigest: Hex32, now: Date): Promise<boolean>;
  getReceipt(resolutionId: Hex32): Promise<{ receipt: AdoptionReceipt; verified: boolean } | undefined>;

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
  private readonly receipts = new Map<string, { body: string; verified: boolean }>();
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

  async rearmExpired(resolutionId: Hex32, nonce: string, validBefore: Date, _now?: Date): Promise<RearmResult> {
    const row = this.resolutions.get(resolutionId);
    if (row?.state !== "expired") return "NOT_EXPIRED";
    if (this.nonceHeld(row.payer, nonce, resolutionId)) return "PAYMENT_REUSED";
    this.resolutions.set(resolutionId, { ...row, state: "prepared", nonce, validBefore });
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
    if ([...this.resolutions.values()].some((r) => r.settlementRef === settlementRef)) return false;
    this.resolutions.set(resolutionId, { ...row, state: "settled", settlementRef });
    return true;
  }

  async markExpired(resolutionId: Hex32, nonce: string, now: Date): Promise<boolean> {
    const row = this.resolutions.get(resolutionId);
    if (row?.state !== "prepared" || row.nonce !== nonce || row.validBefore >= now) return false;
    this.resolutions.set(resolutionId, { ...row, state: "expired" });
    return true;
  }

  async listUnsettled(before: Date, limit: number) {
    return [...this.resolutions.values()]
      .filter((r) => r.state === "prepared" && r.validBefore < before)
      .sort((a, b) => a.validBefore.getTime() - b.validBefore.getTime())
      .slice(0, limit);
  }

  async insertReceipt(receipt: AdoptionReceipt, _receiptDigest?: Hex32, _now?: Date): Promise<boolean> {
    if (this.receipts.has(receipt.resolutionId)) return false;
    this.receipts.set(receipt.resolutionId, { body: encode(receipt), verified: false });
    return true;
  }

  async getReceipt(resolutionId: Hex32) {
    const row = this.receipts.get(resolutionId);
    return row === undefined ? undefined : { receipt: AdoptionReceipt.parse(JSON.parse(row.body)), verified: row.verified };
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
