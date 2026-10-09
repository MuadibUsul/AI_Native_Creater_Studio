CREATE TABLE "media_analysis_stages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_asset_version_id" text NOT NULL,
	"stage" text NOT NULL,
	"status" text DEFAULT 'NOT_REQUESTED' NOT NULL,
	"dependencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"coverage_permille" integer DEFAULT 0 NOT NULL,
	"checkpoint" jsonb DEFAULT '{"cursor":null,"completedUnits":0,"totalUnits":null}'::jsonb NOT NULL,
	"detector_config_hash" text NOT NULL,
	"input_fingerprint" text NOT NULL,
	"job_id" text,
	"budget_micros" integer,
	"spent_micros" integer DEFAULT 0 NOT NULL,
	"error_summary" text,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_analysis_stages_name_ck" CHECK ("media_analysis_stages"."stage" in ('PROBE','PROXY','WAVEFORM','ASR','SHOT','SAMPLING','VISION','OCR','AUDIO','EMBEDDINGS','SEARCH_INDEX')),
	CONSTRAINT "media_analysis_stages_status_ck" CHECK ("media_analysis_stages"."status" in ('NOT_REQUESTED','QUEUED','RUNNING','PARTIAL','READY','EMPTY','FAILED','DISABLED','STALE','CANCEL_REQUESTED','CANCELLED')),
	CONSTRAINT "media_analysis_stages_coverage_ck" CHECK ("media_analysis_stages"."coverage_permille" between 0 and 1000),
	CONSTRAINT "media_analysis_stages_config_hash_ck" CHECK ("media_analysis_stages"."detector_config_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "media_analysis_stages_input_hash_ck" CHECK ("media_analysis_stages"."input_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "media_analysis_stages_cost_ck" CHECK ("media_analysis_stages"."spent_micros" >= 0 and ("media_analysis_stages"."budget_micros" is null or "media_analysis_stages"."budget_micros" >= 0))
);
--> statement-breakpoint
ALTER TABLE "media_analysis_stages" ADD CONSTRAINT "media_analysis_stages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_analysis_stages" ADD CONSTRAINT "media_analysis_stages_source_asset_version_id_asset_versions_id_fk" FOREIGN KEY ("source_asset_version_id") REFERENCES "public"."asset_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_analysis_stages" ADD CONSTRAINT "media_analysis_stages_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_analysis_stages_source_stage_uq" ON "media_analysis_stages" USING btree ("source_asset_version_id","stage");--> statement-breakpoint
CREATE INDEX "media_analysis_stages_workspace_source_idx" ON "media_analysis_stages" USING btree ("workspace_id","source_asset_version_id");--> statement-breakpoint
CREATE INDEX "media_analysis_stages_workspace_status_idx" ON "media_analysis_stages" USING btree ("workspace_id","status");