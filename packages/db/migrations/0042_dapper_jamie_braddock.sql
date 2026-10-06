CREATE TABLE "publications" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"platform_id" text NOT NULL,
	"account_id" text NOT NULL,
	"project_version_id" text NOT NULL,
	"output_asset_id" text NOT NULL,
	"state" text DEFAULT 'QUEUED' NOT NULL,
	"remote_id" text,
	"remote_url" text,
	"published_at" timestamp with time zone,
	"title" text NOT NULL,
	"description" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scheduled_at" timestamp with time zone,
	"disclosure" text,
	"last_error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "publications_platform_account_version_output_uq" ON "publications" USING btree ("platform_id","account_id","project_version_id","output_asset_id");--> statement-breakpoint
CREATE INDEX "publications_project_idx" ON "publications" USING btree ("project_id","created_at");