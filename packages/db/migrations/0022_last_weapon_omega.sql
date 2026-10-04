ALTER TABLE "provider_generations" ADD COLUMN "result_asset_id" text;--> statement-breakpoint
ALTER TABLE "provider_generations" ADD COLUMN "result_asset_version_id" text;--> statement-breakpoint
ALTER TABLE "provider_generations" ADD COLUMN "rebind_source" text;--> statement-breakpoint
ALTER TABLE "provider_generations" ADD COLUMN "rebound_at" timestamp with time zone;