CREATE TABLE "project_composition_migrations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"completed_step" text DEFAULT 'NONE' NOT NULL,
	"authority_mode" text DEFAULT 'LEGACY' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"source_digest_sha256" text,
	"target_digest_sha256" text,
	"last_error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_version_composition_projections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"project_version_id" text NOT NULL,
	"source_snapshot_sha256" text NOT NULL,
	"projection_sha256" text NOT NULL,
	"projection" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_composition_migrations" ADD CONSTRAINT "project_composition_migrations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_composition_migrations" ADD CONSTRAINT "project_composition_migrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_version_composition_projections" ADD CONSTRAINT "project_version_composition_projections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_version_composition_projections" ADD CONSTRAINT "project_version_composition_projections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_version_composition_projections" ADD CONSTRAINT "project_version_composition_projections_project_version_id_project_versions_id_fk" FOREIGN KEY ("project_version_id") REFERENCES "public"."project_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_composition_migrations_project_uq" ON "project_composition_migrations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_composition_migrations_workspace_idx" ON "project_composition_migrations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "project_composition_migrations_status_idx" ON "project_composition_migrations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "project_version_composition_projections_version_uq" ON "project_version_composition_projections" USING btree ("project_version_id");--> statement-breakpoint
CREATE INDEX "project_version_composition_projections_scope_idx" ON "project_version_composition_projections" USING btree ("workspace_id","project_id");