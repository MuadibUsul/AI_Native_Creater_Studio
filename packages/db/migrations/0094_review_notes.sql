-- V6-4 批注式审片：一轮审片绑定所看的工程版本；批注 = 定位（时间范围 + 可选片段/框选）+ 一句话 + 确定的方案。
-- 讨论与执行都是普通的 AI 轮次（agent_turns.purpose）；轮次状态由执行轮与提案派生，不另存。
CREATE TABLE "review_rounds" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"sequence_id" text NOT NULL,
	"base_revision" integer NOT NULL,
	"apply_turn_id" text,
	"applied_note_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_rounds_base_revision_ck" CHECK ("review_rounds"."base_revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "review_rounds" ADD CONSTRAINT "review_rounds_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_rounds" ADD CONSTRAINT "review_rounds_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_rounds" ADD CONSTRAINT "review_rounds_sequence_id_project_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."project_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_rounds" ADD CONSTRAINT "review_rounds_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_rounds_project_idx" ON "review_rounds" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE TABLE "review_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"round_id" text NOT NULL,
	"pointer" jsonb NOT NULL,
	"region" jsonb,
	"text" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"plan" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_notes_status_ck" CHECK ("review_notes"."status" in ('OPEN','AGREED','DISMISSED'))
);
--> statement-breakpoint
ALTER TABLE "review_notes" ADD CONSTRAINT "review_notes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_notes" ADD CONSTRAINT "review_notes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_notes" ADD CONSTRAINT "review_notes_round_id_review_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."review_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_notes" ADD CONSTRAINT "review_notes_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_notes_round_idx" ON "review_notes" USING btree ("round_id","created_at");--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "purpose" text DEFAULT 'EDIT' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "review_note_id" text;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "review_round_id" text;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_purpose_ck" CHECK ("agent_turns"."purpose" in ('EDIT','DISCUSS_NOTE','APPLY_REVIEW'));--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_review_note_id_review_notes_id_fk" FOREIGN KEY ("review_note_id") REFERENCES "public"."review_notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_review_round_id_review_rounds_id_fk" FOREIGN KEY ("review_round_id") REFERENCES "public"."review_rounds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_turns_review_note_idx" ON "agent_turns" USING btree ("review_note_id","created_at");
