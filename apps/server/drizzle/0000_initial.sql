CREATE TYPE "public"."resolution_state" AS ENUM('prepared', 'settled', 'expired');--> statement-breakpoint
CREATE TABLE "adoption_receipts" (
	"resolution_id" text PRIMARY KEY NOT NULL,
	"receipt_digest" text NOT NULL,
	"body" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bundles" (
	"payload_digest" text PRIMARY KEY NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_snapshots" (
	"catalog_digest" text PRIMARY KEY NOT NULL,
	"release_digests" text NOT NULL,
	"first_served_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demand_daily" (
	"day" date NOT NULL,
	"bucket" text NOT NULL,
	"profiles" integer NOT NULL,
	"sources" integer NOT NULL,
	CONSTRAINT "demand_daily_day_bucket_pk" PRIMARY KEY("day","bucket")
);
--> statement-breakpoint
CREATE TABLE "demand_salts" (
	"day" date PRIMARY KEY NOT NULL,
	"salt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demand_seen" (
	"day" date NOT NULL,
	"bucket" text NOT NULL,
	"salted_digest" text NOT NULL,
	"salted_source" text NOT NULL,
	CONSTRAINT "demand_seen_day_bucket_salted_digest_salted_source_pk" PRIMARY KEY("day","bucket","salted_digest","salted_source")
);
--> statement-breakpoint
CREATE TABLE "previews" (
	"preview_id" text PRIMARY KEY NOT NULL,
	"body" text NOT NULL,
	"release_digest" text NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"release_digest" text PRIMARY KEY NOT NULL,
	"body" text NOT NULL,
	"first_loaded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resolutions" (
	"resolution_id" text PRIMARY KEY NOT NULL,
	"preview_id" text NOT NULL,
	"payer" text NOT NULL,
	"state" "resolution_state" NOT NULL,
	"nonce" text NOT NULL,
	"valid_before" timestamp with time zone NOT NULL,
	"settlement_ref" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "previews_valid_until_idx" ON "previews" USING btree ("valid_until");--> statement-breakpoint
CREATE INDEX "resolutions_preview_idx" ON "resolutions" USING btree ("preview_id");--> statement-breakpoint
CREATE INDEX "resolutions_unsettled_idx" ON "resolutions" USING btree ("state","valid_before");--> statement-breakpoint
CREATE UNIQUE INDEX "resolutions_authorization_idx" ON "resolutions" USING btree ("payer","nonce");--> statement-breakpoint
CREATE UNIQUE INDEX "resolutions_settlement_idx" ON "resolutions" USING btree ("settlement_ref") WHERE "resolutions"."settlement_ref" is not null;