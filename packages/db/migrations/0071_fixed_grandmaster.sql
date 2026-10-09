ALTER TABLE "media_index_entries" ADD COLUMN "stream_id" text;--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD COLUMN "payload_schema_version" text DEFAULT '1.0' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD COLUMN "evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD COLUMN "observed_by" text DEFAULT 'ffmpeg-source-media-indexer' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD COLUMN "observed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD COLUMN "basis" text DEFAULT 'MEASURED' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD COLUMN "confidence_method" text;--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD COLUMN "calibration_status" text DEFAULT 'UNCALIBRATED' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD COLUMN "tool_id" text DEFAULT 'ffmpeg' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD COLUMN "tool_version" text DEFAULT 'source-index-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD COLUMN "model_version" text;--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD COLUMN "analysis_config_hash" text DEFAULT '5718708ba312bf304e8b86a3f160ffa383a565b1dea6163806a8a4bc0a8eb585' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD COLUMN "index_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD COLUMN "supersedes_record_id" text;--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD COLUMN "correction_record_id" text;--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD COLUMN "privacy_class" text DEFAULT 'WORKSPACE' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD COLUMN "access_policy_ref" text DEFAULT 'workspace:read' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD COLUMN "lifecycle_state" text DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_index_runs" ADD COLUMN "analysis_config_hash" text DEFAULT '5718708ba312bf304e8b86a3f160ffa383a565b1dea6163806a8a4bc0a8eb585' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_index_runs" ADD COLUMN "index_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_index_runs" ADD COLUMN "tool_id" text DEFAULT 'ffmpeg' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_index_runs" ADD COLUMN "tool_version" text DEFAULT 'source-index-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_index_runs" ADD COLUMN "supported_kinds" jsonb DEFAULT '["THUMBNAIL","WAVEFORM","SHOT_BOUNDARY","QUALITY"]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "media_index_entries" AS entry
SET
  "evidence_refs" = jsonb_build_array(jsonb_build_object(
    'type', CASE WHEN entry."kind" = 'THUMBNAIL' THEN 'FRAME' WHEN entry."kind" = 'WAVEFORM' THEN 'AUDIO_WINDOW' ELSE 'SOURCE_RANGE' END,
    'refId', entry."id",
    'sourceRange', jsonb_build_object(
      'startPts', entry."source_start_pts",
      'endPts', entry."source_end_pts",
      'timeBase', jsonb_build_object('numerator', entry."time_base_numerator", 'denominator', entry."time_base_denominator")
    )
  )),
  "observed_at" = run."updated_at",
  "privacy_class" = CASE WHEN asset."sensitivity_class" IN ('SENSITIVE', 'RESTRICTED') THEN 'SENSITIVE' ELSE 'WORKSPACE' END
FROM "media_index_runs" AS run
JOIN "asset_versions" AS version ON version."id" = run."source_asset_version_id"
JOIN "assets" AS asset ON asset."id" = version."asset_id"
WHERE entry."run_id" = run."id";--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD CONSTRAINT "media_index_entries_basis_ck" CHECK ("media_index_entries"."basis" in ('MEASURED','MODEL_INFERRED','USER_SUPPLIED','USER_CONFIRMED'));--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD CONSTRAINT "media_index_entries_calibration_ck" CHECK ("media_index_entries"."calibration_status" in ('NOT_APPLICABLE','UNCALIBRATED','CALIBRATED','USER_CONFIRMED'));--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD CONSTRAINT "media_index_entries_config_hash_ck" CHECK ("media_index_entries"."analysis_config_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD CONSTRAINT "media_index_entries_index_version_ck" CHECK ("media_index_entries"."index_version" > 0);--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD CONSTRAINT "media_index_entries_privacy_ck" CHECK ("media_index_entries"."privacy_class" in ('WORKSPACE','SENSITIVE'));--> statement-breakpoint
ALTER TABLE "media_index_entries" ADD CONSTRAINT "media_index_entries_lifecycle_ck" CHECK ("media_index_entries"."lifecycle_state" in ('ACTIVE','STALE','DELETED'));--> statement-breakpoint
ALTER TABLE "media_index_runs" ADD CONSTRAINT "media_index_runs_config_hash_ck" CHECK ("media_index_runs"."analysis_config_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "media_index_runs" ADD CONSTRAINT "media_index_runs_index_version_ck" CHECK ("media_index_runs"."index_version" > 0);
