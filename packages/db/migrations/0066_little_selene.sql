CREATE TABLE "media_index_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"ordinal" integer NOT NULL,
	"source_start_pts" text NOT NULL,
	"source_end_pts" text NOT NULL,
	"time_base_numerator" integer NOT NULL,
	"time_base_denominator" integer NOT NULL,
	"confidence_permille" integer,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"storage_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_index_entries_kind_ck" CHECK ("media_index_entries"."kind" in ('THUMBNAIL','WAVEFORM','SHOT','QUALITY')),
	CONSTRAINT "media_index_entries_ordinal_ck" CHECK ("media_index_entries"."ordinal" >= 0),
	CONSTRAINT "media_index_entries_pts_ck" CHECK ("media_index_entries"."source_start_pts" ~ '^-?[0-9]+$' and "media_index_entries"."source_end_pts" ~ '^-?[0-9]+$'),
	CONSTRAINT "media_index_entries_time_base_ck" CHECK ("media_index_entries"."time_base_numerator" > 0 and "media_index_entries"."time_base_denominator" > 0),
	CONSTRAINT "media_index_entries_confidence_ck" CHECK ("media_index_entries"."confidence_permille" is null or "media_index_entries"."confidence_permille" between 0 and 1000)
);
--> statement-breakpoint
CREATE TABLE "media_index_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_asset_version_id" text NOT NULL,
	"source_checksum_sha256" text NOT NULL,
	"processor_version" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"coverage_permille" integer DEFAULT 0 NOT NULL,
	"checkpoint_ms" integer DEFAULT 0 NOT NULL,
	"error_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_index_runs_status_ck" CHECK ("media_index_runs"."status" in ('QUEUED','RUNNING','PARTIAL','READY','EMPTY','FAILED','STALE')),
	CONSTRAINT "media_index_runs_coverage_ck" CHECK ("media_index_runs"."coverage_permille" between 0 and 1000),
	CONSTRAINT "media_index_runs_checkpoint_ck" CHECK ("media_index_runs"."checkpoint_ms" >= 0),
	CONSTRAINT "media_index_runs_checksum_ck" CHECK ("media_index_runs"."source_checksum_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD CONSTRAINT "media_index_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD CONSTRAINT "media_index_entries_run_id_media_index_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."media_index_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_index_runs" ADD CONSTRAINT "media_index_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_index_runs" ADD CONSTRAINT "media_index_runs_source_asset_version_id_asset_versions_id_fk" FOREIGN KEY ("source_asset_version_id") REFERENCES "public"."asset_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_index_entries_run_kind_ordinal_uq" ON "media_index_entries" USING btree ("run_id","kind","ordinal");--> statement-breakpoint
CREATE INDEX "media_index_entries_workspace_run_kind_idx" ON "media_index_entries" USING btree ("workspace_id","run_id","kind","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "media_index_runs_source_processor_uq" ON "media_index_runs" USING btree ("source_asset_version_id","processor_version");--> statement-breakpoint
CREATE INDEX "media_index_runs_workspace_source_idx" ON "media_index_runs" USING btree ("workspace_id","source_asset_version_id");