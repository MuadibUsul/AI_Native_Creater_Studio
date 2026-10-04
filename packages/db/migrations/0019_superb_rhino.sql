CREATE TABLE "narration_blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"chapter_id" text,
	"claim_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"estimated_duration_ms" integer NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "narrative_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"document_id" text,
	"revision" integer NOT NULL,
	"title" text NOT NULL,
	"thesis" text NOT NULL,
	"hook" text NOT NULL,
	"ending" text NOT NULL,
	"chapters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"key_claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_visual_facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"estimated_duration_ms" integer NOT NULL,
	"target_duration_ms" integer,
	"generation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "narration_blocks" ADD CONSTRAINT "narration_blocks_plan_id_narrative_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."narrative_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narration_blocks" ADD CONSTRAINT "narration_blocks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrative_plans" ADD CONSTRAINT "narrative_plans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narrative_plans" ADD CONSTRAINT "narrative_plans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "narration_blocks_plan_position_uq" ON "narration_blocks" USING btree ("plan_id","position");--> statement-breakpoint
CREATE INDEX "narration_blocks_plan_idx" ON "narration_blocks" USING btree ("plan_id","position");--> statement-breakpoint
CREATE INDEX "narration_blocks_workspace_idx" ON "narration_blocks" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "narrative_plans_project_revision_uq" ON "narrative_plans" USING btree ("project_id","revision");--> statement-breakpoint
CREATE INDEX "narrative_plans_project_idx" ON "narrative_plans" USING btree ("project_id","created_at");