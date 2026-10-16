CREATE TABLE "agent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"sequence_id" text NOT NULL,
	"locale" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_sessions_locale_ck" CHECK ("agent_sessions"."locale" in ('zh-CN','en'))
);
--> statement-breakpoint
CREATE TABLE "agent_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"workflow_run_id" text,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"message" text NOT NULL,
	"pointer" jsonb NOT NULL,
	"strategy_pack_id" text,
	"base_revision" integer NOT NULL,
	"draft_operations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reply" text,
	"proposal_id" text,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"usage" jsonb NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"unpriced_calls" integer DEFAULT 0 NOT NULL,
	"error" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "agent_turns_status_ck" CHECK ("agent_turns"."status" in ('RUNNING','COMPLETED','FAILED','CANCELLED')),
	CONSTRAINT "agent_turns_cost_ck" CHECK ("agent_turns"."cost_micros" >= 0 and "agent_turns"."unpriced_calls" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_turn_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"turn_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"content" jsonb NOT NULL,
	"model" text,
	"usage" jsonb,
	"cost_micros" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_turn_messages_role_ck" CHECK ("agent_turn_messages"."role" in ('user','assistant')),
	CONSTRAINT "agent_turn_messages_seq_ck" CHECK ("agent_turn_messages"."seq" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_sequence_id_project_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."project_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turn_messages" ADD CONSTRAINT "agent_turn_messages_turn_id_agent_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."agent_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turn_messages" ADD CONSTRAINT "agent_turn_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_sessions_project_idx" ON "agent_sessions" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_turns_one_running_uq" ON "agent_turns" USING btree ("session_id") WHERE "agent_turns"."status" = 'RUNNING';--> statement-breakpoint
CREATE INDEX "agent_turns_session_idx" ON "agent_turns" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_turn_messages_seq_uq" ON "agent_turn_messages" USING btree ("turn_id","seq");
