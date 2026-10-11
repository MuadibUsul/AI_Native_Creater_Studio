CREATE TABLE "workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text,
	"type" text NOT NULL,
	"version" integer NOT NULL,
	"subject_ref" text NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"input" jsonb NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"current_step" text,
	"active_job_id" text,
	"idempotency_key" text,
	"error" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "workflow_runs_status_ck" CHECK ("workflow_runs"."status" in ('RUNNING','WAITING_HUMAN','SUCCEEDED','FAILED','CANCEL_REQUESTED','CANCELLED')),
	CONSTRAINT "workflow_runs_version_ck" CHECK ("workflow_runs"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "workflow_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"step_key" text NOT NULL,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"job_id" text,
	"result" jsonb,
	"error_class" text,
	"error" jsonb,
	"compensation_status" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "workflow_steps_status_ck" CHECK ("workflow_steps"."status" in ('RUNNING','SUCCEEDED','FAILED','WAITING_HUMAN')),
	CONSTRAINT "workflow_steps_error_class_ck" CHECK ("workflow_steps"."error_class" is null or "workflow_steps"."error_class" in ('RETRYABLE','NON_RETRYABLE','NEEDS_HUMAN','LEASE_LOST','CANCELLED')),
	CONSTRAINT "workflow_steps_compensation_ck" CHECK ("workflow_steps"."compensation_status" is null or "workflow_steps"."compensation_status" in ('COMPENSATED','COMPENSATION_FAILED')),
	CONSTRAINT "workflow_steps_attempt_ck" CHECK ("workflow_steps"."attempt" >= 1)
);
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_idempotency_uq" ON "workflow_runs" USING btree ("workspace_id","type","idempotency_key") WHERE "workflow_runs"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "workflow_runs_workspace_status_idx" ON "workflow_runs" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "workflow_runs_project_idx" ON "workflow_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_steps_attempt_uq" ON "workflow_steps" USING btree ("run_id","step_key","attempt");--> statement-breakpoint
CREATE INDEX "workflow_steps_run_idx" ON "workflow_steps" USING btree ("run_id","started_at");
