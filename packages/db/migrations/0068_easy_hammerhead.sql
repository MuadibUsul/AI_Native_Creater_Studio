CREATE TABLE "media_range_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"source_asset_version_id" text NOT NULL,
	"label" text NOT NULL,
	"source_start_pts" text NOT NULL,
	"source_end_pts" text NOT NULL,
	"time_base_numerator" integer NOT NULL,
	"time_base_denominator" integer NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_range_tags_pts_ck" CHECK ("media_range_tags"."source_start_pts" ~ '^-?[0-9]+$' and "media_range_tags"."source_end_pts" ~ '^-?[0-9]+$'),
	CONSTRAINT "media_range_tags_positive_range_ck" CHECK (("media_range_tags"."source_end_pts")::numeric > ("media_range_tags"."source_start_pts")::numeric),
	CONSTRAINT "media_range_tags_time_base_ck" CHECK ("media_range_tags"."time_base_numerator" > 0 and "media_range_tags"."time_base_denominator" > 0)
);
--> statement-breakpoint
ALTER TABLE "media_range_tags" ADD CONSTRAINT "media_range_tags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_range_tags" ADD CONSTRAINT "media_range_tags_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_range_tags" ADD CONSTRAINT "media_range_tags_source_asset_version_id_asset_versions_id_fk" FOREIGN KEY ("source_asset_version_id") REFERENCES "public"."asset_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_range_tags" ADD CONSTRAINT "media_range_tags_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_range_tags_workspace_asset_idx" ON "media_range_tags" USING btree ("workspace_id","asset_id","created_at");--> statement-breakpoint
CREATE INDEX "media_range_tags_workspace_label_idx" ON "media_range_tags" USING btree ("workspace_id","label");