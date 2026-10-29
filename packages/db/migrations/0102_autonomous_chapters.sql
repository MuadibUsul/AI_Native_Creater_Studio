-- V6-10 分章（docs/V06/milestones/V6-10.md）：素材够长时，自主制作先定计划，再分章在各自的子序列上剪，最后拼进主序列。
-- 运行多了模式（SINGLE / CHAPTERS）与两个进行中的状态（定计划、分章在剪）；每章一行；轮次多了两种用途（规划、一章）。
ALTER TABLE "autonomous_runs" ADD COLUMN "mode" text DEFAULT 'SINGLE' NOT NULL;--> statement-breakpoint
ALTER TABLE "autonomous_runs" ADD CONSTRAINT "autonomous_runs_mode_ck" CHECK ("autonomous_runs"."mode" in ('SINGLE','CHAPTERS'));--> statement-breakpoint
ALTER TABLE "autonomous_runs" DROP CONSTRAINT "autonomous_runs_status_ck";--> statement-breakpoint
ALTER TABLE "autonomous_runs" ADD CONSTRAINT "autonomous_runs_status_ck" CHECK ("autonomous_runs"."status" in ('WAITING_FOR_FOOTAGE','PLANNING','CUTTING_CHAPTERS','DIRECTING','CHECKING','DELIVERED','NEEDS_REVIEW','FAILED','CANCELLED'));--> statement-breakpoint
DROP INDEX "autonomous_runs_active_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "autonomous_runs_active_uq" ON "autonomous_runs" USING btree ("project_id") WHERE "autonomous_runs"."status" in ('WAITING_FOR_FOOTAGE','PLANNING','CUTTING_CHAPTERS','DIRECTING','CHECKING');--> statement-breakpoint
ALTER TABLE "agent_turns" DROP CONSTRAINT "agent_turns_purpose_ck";--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_purpose_ck" CHECK ("agent_turns"."purpose" in ('EDIT','DISCUSS_NOTE','APPLY_REVIEW','GENERATE','AUTONOMOUS','AUTONOMOUS_PLAN','AUTONOMOUS_CHAPTER'));--> statement-breakpoint
CREATE TABLE "autonomous_chapters" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"index" integer NOT NULL,
	"scene_id" text NOT NULL,
	"title" text NOT NULL,
	"sequence_id" text,
	"session_id" text,
	"turn_id" text,
	"workflow_run_id" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"budget_micros" bigint NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "autonomous_chapters_status_ck" CHECK ("autonomous_chapters"."status" in ('PENDING','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
	CONSTRAINT "autonomous_chapters_amounts_ck" CHECK ("autonomous_chapters"."attempts" >= 0 and "autonomous_chapters"."budget_micros" >= 0 and "autonomous_chapters"."cost_micros" >= 0)
);
--> statement-breakpoint
ALTER TABLE "autonomous_chapters" ADD CONSTRAINT "autonomous_chapters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomous_chapters" ADD CONSTRAINT "autonomous_chapters_run_id_autonomous_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."autonomous_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomous_chapters" ADD CONSTRAINT "autonomous_chapters_sequence_id_project_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."project_sequences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomous_chapters" ADD CONSTRAINT "autonomous_chapters_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomous_chapters" ADD CONSTRAINT "autonomous_chapters_turn_id_agent_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."agent_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "autonomous_chapters_run_index_uq" ON "autonomous_chapters" USING btree ("run_id","index");
