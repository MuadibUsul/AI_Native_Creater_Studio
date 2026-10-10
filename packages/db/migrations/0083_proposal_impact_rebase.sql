ALTER TABLE "proposals" ADD COLUMN "read_set" jsonb;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "write_set" jsonb;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "write_targets" jsonb;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "asset_version_signature" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "rebase_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "rebased_from_revision" integer;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "rebase_log" jsonb;
