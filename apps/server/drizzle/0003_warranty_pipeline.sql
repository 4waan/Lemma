CREATE TYPE "public"."warranty_action_kind" AS ENUM('activate', 'finalize', 'expire', 'withdraw');--> statement-breakpoint
CREATE TYPE "public"."warranty_action_state" AS ENUM('review', 'queued', 'sent', 'done', 'skipped', 'abandoned');--> statement-breakpoint
CREATE TABLE "chain_cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"next_block" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_events" (
	"block_number" bigint NOT NULL,
	"log_index" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"name" text NOT NULL,
	"resolution_id" text,
	"release_digest" text,
	"profile_index" integer,
	"verdict" integer,
	"weight_bps" integer,
	"evidence_hash" text,
	"amount" numeric(78, 0),
	"claim_deadline" bigint,
	"engine" text,
	CONSTRAINT "registry_events_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "warranty_actions" (
	"resolution_id" text NOT NULL,
	"kind" "warranty_action_kind" NOT NULL,
	"payload" text NOT NULL,
	"signature" text,
	"state" "warranty_action_state" NOT NULL,
	"tx_hash" text,
	"sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "warranty_actions_resolution_id_kind_pk" PRIMARY KEY("resolution_id","kind")
);
--> statement-breakpoint
CREATE INDEX "registry_events_order_idx" ON "registry_events" USING btree ("block_number","log_index");--> statement-breakpoint
CREATE INDEX "registry_events_resolution_idx" ON "registry_events" USING btree ("resolution_id","name");--> statement-breakpoint
CREATE INDEX "warranty_actions_due_idx" ON "warranty_actions" USING btree ("kind","state","next_attempt_at");