CREATE TABLE "sequence_previews" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"sequence_id" text NOT NULL,
	"source" text NOT NULL,
	"project_revision" integer NOT NULL,
	"proposal_id" text,
	"plan_hash" text NOT NULL,
	"plan" jsonb NOT NULL,
	"profile" jsonb NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"storage_key" text,
	"segments_total" integer DEFAULT 0 NOT NULL,
	"segments_reused" integer DEFAULT 0 NOT NULL,
	"segments_rendered" integer DEFAULT 0 NOT NULL,
	"render_ms" integer,
	"error" jsonb,
	"job_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "sequence_previews_source_ck" CHECK ("sequence_previews"."source" in ('REVISION','PROPOSAL')),
	CONSTRAINT "sequence_previews_status_ck" CHECK ("sequence_previews"."status" in ('QUEUED','RENDERING','READY','FAILED')),
	CONSTRAINT "sequence_previews_plan_hash_ck" CHECK ("sequence_previews"."plan_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "preview_segments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"cache_key" text NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preview_segments_kind_ck" CHECK ("preview_segments"."kind" in ('VIDEO','AUDIO')),
	CONSTRAINT "preview_segments_cache_key_ck" CHECK ("preview_segments"."cache_key" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "sequence_previews" ADD CONSTRAINT "sequence_previews_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_previews" ADD CONSTRAINT "sequence_previews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_previews" ADD CONSTRAINT "sequence_previews_sequence_id_project_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."project_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_previews" ADD CONSTRAINT "sequence_previews_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_previews" ADD CONSTRAINT "sequence_previews_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_previews" ADD CONSTRAINT "sequence_previews_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_segments" ADD CONSTRAINT "preview_segments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_previews_plan_uq" ON "sequence_previews" USING btree ("workspace_id","sequence_id","plan_hash") WHERE "sequence_previews"."status" in ('QUEUED','RENDERING','READY');--> statement-breakpoint
CREATE INDEX "sequence_previews_sequence_idx" ON "sequence_previews" USING btree ("sequence_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "preview_segments_key_uq" ON "preview_segments" USING btree ("workspace_id","kind","cache_key");--> statement-breakpoint
CREATE INDEX "preview_segments_last_used_idx" ON "preview_segments" USING btree ("workspace_id","last_used_at");
