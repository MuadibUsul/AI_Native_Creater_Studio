CREATE TABLE "content_cores" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"core" jsonb NOT NULL,
	"consistency" jsonb NOT NULL,
	"migrated_claim_count" integer NOT NULL,
	"migrated_source_count" integer NOT NULL,
	"migrated_document_count" integer NOT NULL,
	"migrated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_cores" ADD CONSTRAINT "content_cores_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_cores" ADD CONSTRAINT "content_cores_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_cores_project_uq" ON "content_cores" USING btree ("project_id");