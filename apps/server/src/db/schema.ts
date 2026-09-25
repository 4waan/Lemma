import { isNotNull } from "drizzle-orm";
import { boolean, date, index, integer, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Lemma's durable state. Every hashed object is stored as its canonical JSON
 * next to its digest and is re-parsed with the core schema when read, so a
 * row can never silently diverge from what was offered, sold or signed.
 */

/** Immutable copies of every release and bundle the server has loaded, keyed by digest. Git stays the source of truth. */
export const releases = pgTable("releases", {
  releaseDigest: text("release_digest").primaryKey(),
  body: text("body").notNull(),
  firstLoadedAt: timestamp("first_loaded_at", { withTimezone: true, mode: "date" }).notNull(),
});

export const bundles = pgTable("bundles", {
  payloadDigest: text("payload_digest").primaryKey(),
  body: text("body").notNull(),
});

/** Every catalog the server has served, so any preview's decision can be reproduced. */
export const catalogSnapshots = pgTable("catalog_snapshots", {
  catalogDigest: text("catalog_digest").primaryKey(),
  releaseDigests: text("release_digests").notNull(),
  firstServedAt: timestamp("first_served_at", { withTimezone: true, mode: "date" }).notNull(),
});

/** Offer-bearing previews only, until their offer expires plus retention, unless something was bought. */
export const previews = pgTable(
  "previews",
  {
    previewId: text("preview_id").primaryKey(),
    body: text("body").notNull(),
    releaseDigest: text("release_digest").notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [index("previews_valid_until_idx").on(t.validUntil)],
);

export const resolutionState = pgEnum("resolution_state", ["prepared", "settled", "expired"]);

/**
 * One row per `deriveResolutionId(previewId, payer)`. `prepared` is written
 * before settlement, `settled` after it. `expired` is set by the payment
 * reconciler once an authorization can no longer settle; a new payment may then
 * re-arm the row. One authorization (payer and nonce) backs at most one row,
 * and one settlement settles at most one row.
 */
export const resolutions = pgTable(
  "resolutions",
  {
    resolutionId: text("resolution_id").primaryKey(),
    previewId: text("preview_id").notNull(),
    payer: text("payer").notNull(),
    state: resolutionState("state").notNull(),
    nonce: text("nonce").notNull(),
    validBefore: timestamp("valid_before", { withTimezone: true, mode: "date" }).notNull(),
    settlementRef: text("settlement_ref"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [
    index("resolutions_preview_idx").on(t.previewId),
    index("resolutions_unsettled_idx").on(t.state, t.validBefore),
    uniqueIndex("resolutions_authorization_idx").on(t.payer, t.nonce),
    uniqueIndex("resolutions_settlement_idx").on(t.settlementRef).where(isNotNull(t.settlementRef)),
  ],
);

/** One receipt per settled resolution; the first accepted write wins. `verified` is set by the signature check. */
export const adoptionReceipts = pgTable("adoption_receipts", {
  resolutionId: text("resolution_id").primaryKey(),
  receiptDigest: text("receipt_digest").notNull(),
  body: text("body").notNull(),
  verified: boolean("verified").notNull().default(false),
  receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull(),
});

/** A daily secret that salts profile digests for distinct counting; deleted when its day closes. */
export const demandSalts = pgTable("demand_salts", {
  day: date("day", { mode: "string" }).primaryKey(),
  salt: text("salt").notNull(),
});

/** Salted profile digests and salted client sources per demand bucket, for open days only. */
export const demandSeen = pgTable(
  "demand_seen",
  {
    day: date("day", { mode: "string" }).notNull(),
    bucket: text("bucket").notNull(),
    saltedDigest: text("salted_digest").notNull(),
    saltedSource: text("salted_source").notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.bucket, t.saltedDigest, t.saltedSource] })],
);

/**
 * Closed days: distinct profiles and distinct sources per bucket. Only buckets
 * with at least k of each are ever published.
 */
export const demandDaily = pgTable(
  "demand_daily",
  {
    day: date("day", { mode: "string" }).notNull(),
    bucket: text("bucket").notNull(),
    profiles: integer("profiles").notNull(),
    sources: integer("sources").notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.bucket] })],
);
