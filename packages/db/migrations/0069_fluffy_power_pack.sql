CREATE TABLE "asset_derivation_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_asset_id" text NOT NULL,
	"source_asset_version_id" text NOT NULL,
	"derived_asset_id" text NOT NULL,
	"derived_asset_version_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_derivation_edges_distinct_ck" CHECK ("asset_derivation_edges"."source_asset_version_id" <> "asset_derivation_edges"."derived_asset_version_id"),
	CONSTRAINT "asset_derivation_edges_kind_ck" CHECK (length(btrim("asset_derivation_edges"."kind")) between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "sensitivity_class" text DEFAULT 'INTERNAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "privacy_deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "privacy_deletion_requested_by" text;--> statement-breakpoint
ALTER TABLE "asset_derivation_edges" ADD CONSTRAINT "asset_derivation_edges_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_derivation_edges" ADD CONSTRAINT "asset_derivation_edges_source_asset_id_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_derivation_edges" ADD CONSTRAINT "asset_derivation_edges_source_asset_version_id_asset_versions_id_fk" FOREIGN KEY ("source_asset_version_id") REFERENCES "public"."asset_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_derivation_edges" ADD CONSTRAINT "asset_derivation_edges_derived_asset_id_assets_id_fk" FOREIGN KEY ("derived_asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_derivation_edges" ADD CONSTRAINT "asset_derivation_edges_derived_asset_version_id_asset_versions_id_fk" FOREIGN KEY ("derived_asset_version_id") REFERENCES "public"."asset_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_derivation_edges_identity_uq" ON "asset_derivation_edges" USING btree ("source_asset_version_id","derived_asset_version_id","kind");--> statement-breakpoint
CREATE INDEX "asset_derivation_edges_workspace_source_idx" ON "asset_derivation_edges" USING btree ("workspace_id","source_asset_id");--> statement-breakpoint
CREATE INDEX "asset_derivation_edges_workspace_derived_idx" ON "asset_derivation_edges" USING btree ("workspace_id","derived_asset_id");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_privacy_deletion_requested_by_user_id_fk" FOREIGN KEY ("privacy_deletion_requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_sensitivity_class_ck" CHECK ("assets"."sensitivity_class" in ('PUBLIC','INTERNAL','SENSITIVE','RESTRICTED'));
