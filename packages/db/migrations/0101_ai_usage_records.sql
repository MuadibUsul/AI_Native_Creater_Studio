-- 工作区 AI 月度上限：不属于导演轮次的模型用量（当前为上传后的画面理解），每次分析尝试一行，只追加。
CREATE TABLE "ai_usage_records" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject_ref" text NOT NULL,
	"model" text,
	"calls" integer NOT NULL,
	"cost_micros" bigint NOT NULL,
	"unpriced_calls" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_records_kind_ck" CHECK ("ai_usage_records"."kind" in ('FOOTAGE_DESCRIPTION')),
	CONSTRAINT "ai_usage_records_amounts_ck" CHECK ("ai_usage_records"."calls" >= 0 and "ai_usage_records"."cost_micros" >= 0 and "ai_usage_records"."unpriced_calls" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ai_usage_records" ADD CONSTRAINT "ai_usage_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "ai_usage_records_workspace_created_idx" ON "ai_usage_records" USING btree ("workspace_id","created_at");
