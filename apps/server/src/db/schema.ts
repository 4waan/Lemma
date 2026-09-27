import { isNull } from "drizzle-orm";
import { bigint, boolean, date, index, integer, numeric, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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

/** Salted buyer passes per demand bucket, for open days only: previews from bridges that have bought before. */
export const demandBuyersSeen = pgTable(
  "demand_buyers_seen",
  {
    day: date("day", { mode: "string" }).notNull(),
    bucket: text("bucket").notNull(),
    saltedBuyer: text("salted_buyer").notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.bucket, t.saltedBuyer] })],
);

/**
 * Closed days: distinct profiles, distinct sources and distinct buyer passes
 * per bucket. Only buckets with at least k profiles and k sources are ever
 * published.
 */
export const demandDaily = pgTable(
  "demand_daily",
  {
    day: date("day", { mode: "string" }).notNull(),
    bucket: text("bucket").notNull(),
    profiles: integer("profiles").notNull(),
    sources: integer("sources").notNull(),
    buyers: integer("buyers").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.bucket] })],
);

/**
 * Buyer passes the server handed out, by their SHA-256 only: no resolution,
 * wallet or time next to them, so the table cannot say who bought what. A
 * pass is issued once a purchase settled, and is the same for the same
 * resolution, so each pass cost one purchase.
 */
export const buyerPasses = pgTable("buyer_passes", {
  passDigest: text("pass_digest").primaryKey(),
});

export const warrantyActionKind = pgEnum("warranty_action_kind", ["activate", "finalize", "expire", "withdraw"]);
export const warrantyActionState = pgEnum("warranty_action_state", ["review", "queued", "sent", "done", "skipped", "abandoned"]);

/**
 * The warranty outbox: one action per resolution and kind (activate, finalize,
 * expire, withdraw), written before anything is sent. `payload` is the
 * canonical JSON of the core schema it carries (a voucher, an outcome, a
 * withdrawal, or only the resolution), re-parsed on read; `signature` is the
 * provider's or evaluator's EIP-712 signature over it. `attempts` counts sends
 * begun: once it is above zero a transaction may be out, so the job reads
 * `tx_hash`'s receipt and the registry's state before it ever sends again.
 * Updates are compare-and-set on the state and attempts read. A withdrawal's
 * claim secret and refund address stay in its payload only until it is over.
 */
export const warrantyActions = pgTable(
  "warranty_actions",
  {
    resolutionId: text("resolution_id").notNull(),
    kind: warrantyActionKind("kind").notNull(),
    payload: text("payload").notNull(),
    signature: text("signature"),
    state: warrantyActionState("state").notNull(),
    txHash: text("tx_hash"),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }).notNull(),
    lastCode: text("last_code"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.resolutionId, t.kind] }), index("warranty_actions_due_idx").on(t.kind, t.state, t.nextAttemptAt)],
);

/**
 * The warranty registry's logs, as the indexer read them: one row per log,
 * with its block's timestamp; the only source of chain facts the server
 * shows (states, deadlines, verdicts, transaction hashes). Columns an event
 * does not have are null. An activation's payment reference is never stored.
 * `amount` is atomic USDC; `claim_deadline` is the deadline set at activation,
 * in Unix seconds.
 */
export const registryEvents = pgTable(
  "registry_events",
  {
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    logIndex: integer("log_index").notNull(),
    txHash: text("tx_hash").notNull(),
    blockTime: timestamp("block_time", { withTimezone: true, mode: "date" }).notNull(),
    name: text("name").notNull(),
    resolutionId: text("resolution_id"),
    releaseDigest: text("release_digest"),
    profileIndex: integer("profile_index"),
    verdict: integer("verdict"),
    weightBps: integer("weight_bps"),
    evidenceHash: text("evidence_hash"),
    amount: numeric("amount", { precision: 78, scale: 0 }),
    claimDeadline: bigint("claim_deadline", { mode: "bigint" }),
    engine: text("engine"),
  },
  (t) => [
    primaryKey({ columns: [t.txHash, t.logIndex] }),
    index("registry_events_order_idx").on(t.blockNumber, t.logIndex),
    index("registry_events_resolution_idx").on(t.resolutionId, t.name),
  ],
);

/** Where each chain reader goes on: the next block the warranty indexer reads. Moved only together with that range's rows. */
export const chainCursors = pgTable("chain_cursors", {
  name: text("name").primaryKey(),
  nextBlock: bigint("next_block", { mode: "bigint" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
});
