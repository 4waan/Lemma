CREATE TYPE "public"."reputation_post_state" AS ENUM('pending', 'posted', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."reputation_target" AS ENUM('provider', 'buyer');--> statement-breakpoint
CREATE TABLE "reputation_posts" (
	"resolution_id" text NOT NULL,
	"target" "reputation_target" NOT NULL,
	"agent_id" text NOT NULL,
	"capability" text NOT NULL,
	"value" integer NOT NULL,
	"feedback_hash" text NOT NULL,
	"evidence" text NOT NULL,
	"state" "reputation_post_state" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"from_block" text,
	"tx_hash" text,
	"note" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reputation_posts_resolution_id_target_pk" PRIMARY KEY("resolution_id","target")
);
--> statement-breakpoint
ALTER TABLE "adoption_receipts" ADD COLUMN "buyer_agent_id" text;--> statement-breakpoint
CREATE INDEX "reputation_posts_due_idx" ON "reputation_posts" USING btree ("state","next_attempt_at");