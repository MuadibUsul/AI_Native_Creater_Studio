CREATE TABLE "finance_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"visualization_type" text NOT NULL,
	"title" text NOT NULL,
	"data_source_snapshot" jsonb NOT NULL,
	"template_snapshot" jsonb NOT NULL,
	"data" jsonb NOT NULL,
	"relations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_data_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"source_url" text,
	"license" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"visualization_type" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finance_artifacts" ADD CONSTRAINT "finance_artifacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_data_sources" ADD CONSTRAINT "finance_data_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_templates" ADD CONSTRAINT "finance_templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_artifacts_workspace_idx" ON "finance_artifacts" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "finance_data_sources_workspace_idx" ON "finance_data_sources" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_templates_key_version_uq" ON "finance_templates" USING btree ("workspace_id","key","version");--> statement-breakpoint
CREATE INDEX "finance_templates_workspace_idx" ON "finance_templates" USING btree ("workspace_id","created_at");