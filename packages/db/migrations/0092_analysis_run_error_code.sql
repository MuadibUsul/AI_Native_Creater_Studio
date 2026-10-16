-- V6-1：分析运行的机器可读错误码。CAPABILITY_NOT_CONFIGURED = 对应能力的驱动未配置（不是分析本身失败），
-- 界面据此显示"未配置"而不是"失败"；其余失败保持 NULL，以 error_summary 说明原因。
ALTER TABLE "media_index_runs" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "media_transcript_runs" ADD COLUMN "error_code" text;
