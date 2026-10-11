CREATE TABLE "project_op_log" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"position" integer NOT NULL,
	"revision" integer NOT NULL,
	"base_revision" integer NOT NULL,
	"source" text NOT NULL,
	"operations" jsonb NOT NULL,
	"changes" jsonb NOT NULL,
	"actor_type" text,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_op_log_source_ck" CHECK ("project_op_log"."source" in ('BASELINE','EDIT','COMPENSATION','DIRECT','MIGRATION')),
	CONSTRAINT "project_op_log_position_ck" CHECK ("project_op_log"."position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "reference_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"from_kind" text NOT NULL,
	"from_id" text NOT NULL,
	"to_kind" text NOT NULL,
	"to_id" text NOT NULL,
	"opened_position" integer NOT NULL,
	"closed_position" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_op_log" ADD CONSTRAINT "project_op_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_op_log" ADD CONSTRAINT "project_op_log_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_edges" ADD CONSTRAINT "reference_edges_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_edges" ADD CONSTRAINT "reference_edges_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_op_log_project_position_uq" ON "project_op_log" USING btree ("project_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "project_op_log_project_revision_uq" ON "project_op_log" USING btree ("project_id","revision") WHERE "project_op_log"."source" in ('EDIT','COMPENSATION','DIRECT');--> statement-breakpoint
CREATE INDEX "project_op_log_workspace_idx" ON "project_op_log" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reference_edges_open_uq" ON "reference_edges" USING btree ("project_id","from_kind","from_id","to_kind","to_id") WHERE "reference_edges"."closed_position" is null;--> statement-breakpoint
CREATE INDEX "reference_edges_target_idx" ON "reference_edges" USING btree ("workspace_id","to_kind","to_id");--> statement-breakpoint
CREATE INDEX "reference_edges_source_idx" ON "reference_edges" USING btree ("project_id","from_kind","from_id");--> statement-breakpoint
-- 回填：日志启用前已存在的片段 → 素材版本引用（opened_position = 0 表示早于日志）。
INSERT INTO "reference_edges" ("id", "workspace_id", "project_id", "from_kind", "from_id", "to_kind", "to_id", "opened_position")
SELECT 'ref_' || replace(gen_random_uuid()::text, '-', ''), "workspace_id", "project_id", 'CLIP', "id", 'ASSET_VERSION', "asset_version_id", 0
FROM "sequence_clips"
WHERE "asset_version_id" IS NOT NULL;
