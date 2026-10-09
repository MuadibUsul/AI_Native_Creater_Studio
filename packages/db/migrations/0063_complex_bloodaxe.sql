CREATE TABLE "media_derivatives" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_asset_version_id" text NOT NULL,
	"kind" text NOT NULL,
	"profile_key" text NOT NULL,
	"status" text NOT NULL,
	"derivative_asset_version_id" text,
	"source_checksum_sha256" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_derivatives_kind_ck" CHECK ("media_derivatives"."kind" in ('PROXY','ANALYSIS')),
	CONSTRAINT "media_derivatives_status_ck" CHECK ("media_derivatives"."status" in ('PENDING','PROCESSING','READY','FAILED')),
	CONSTRAINT "media_derivatives_profile_key_ck" CHECK (length(btrim("media_derivatives"."profile_key")) between 1 and 120),
	CONSTRAINT "media_derivatives_source_checksum_ck" CHECK ("media_derivatives"."source_checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "media_derivatives_distinct_output_ck" CHECK ("media_derivatives"."derivative_asset_version_id" is null or "media_derivatives"."derivative_asset_version_id" <> "media_derivatives"."source_asset_version_id"),
	CONSTRAINT "media_derivatives_ready_proxy_output_ck" CHECK ("media_derivatives"."kind" <> 'PROXY' or "media_derivatives"."status" <> 'READY' or "media_derivatives"."derivative_asset_version_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "media_derivatives" ADD CONSTRAINT "media_derivatives_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_derivatives" ADD CONSTRAINT "media_derivatives_source_asset_version_id_asset_versions_id_fk" FOREIGN KEY ("source_asset_version_id") REFERENCES "public"."asset_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_derivatives" ADD CONSTRAINT "media_derivatives_derivative_asset_version_id_asset_versions_id_fk" FOREIGN KEY ("derivative_asset_version_id") REFERENCES "public"."asset_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_derivatives_source_profile_uq" ON "media_derivatives" USING btree ("source_asset_version_id","kind","profile_key");--> statement-breakpoint
CREATE INDEX "media_derivatives_workspace_source_idx" ON "media_derivatives" USING btree ("workspace_id","source_asset_version_id");--> statement-breakpoint
CREATE INDEX "media_derivatives_output_idx" ON "media_derivatives" USING btree ("derivative_asset_version_id");