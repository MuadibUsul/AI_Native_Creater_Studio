CREATE TABLE "custom_motion_component_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"component_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"code" text NOT NULL,
	"code_sha256" text NOT NULL,
	"dependencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input" jsonb NOT NULL,
	"validation" jsonb NOT NULL,
	"source_storage_key" text NOT NULL,
	"frames_storage_key" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_motion_components" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"scene_id" text NOT NULL,
	"name" text NOT NULL,
	"latest_version_number" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_motion_component_versions" ADD CONSTRAINT "custom_motion_component_versions_component_id_custom_motion_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."custom_motion_components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_motion_component_versions" ADD CONSTRAINT "custom_motion_component_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_motion_components" ADD CONSTRAINT "custom_motion_components_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_motion_components" ADD CONSTRAINT "custom_motion_components_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_motion_components" ADD CONSTRAINT "custom_motion_components_scene_id_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_motion_component_versions_uq" ON "custom_motion_component_versions" USING btree ("component_id","version_number");--> statement-breakpoint
CREATE INDEX "custom_motion_component_versions_ws_idx" ON "custom_motion_component_versions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "custom_motion_components_project_idx" ON "custom_motion_components" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "custom_motion_components_scene_idx" ON "custom_motion_components" USING btree ("scene_id");