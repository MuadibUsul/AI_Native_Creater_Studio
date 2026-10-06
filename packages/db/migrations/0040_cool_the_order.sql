CREATE TABLE "narration_translations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"narrative_plan_id" text NOT NULL,
	"source_narration_id" text NOT NULL,
	"derived_narration_id" text NOT NULL,
	"target_language" text NOT NULL,
	"units" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"numbers_check" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"entities_check" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terminology_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"source_term" text NOT NULL,
	"target_language" text NOT NULL,
	"target_term" text NOT NULL,
	"kind" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "master_narrations" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "narration_translations" ADD CONSTRAINT "narration_translations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narration_translations" ADD CONSTRAINT "narration_translations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminology_entries" ADD CONSTRAINT "terminology_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminology_entries" ADD CONSTRAINT "terminology_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "narration_translations_project_idx" ON "narration_translations" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "terminology_entries_term_language_uq" ON "terminology_entries" USING btree ("project_id","source_term","target_language");--> statement-breakpoint
CREATE INDEX "terminology_entries_project_idx" ON "terminology_entries" USING btree ("project_id","target_language");