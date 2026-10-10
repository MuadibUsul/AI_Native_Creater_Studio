CREATE TABLE "proposal_trials" (
	"dependency_key" text NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"proposal_id" text,
	"base_project_revision" integer NOT NULL,
	"operations_hash" text NOT NULL,
	"selection_fingerprint" text,
	"intent_revision_id" text,
	"asset_version_signature" text NOT NULL,
	"trial" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_trials_pkey" PRIMARY KEY("workspace_id","project_id","dependency_key")
);
--> statement-breakpoint
ALTER TABLE "proposal_trials" ADD CONSTRAINT "proposal_trials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_trials" ADD CONSTRAINT "proposal_trials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposal_trials_project_idx" ON "proposal_trials" USING btree ("workspace_id","project_id","updated_at");
