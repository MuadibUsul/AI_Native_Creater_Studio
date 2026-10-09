CREATE TABLE "media_transcript_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_asset_version_id" text NOT NULL,
	"source_checksum_sha256" text NOT NULL,
	"processor_version" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"error_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_transcript_runs_status_ck" CHECK ("media_transcript_runs"."status" in ('QUEUED','RUNNING','READY','FAILED','STALE')),
	CONSTRAINT "media_transcript_runs_version_ck" CHECK ("media_transcript_runs"."current_version" >= 0),
	CONSTRAINT "media_transcript_runs_checksum_ck" CHECK ("media_transcript_runs"."source_checksum_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "media_transcript_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"version" integer NOT NULL,
	"source" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"affected_segment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_transcript_versions_version_ck" CHECK ("media_transcript_versions"."version" > 0),
	CONSTRAINT "media_transcript_versions_source_ck" CHECK ("media_transcript_versions"."source" in ('ASR','CORRECTION','TERMINOLOGY'))
);
--> statement-breakpoint
ALTER TABLE "media_transcript_runs" ADD CONSTRAINT "media_transcript_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_transcript_runs" ADD CONSTRAINT "media_transcript_runs_source_asset_version_id_asset_versions_id_fk" FOREIGN KEY ("source_asset_version_id") REFERENCES "public"."asset_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_transcript_versions" ADD CONSTRAINT "media_transcript_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_transcript_versions" ADD CONSTRAINT "media_transcript_versions_run_id_media_transcript_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."media_transcript_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_transcript_versions" ADD CONSTRAINT "media_transcript_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_transcript_runs_source_processor_uq" ON "media_transcript_runs" USING btree ("source_asset_version_id","processor_version");--> statement-breakpoint
CREATE INDEX "media_transcript_runs_workspace_source_idx" ON "media_transcript_runs" USING btree ("workspace_id","source_asset_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_transcript_versions_run_version_uq" ON "media_transcript_versions" USING btree ("run_id","version");--> statement-breakpoint
CREATE INDEX "media_transcript_versions_workspace_run_idx" ON "media_transcript_versions" USING btree ("workspace_id","run_id","version");