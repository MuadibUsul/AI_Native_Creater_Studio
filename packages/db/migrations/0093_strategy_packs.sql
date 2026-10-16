-- V6 §6.6 策略剪辑（可选功能）：工作区自己的策略包（蒸馏 / 用户编辑）。内置预设在代码里，不入库。
-- 策略包是数据，不含执行逻辑；轮次记录选用时的旋钮取值。
CREATE TABLE "strategy_packs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"genre" text NOT NULL,
	"pack" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "strategy_packs_kind_ck" CHECK ("strategy_packs"."kind" in ('DISTILLED','USER')),
	CONSTRAINT "strategy_packs_version_ck" CHECK ("strategy_packs"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "strategy_packs" ADD CONSTRAINT "strategy_packs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_packs" ADD CONSTRAINT "strategy_packs_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "strategy_packs_workspace_idx" ON "strategy_packs" USING btree ("workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "agent_turns" ADD COLUMN "strategy_knobs" jsonb DEFAULT '{}'::jsonb NOT NULL;
