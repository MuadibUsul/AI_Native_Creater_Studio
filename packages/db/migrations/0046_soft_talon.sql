CREATE TABLE "cms_writeback_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"target_id" text NOT NULL,
	"ingestion_id" text NOT NULL,
	"project_id" text NOT NULL,
	"render_id" text NOT NULL,
	"job_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"job_attempt" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"request_url" text NOT NULL,
	"request_payload" jsonb NOT NULL,
	"request_body_sha256" text NOT NULL,
	"signature_key_version" text,
	"response_status" integer,
	"response_headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_body_preview" text,
	"response_truncated" boolean DEFAULT false NOT NULL,
	"error_reason" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cms_writeback_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"callback_url" text NOT NULL,
	"encrypted_signing_secret" jsonb NOT NULL,
	"masked_secret" text NOT NULL,
	"key_version" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "cms_writeback_attempts" ADD CONSTRAINT "cms_writeback_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_writeback_attempts" ADD CONSTRAINT "cms_writeback_attempts_target_id_cms_writeback_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."cms_writeback_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_writeback_attempts" ADD CONSTRAINT "cms_writeback_attempts_ingestion_id_cms_ingestions_id_fk" FOREIGN KEY ("ingestion_id") REFERENCES "public"."cms_ingestions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_writeback_attempts" ADD CONSTRAINT "cms_writeback_attempts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_writeback_attempts" ADD CONSTRAINT "cms_writeback_attempts_render_id_renders_id_fk" FOREIGN KEY ("render_id") REFERENCES "public"."renders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_writeback_attempts" ADD CONSTRAINT "cms_writeback_attempts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_writeback_targets" ADD CONSTRAINT "cms_writeback_targets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_writeback_targets" ADD CONSTRAINT "cms_writeback_targets_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cms_writeback_attempts_delivery_attempt_uq" ON "cms_writeback_attempts" USING btree ("delivery_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "cms_writeback_attempts_job_attempt_uq" ON "cms_writeback_attempts" USING btree ("job_id","job_attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "cms_writeback_attempts_first_delivery_uq" ON "cms_writeback_attempts" USING btree ("target_id","render_id") WHERE "cms_writeback_attempts"."attempt_number" = 1;--> statement-breakpoint
CREATE INDEX "cms_writeback_attempts_workspace_idx" ON "cms_writeback_attempts" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "cms_writeback_attempts_render_idx" ON "cms_writeback_attempts" USING btree ("render_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "cms_writeback_targets_workspace_uq" ON "cms_writeback_targets" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "cms_writeback_targets_status_idx" ON "cms_writeback_targets" USING btree ("workspace_id","status");