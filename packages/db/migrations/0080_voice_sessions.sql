CREATE TABLE "voice_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"actor_id" text,
	"selection_anchor_id" text,
	"status" text NOT NULL,
	"generation" integer NOT NULL,
	"clock_epoch" integer NOT NULL,
	"capabilities" jsonb NOT NULL,
	"transport" text NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"transcript_draft" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"utterances" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_event_seq" integer DEFAULT 0 NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voice_sessions_scope_idx" ON "voice_sessions" USING btree ("workspace_id","project_id","status");--> statement-breakpoint
CREATE INDEX "voice_sessions_actor_idx" ON "voice_sessions" USING btree ("actor_id","issued_at");