CREATE TABLE "podcast_episodes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"source_narration_id" text NOT NULL,
	"master_narration_id" text NOT NULL,
	"language" text NOT NULL,
	"title" text NOT NULL,
	"units" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skipped_block_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"coverage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"chapters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mix_plan" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mix_note" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attribution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "master_narrations" ADD COLUMN "variant" text DEFAULT 'MASTER' NOT NULL;--> statement-breakpoint
ALTER TABLE "podcast_episodes" ADD CONSTRAINT "podcast_episodes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "podcast_episodes" ADD CONSTRAINT "podcast_episodes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "podcast_episodes_project_idx" ON "podcast_episodes" USING btree ("project_id","created_at");