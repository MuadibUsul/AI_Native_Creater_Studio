DROP INDEX "jobs_claim_idx";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","next_attempt_at","priority","created_at");