CREATE TABLE "render_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"render_id" text NOT NULL,
	"decision" text NOT NULL,
	"manifest_hash_at_approval" text NOT NULL,
	"project_version_id_at_approval" text NOT NULL,
	"project_revision_at_approval" integer NOT NULL,
	"note" text,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "render_approvals" ADD CONSTRAINT "render_approvals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_approvals" ADD CONSTRAINT "render_approvals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_approvals" ADD CONSTRAINT "render_approvals_render_id_renders_id_fk" FOREIGN KEY ("render_id") REFERENCES "public"."renders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "render_approvals_render_idx" ON "render_approvals" USING btree ("render_id","created_at");