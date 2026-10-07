CREATE TABLE "analytics_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"publication_id" text NOT NULL,
	"platform_id" text NOT NULL,
	"remote_id" text NOT NULL,
	"sampling" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_performance" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"publication_id" text NOT NULL,
	"project_version_id" text NOT NULL,
	"platform_id" text NOT NULL,
	"remote_id" text NOT NULL,
	"sampling" jsonb NOT NULL,
	"metrics" jsonb NOT NULL,
	"raw_event_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_performance" ADD CONSTRAINT "video_performance_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_performance" ADD CONSTRAINT "video_performance_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_performance" ADD CONSTRAINT "video_performance_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_performance" ADD CONSTRAINT "video_performance_project_version_id_project_versions_id_fk" FOREIGN KEY ("project_version_id") REFERENCES "public"."project_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_performance" ADD CONSTRAINT "video_performance_raw_event_id_analytics_events_id_fk" FOREIGN KEY ("raw_event_id") REFERENCES "public"."analytics_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_events_publication_payload_uq" ON "analytics_events" USING btree ("publication_id","payload_hash");--> statement-breakpoint
CREATE INDEX "analytics_events_workspace_idx" ON "analytics_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "video_performance_raw_event_uq" ON "video_performance" USING btree ("raw_event_id");--> statement-breakpoint
CREATE INDEX "video_performance_publication_idx" ON "video_performance" USING btree ("publication_id","created_at");--> statement-breakpoint
CREATE INDEX "video_performance_workspace_idx" ON "video_performance" USING btree ("workspace_id","created_at");