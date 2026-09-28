CREATE TABLE "buyer_passes" (
	"pass_digest" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demand_buyers_seen" (
	"day" date NOT NULL,
	"bucket" text NOT NULL,
	"salted_buyer" text NOT NULL,
	CONSTRAINT "demand_buyers_seen_day_bucket_salted_buyer_pk" PRIMARY KEY("day","bucket","salted_buyer")
);
--> statement-breakpoint
ALTER TABLE "demand_daily" ADD COLUMN "buyers" integer DEFAULT 0 NOT NULL;