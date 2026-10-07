CREATE TABLE "scene_performance" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"project_version_id" text NOT NULL,
	"video_performance_id" text NOT NULL,
	"scene_id" text NOT NULL,
	"scene_type" text NOT NULL,
	"position" integer NOT NULL,
	"start_ms" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"retention_rate" double precision,
	"interpretation" text DEFAULT 'CORRELATION_ONLY' NOT NULL,
	"derivation" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scene_performance" ADD CONSTRAINT "scene_performance_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_performance" ADD CONSTRAINT "scene_performance_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_performance" ADD CONSTRAINT "scene_performance_project_version_id_project_versions_id_fk" FOREIGN KEY ("project_version_id") REFERENCES "public"."project_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_performance" ADD CONSTRAINT "scene_performance_video_performance_id_video_performance_id_fk" FOREIGN KEY ("video_performance_id") REFERENCES "public"."video_performance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scene_performance_sample_scene_uq" ON "scene_performance" USING btree ("video_performance_id","scene_id");--> statement-breakpoint
CREATE INDEX "scene_performance_project_idx" ON "scene_performance" USING btree ("project_id","created_at");