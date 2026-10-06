CREATE TABLE "pack_enablements" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"pack_id" text NOT NULL,
	"version" text NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pack_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"pack_id" text NOT NULL,
	"version" text NOT NULL,
	"name" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output_formats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"official" text DEFAULT 'true' NOT NULL,
	"status" text DEFAULT 'INSTALLED' NOT NULL,
	"manifest" jsonb NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_pack_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"pack_id" text NOT NULL,
	"version" text NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pack_enablements" ADD CONSTRAINT "pack_enablements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_pack_bindings" ADD CONSTRAINT "project_pack_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_pack_bindings" ADD CONSTRAINT "project_pack_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pack_enablements_workspace_pack_uq" ON "pack_enablements" USING btree ("workspace_id","pack_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pack_installations_pack_version_uq" ON "pack_installations" USING btree ("pack_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "project_pack_bindings_project_pack_uq" ON "project_pack_bindings" USING btree ("project_id","pack_id");