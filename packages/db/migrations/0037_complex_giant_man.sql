CREATE TABLE "derivation_lineage" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"pack_id" text NOT NULL,
	"pack_version" text NOT NULL,
	"channel_key" text,
	"status" text DEFAULT 'PLAN' NOT NULL,
	"core_inputs_digest" text,
	"inputs_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "derivation_lineage" ADD CONSTRAINT "derivation_lineage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derivation_lineage" ADD CONSTRAINT "derivation_lineage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "derivation_lineage_project_idx" ON "derivation_lineage" USING btree ("project_id","created_at");