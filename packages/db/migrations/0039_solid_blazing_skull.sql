CREATE TABLE "pack_artifact_validations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"ok" boolean NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"validated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pack_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"pack_id" text NOT NULL,
	"pack_version" text NOT NULL,
	"lineage_id" text NOT NULL,
	"payload_kind" text NOT NULL,
	"title" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pack_artifact_validations" ADD CONSTRAINT "pack_artifact_validations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_artifact_validations" ADD CONSTRAINT "pack_artifact_validations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_artifact_validations" ADD CONSTRAINT "pack_artifact_validations_artifact_id_pack_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."pack_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_artifacts" ADD CONSTRAINT "pack_artifacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_artifacts" ADD CONSTRAINT "pack_artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pack_artifact_validations_artifact_idx" ON "pack_artifact_validations" USING btree ("artifact_id","validated_at");--> statement-breakpoint
CREATE INDEX "pack_artifacts_project_idx" ON "pack_artifacts" USING btree ("project_id","created_at");