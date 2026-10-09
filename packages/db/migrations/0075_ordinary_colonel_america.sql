CREATE TABLE "media_evidence_caches" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_asset_version_id" text NOT NULL,
	"cache_key" text NOT NULL,
	"consumer" text NOT NULL,
	"source_start_pts" text,
	"source_end_pts" text,
	"time_base_numerator" integer,
	"time_base_denominator" integer,
	"requested_kind" text,
	"analysis_config_hash" text NOT NULL,
	"index_fingerprint" text NOT NULL,
	"permission_context_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"analysis_read_count" integer DEFAULT 1 NOT NULL,
	"range_read_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_evidence_caches_consumer_ck" CHECK ("media_evidence_caches"."consumer" in ('DIRECTOR','SELECTION','REFERENCE_ANALYSIS')),
	CONSTRAINT "media_evidence_caches_key_ck" CHECK ("media_evidence_caches"."cache_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "media_evidence_caches_config_ck" CHECK ("media_evidence_caches"."analysis_config_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "media_evidence_caches_fingerprint_ck" CHECK ("media_evidence_caches"."index_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "media_evidence_caches_permission_ck" CHECK ("media_evidence_caches"."permission_context_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "media_evidence_caches_usage_ck" CHECK ("media_evidence_caches"."hit_count" >= 0 and "media_evidence_caches"."analysis_read_count" >= 0 and "media_evidence_caches"."range_read_count" >= 0),
	CONSTRAINT "media_evidence_caches_range_ck" CHECK (("media_evidence_caches"."source_start_pts" is null and "media_evidence_caches"."source_end_pts" is null and "media_evidence_caches"."time_base_numerator" is null and "media_evidence_caches"."time_base_denominator" is null) or ("media_evidence_caches"."source_start_pts" ~ '^-?[0-9]+$' and "media_evidence_caches"."source_end_pts" ~ '^-?[0-9]+$' and "media_evidence_caches"."time_base_numerator" > 0 and "media_evidence_caches"."time_base_denominator" > 0))
);
--> statement-breakpoint
ALTER TABLE "media_evidence_caches" ADD CONSTRAINT "media_evidence_caches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_evidence_caches" ADD CONSTRAINT "media_evidence_caches_source_asset_version_id_asset_versions_id_fk" FOREIGN KEY ("source_asset_version_id") REFERENCES "public"."asset_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_evidence_caches_key_uq" ON "media_evidence_caches" USING btree ("cache_key");--> statement-breakpoint
CREATE INDEX "media_evidence_caches_workspace_source_idx" ON "media_evidence_caches" USING btree ("workspace_id","source_asset_version_id");