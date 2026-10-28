-- AI 月度费用上限：按工作区 + 月份汇总 agent_turns.cost_micros（每次模型调用前都会查）。
CREATE INDEX IF NOT EXISTS "agent_turns_workspace_created_idx" ON "agent_turns" USING btree ("workspace_id","created_at");
