CREATE TABLE "asset_relinks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"target_version_id" text NOT NULL,
	"candidate_asset_id" text NOT NULL,
	"candidate_version_id" text NOT NULL,
	"action" text NOT NULL,
	"candidate_checksum_sha256" text NOT NULL,
	"validation" jsonb NOT NULL,
	"created_version_id" text,
	"active_clip_references_preserved" integer DEFAULT 0 NOT NULL,
	"review_required" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_relinks_action_ck" CHECK ("asset_relinks"."action" in ('EXACT_RESTORE','REPLACEMENT')),
	CONSTRAINT "asset_relinks_checksum_ck" CHECK ("asset_relinks"."candidate_checksum_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "asset_relinks" ADD CONSTRAINT "asset_relinks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_relinks" ADD CONSTRAINT "asset_relinks_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_relinks" ADD CONSTRAINT "asset_relinks_target_version_id_asset_versions_id_fk" FOREIGN KEY ("target_version_id") REFERENCES "public"."asset_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_relinks" ADD CONSTRAINT "asset_relinks_candidate_asset_id_assets_id_fk" FOREIGN KEY ("candidate_asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_relinks" ADD CONSTRAINT "asset_relinks_candidate_version_id_asset_versions_id_fk" FOREIGN KEY ("candidate_version_id") REFERENCES "public"."asset_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_relinks" ADD CONSTRAINT "asset_relinks_created_version_id_asset_versions_id_fk" FOREIGN KEY ("created_version_id") REFERENCES "public"."asset_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_relinks" ADD CONSTRAINT "asset_relinks_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_relinks_workspace_asset_idx" ON "asset_relinks" USING btree ("workspace_id","asset_id","created_at");--> statement-breakpoint
CREATE INDEX "asset_relinks_target_version_idx" ON "asset_relinks" USING btree ("target_version_id");