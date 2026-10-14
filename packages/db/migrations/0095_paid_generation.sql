-- V6-7 / V6-8 付费生成与身份档案（V6 §4.3、§7.3、§11）。
-- generation_requests：一份报价及其后续（确认 → 预算预留 → 生成一次 → 拉回 → 试改 → 结算/释放/待对账）。
-- identity_consent_records：形象/声音授权记录，只增不改（触发器拒绝改写与删除；只允许随身份档案级联清理、用户注销时置空操作人）。
-- identity_references：身份档案的参考照片与声音样本（每类一份当前参考）。
CREATE TABLE "generation_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"session_id" text,
	"quote_turn_id" text,
	"turn_id" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'QUOTED' NOT NULL,
	"request" jsonb NOT NULL,
	"summary" text NOT NULL,
	"provider_id" text NOT NULL,
	"provider_implementation" text NOT NULL,
	"model" text NOT NULL,
	"estimated_seconds" text NOT NULL,
	"estimate_min_micros" bigint NOT NULL,
	"estimate_max_micros" bigint NOT NULL,
	"reserve_credits" integer NOT NULL,
	"identity_snapshot" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_by" text,
	"accepted_at" timestamp with time zone,
	"workflow_run_id" text,
	"provider_called_at" timestamp with time zone,
	"provider_job_id" text,
	"charged_micros" bigint,
	"cost_source" text,
	"asset_id" text,
	"footage_id" text,
	"proposal_id" text,
	"outside_region_change" real,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "generation_requests_kind_ck" CHECK ("generation_requests"."kind" in ('AVATAR_CLIP','VIDEO_SHOT','VIDEO_REGION')),
	CONSTRAINT "generation_requests_status_ck" CHECK ("generation_requests"."status" in ('QUOTED','DECLINED','RUNNING','SUCCEEDED','FAILED','NEEDS_RECONCILIATION')),
	CONSTRAINT "generation_requests_impl_ck" CHECK ("generation_requests"."provider_implementation" in ('REAL','SCRIPTED')),
	CONSTRAINT "generation_requests_cost_source_ck" CHECK ("generation_requests"."cost_source" is null or "generation_requests"."cost_source" in ('PROVIDER','QUOTE_MAX')),
	CONSTRAINT "generation_requests_money_ck" CHECK ("generation_requests"."estimate_min_micros" >= 0 and "generation_requests"."estimate_max_micros" >= "generation_requests"."estimate_min_micros" and "generation_requests"."reserve_credits" >= 0 and ("generation_requests"."charged_micros" is null or "generation_requests"."charged_micros" >= 0))
);
--> statement-breakpoint
CREATE TABLE "identity_consent_records" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"creator_identity_id" text NOT NULL,
	"kind" text NOT NULL,
	"action" text NOT NULL,
	"subject" text,
	"statement_version" text NOT NULL,
	"locale" text,
	"statement_sha256" text,
	"reference_footage_id" text,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_consent_records_kind_ck" CHECK ("identity_consent_records"."kind" in ('LIKENESS','VOICE')),
	CONSTRAINT "identity_consent_records_action_ck" CHECK ("identity_consent_records"."action" in ('GRANT','REVOKE')),
	CONSTRAINT "identity_consent_records_grant_ck" CHECK ("identity_consent_records"."action" = 'REVOKE' or ("identity_consent_records"."subject" in ('SELF','AUTHORIZED_OTHER') and "identity_consent_records"."locale" in ('zh-CN','en') and "identity_consent_records"."statement_sha256" is not null))
);
--> statement-breakpoint
CREATE TABLE "identity_references" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"creator_identity_id" text NOT NULL,
	"kind" text NOT NULL,
	"asset_id" text NOT NULL,
	"footage_id" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replaced_at" timestamp with time zone,
	CONSTRAINT "identity_references_kind_ck" CHECK ("identity_references"."kind" in ('LIKENESS','VOICE'))
);
--> statement-breakpoint
ALTER TABLE "generation_requests" ADD CONSTRAINT "generation_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_requests" ADD CONSTRAINT "generation_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_requests" ADD CONSTRAINT "generation_requests_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_requests" ADD CONSTRAINT "generation_requests_quote_turn_id_agent_turns_id_fk" FOREIGN KEY ("quote_turn_id") REFERENCES "public"."agent_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_requests" ADD CONSTRAINT "generation_requests_turn_id_agent_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."agent_turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_requests" ADD CONSTRAINT "generation_requests_accepted_by_user_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_requests" ADD CONSTRAINT "generation_requests_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_requests" ADD CONSTRAINT "generation_requests_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_requests" ADD CONSTRAINT "generation_requests_footage_id_asset_versions_id_fk" FOREIGN KEY ("footage_id") REFERENCES "public"."asset_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_requests" ADD CONSTRAINT "generation_requests_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_consent_records" ADD CONSTRAINT "identity_consent_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_consent_records" ADD CONSTRAINT "identity_consent_records_creator_identity_id_creator_identities_id_fk" FOREIGN KEY ("creator_identity_id") REFERENCES "public"."creator_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_consent_records" ADD CONSTRAINT "identity_consent_records_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_references" ADD CONSTRAINT "identity_references_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_references" ADD CONSTRAINT "identity_references_creator_identity_id_creator_identities_id_fk" FOREIGN KEY ("creator_identity_id") REFERENCES "public"."creator_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_references" ADD CONSTRAINT "identity_references_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_references" ADD CONSTRAINT "identity_references_footage_id_asset_versions_id_fk" FOREIGN KEY ("footage_id") REFERENCES "public"."asset_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_references" ADD CONSTRAINT "identity_references_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generation_requests_project_idx" ON "generation_requests" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "generation_requests_status_idx" ON "generation_requests" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "identity_consent_records_identity_idx" ON "identity_consent_records" USING btree ("creator_identity_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "identity_references_identity_idx" ON "identity_references" USING btree ("creator_identity_id","kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_references_current_uq" ON "identity_references" USING btree ("creator_identity_id","kind") WHERE "identity_references"."replaced_at" is null;--> statement-breakpoint
CREATE FUNCTION "protect_identity_consent_record"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- 只允许随身份档案（或工作区）级联清理：父行已不存在
    IF EXISTS (SELECT 1 FROM "creator_identities" WHERE "id" = OLD."creator_identity_id") THEN
      RAISE EXCEPTION 'identity consent records are append-only';
    END IF;
    RETURN OLD;
  END IF;
  -- 只允许用户注销时把操作人置空（外键 ON DELETE SET NULL），其余字段不可改写
  IF NEW."actor_id" IS NULL AND (to_jsonb(NEW) - 'actor_id') = (to_jsonb(OLD) - 'actor_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'identity consent records are append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "identity_consent_records_append_only_trigger"
BEFORE UPDATE OR DELETE ON "identity_consent_records"
FOR EACH ROW EXECUTE FUNCTION "protect_identity_consent_record"();
--> statement-breakpoint
ALTER TABLE "agent_turns" DROP CONSTRAINT "agent_turns_purpose_ck";--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_purpose_ck" CHECK ("agent_turns"."purpose" in ('EDIT','DISCUSS_NOTE','APPLY_REVIEW','GENERATE'));
