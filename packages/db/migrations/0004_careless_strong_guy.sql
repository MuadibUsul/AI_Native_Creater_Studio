CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"channel_style_version_id" text NOT NULL,
	"title" text NOT NULL,
	"source_type" text DEFAULT 'MANUAL_SCRIPT' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"aspect_ratio" text NOT NULL,
	"resolution" text NOT NULL,
	"fps" integer DEFAULT 30 NOT NULL,
	"target_duration_ms" integer,
	"current_version_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scenes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"position" integer NOT NULL,
	"start_ms" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"semantic_type" text NOT NULL,
	"scene_type" text NOT NULL,
	"narration_block_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"narration" text DEFAULT '' NOT NULL,
	"visual_intent" text DEFAULT '' NOT NULL,
	"component_id" text,
	"component_version" text,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_requirement" jsonb,
	"source_bindings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data_bindings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"asset_bindings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"transition" jsonb DEFAULT '{"in":null,"out":null}'::jsonb NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'EMPTY' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_channel_style_version_id_channel_style_versions_id_fk" FOREIGN KEY ("channel_style_version_id") REFERENCES "public"."channel_style_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projects_workspace_idx" ON "projects" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "projects_channel_idx" ON "projects" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "scenes_project_position_idx" ON "scenes" USING btree ("project_id","position");--> statement-breakpoint
CREATE INDEX "scenes_workspace_idx" ON "scenes" USING btree ("workspace_id");