import { isNull } from "drizzle-orm";
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
 * re-arm the row. One authorization (payer and nonce) backs at most one row
 * and settles it once. `settlement_ref` is the transaction that used the row's
 * authorization. It is not unique: anyone may submit EIP-3009 authorizations,
 * and one transaction can use several, each a payment of its own.
 * `claim_hash` is the buyer's warranty credit commitment (core
 * `warrantyClaimHash`), null for resolutions bought without one.
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
    claimHash: text("claim_hash"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [
    index("resolutions_preview_idx").on(t.previewId),
    index("resolutions_unsettled_idx").on(t.state, t.validBefore),
    uniqueIndex("resolutions_authorization_idx").on(t.payer, t.nonce),
  ],
);

/**
 * One receipt per settled resolution; the first accepted write wins. The
 * signature check sets `checked_at` when it reaches a verdict, and `verified`
 * only when the signature is the resolution buyer's. A check that could not
 * run (the chain was unreachable) leaves both, so it runs again.
 * `buyer_agent_id` is the ERC-8004 agent id a buyer's bridge opted in with (LEMMA_AGENT_ID), if any.
 */
export const adoptionReceipts = pgTable(
  "adoption_receipts",
  {
    resolutionId: text("resolution_id").primaryKey(),
    receiptDigest: text("receipt_digest").notNull(),
    body: text("body").notNull(),
    verified: boolean("verified").notNull().default(false),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true, mode: "date" }),
    buyerAgentId: text("buyer_agent_id"),
  },
  (t) => [index("adoption_receipts_unchecked_idx").on(t.receivedAt).where(isNull(t.checkedAt))],
);

export const reputationTarget = pgEnum("reputation_target", ["provider", "buyer"]);
export const reputationPostState = pgEnum("reputation_post_state", ["pending", "posted", "skipped"]);

/**
 * The ERC-8004 attester's ledger: one feedback per finalized outcome and
 * target (the provider's agent, or a buyer agent that opted in). Each row's
 * feedback file (its own, since the file names the agent) is kept as the bytes
 * served, so `feedback_hash` always matches them.
 * `attempts` counts sends begun; once it is above zero, the attester looks for
 * the feedback on chain (from `from_block`) before it ever sends again, so a
 * crash between a send and this row's update never double-posts.
 */
export const reputationPosts = pgTable(
  "reputation_posts",
  {
    resolutionId: text("resolution_id").notNull(),
    target: reputationTarget("target").notNull(),
    agentId: text("agent_id").notNull(),
    capability: text("capability").notNull(),
    value: integer("value").notNull(),
    feedbackHash: text("feedback_hash").notNull(),
    evidence: text("evidence").notNull(),
    state: reputationPostState("state").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }).notNull(),
    fromBlock: text("from_block"),
    txHash: text("tx_hash"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.resolutionId, t.target] }), index("reputation_posts_due_idx").on(t.state, t.nextAttemptAt)],
);

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
