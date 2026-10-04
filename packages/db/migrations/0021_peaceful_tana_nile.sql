CREATE TABLE "master_narrations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"narrative_plan_id" text NOT NULL,
	"narrative_plan_revision" integer NOT NULL,
	"asset_id" text,
	"asset_version_id" text,
	"mime_type" text,
	"size_bytes" integer,
	"checksum_sha256" text,
	"total_duration_ms" integer NOT NULL,
	"alignment_method" text NOT NULL,
	"segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"voice_identity_id" text,
	"voice_identity_version" integer,
	"speech_profile_id" text,
	"speech_profile_version" integer,
	"cache_stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "master_narrations" ADD CONSTRAINT "master_narrations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_narrations" ADD CONSTRAINT "master_narrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "master_narrations_project_idx" ON "master_narrations" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "master_narrations_plan_idx" ON "master_narrations" USING btree ("narrative_plan_id","narrative_plan_revision");