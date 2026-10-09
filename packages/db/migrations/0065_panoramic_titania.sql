ALTER TABLE "asset_versions" ADD COLUMN "probe_status" text DEFAULT 'NOT_REQUIRED' NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_versions" ADD COLUMN "media_probe" jsonb;