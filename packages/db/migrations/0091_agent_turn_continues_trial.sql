-- V6-1c：在试改上继续微调。新一轮从会话里仍 OPEN 的试改（提案）出发，记录它延续的是哪个提案；
-- 收尾时新提案取代旧提案（旧提案 SUPERSEDED），没有新改动则沿用旧提案。
ALTER TABLE "agent_turns" ADD COLUMN "continues_proposal_id" text;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_continues_proposal_id_proposals_id_fk" FOREIGN KEY ("continues_proposal_id") REFERENCES "public"."proposals"("id") ON DELETE set null ON UPDATE no action;
