DROP INDEX "resolutions_settlement_idx";--> statement-breakpoint
ALTER TABLE "adoption_receipts" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "resolutions" ADD COLUMN "claim_hash" text;--> statement-breakpoint
CREATE INDEX "adoption_receipts_unchecked_idx" ON "adoption_receipts" USING btree ("received_at") WHERE "adoption_receipts"."checked_at" is null;