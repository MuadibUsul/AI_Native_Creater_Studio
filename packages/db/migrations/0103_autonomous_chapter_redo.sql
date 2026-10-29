-- V6-10 S5（docs/V06/milestones/V6-10.md）：只重做没剪成的那一章。
-- 重做是新的一次运行，记下它重做的是哪次运行的哪一章；每章记下拼进主序列时的位置与片段 id，
-- 重做时按前后章的片段找回这一章在成片里的位置。
ALTER TABLE "autonomous_runs" ADD COLUMN "redo_of" jsonb;--> statement-breakpoint
ALTER TABLE "autonomous_chapters" ADD COLUMN "placement" jsonb;--> statement-breakpoint
CREATE INDEX "autonomous_runs_redo_of_idx" ON "autonomous_runs" USING btree (("redo_of" ->> 'runId')) WHERE "autonomous_runs"."redo_of" is not null;
