CREATE TABLE "render_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"render_id" text NOT NULL,
	"seq" integer NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "renders" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"profile" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"input" jsonb NOT NULL,
	"estimated_cost" jsonb,
	"manifest_hash" text,
	"output_asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "render_events" ADD CONSTRAINT "render_events_render_id_renders_id_fk" FOREIGN KEY ("render_id") REFERENCES "public"."renders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "render_events_render_idx" ON "render_events" USING btree ("render_id","seq");--> statement-breakpoint
CREATE INDEX "renders_project_idx" ON "renders" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "renders_status_idx" ON "renders" USING btree ("status");