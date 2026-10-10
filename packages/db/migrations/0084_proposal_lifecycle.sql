ALTER TABLE "proposals" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "superseded_by_proposal_id" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE "proposal_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"proposal_id" text,
	"generation" integer NOT NULL,
	"current_generation" integer,
	"kind" text NOT NULL,
	"reference" text NOT NULL,
	"bound" boolean NOT NULL,
	"binding_reason" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proposal_artifacts" ADD CONSTRAINT "proposal_artifacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_artifacts" ADD CONSTRAINT "proposal_artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposal_artifacts_project_idx" ON "proposal_artifacts" USING btree ("workspace_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "proposal_artifacts_proposal_idx" ON "proposal_artifacts" USING btree ("proposal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "proposal_artifacts_reference_uq" ON "proposal_artifacts" USING btree ("workspace_id","project_id","kind","reference");
