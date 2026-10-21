-- 裁决 0020 / AP-05：自主制作运行。同一工程同一时刻只有一个进行中的运行；运行记下开始时签署的授权版本与总预算。
-- 自主制作的那一轮对话用新的轮次用途 AUTONOMOUS（由自主制作工作流发起与推进）。
CREATE TABLE "autonomous_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"session_id" text,
	"turn_id" text,
	"workflow_run_id" text,
	"status" text DEFAULT 'WAITING_FOR_FOOTAGE' NOT NULL,
	"goal" text NOT NULL,
	"target_duration_seconds" integer,
	"strategy_pack_id" text,
	"strategy_knobs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approval" text NOT NULL,
	"policy_version" integer NOT NULL,
	"budget_micros" bigint NOT NULL,
	"model_cap_micros" bigint,
	"locale" text DEFAULT 'zh-CN' NOT NULL,
	"proposal_id" text,
	"adopted_revision" integer,
	"report" jsonb,
	"error" jsonb,
	"idempotency_key" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "autonomous_runs_status_ck" CHECK ("autonomous_runs"."status" in ('WAITING_FOR_FOOTAGE','DIRECTING','CHECKING','DELIVERED','NEEDS_REVIEW','FAILED','CANCELLED')),
	CONSTRAINT "autonomous_runs_approval_ck" CHECK ("autonomous_runs"."approval" in ('ASK_EACH','AUTO_SAFE','FULL')),
	CONSTRAINT "autonomous_runs_budget_ck" CHECK ("autonomous_runs"."budget_micros" >= 0)
);
--> statement-breakpoint
ALTER TABLE "autonomous_runs" ADD CONSTRAINT "autonomous_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomous_runs" ADD CONSTRAINT "autonomous_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomous_runs" ADD CONSTRAINT "autonomous_runs_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomous_runs" ADD CONSTRAINT "autonomous_runs_turn_id_agent_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."agent_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomous_runs" ADD CONSTRAINT "autonomous_runs_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "autonomous_runs_project_idx" ON "autonomous_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "autonomous_runs_active_uq" ON "autonomous_runs" USING btree ("project_id") WHERE "autonomous_runs"."status" in ('WAITING_FOR_FOOTAGE','DIRECTING','CHECKING');--> statement-breakpoint
CREATE UNIQUE INDEX "autonomous_runs_idempotency_uq" ON "autonomous_runs" USING btree ("project_id","idempotency_key") WHERE "autonomous_runs"."idempotency_key" is not null;--> statement-breakpoint
ALTER TABLE "agent_turns" DROP CONSTRAINT "agent_turns_purpose_ck";--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_purpose_ck" CHECK ("agent_turns"."purpose" in ('EDIT','DISCUSS_NOTE','APPLY_REVIEW','GENERATE','AUTONOMOUS'));
