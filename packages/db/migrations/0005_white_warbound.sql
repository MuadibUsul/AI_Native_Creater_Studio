CREATE TABLE "edit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"scene_id" text,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"intent_text" text,
	"patch" jsonb NOT NULL,
	"base_revision" integer NOT NULL,
	"result_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "edit_events" ADD CONSTRAINT "edit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_events" ADD CONSTRAINT "edit_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edit_events_project_created_idx" ON "edit_events" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "edit_events_workspace_idx" ON "edit_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("published_at","created_at");