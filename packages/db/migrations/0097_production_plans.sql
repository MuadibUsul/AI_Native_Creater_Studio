-- 裁决 0020 / AP-04：导演蓝图与场景契约（含 0.2 剪辑意图）。带版本的规划记录，不是第二套时间线真相：
-- 时间线仍只经操作日志与投影器改变；计划记录制定时的工程版本号，过期时如实标注。
CREATE TABLE "production_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"version" integer NOT NULL,
	"base_revision" integer NOT NULL,
	"turn_id" text,
	"blueprint" jsonb NOT NULL,
	"scenes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_plans_version_ck" CHECK ("production_plans"."version" > 0),
	CONSTRAINT "production_plans_base_revision_ck" CHECK ("production_plans"."base_revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "production_plans" ADD CONSTRAINT "production_plans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_plans" ADD CONSTRAINT "production_plans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_plans" ADD CONSTRAINT "production_plans_turn_id_agent_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."agent_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "production_plans_project_version_uq" ON "production_plans" USING btree ("project_id","version");--> statement-breakpoint
CREATE INDEX "production_plans_workspace_idx" ON "production_plans" USING btree ("workspace_id","created_at");
