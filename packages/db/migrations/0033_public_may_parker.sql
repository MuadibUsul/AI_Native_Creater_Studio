CREATE TABLE "voice_clone_samples" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"creator_identity_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"asset_version_id" text NOT NULL,
	"byte_size" integer NOT NULL,
	"content_type" text NOT NULL,
	"quality" jsonb NOT NULL,
	"clone_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_clones" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"creator_identity_id" text NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"quality_verdict" text NOT NULL,
	"consent_id" text,
	"provider_voice_id" text,
	"provider_job_id" text,
	"retention_policy" text,
	"ownership_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure" jsonb,
	"submitted_at" timestamp with time zone,
	"trained_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"unlinked_at" timestamp with time zone,
	"provider_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_consents" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"creator_identity_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"statement_version" text NOT NULL,
	"statement_hash" text NOT NULL,
	"accepted_by_user_id" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "voice_clone_samples" ADD CONSTRAINT "voice_clone_samples_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_clone_samples" ADD CONSTRAINT "voice_clone_samples_creator_identity_id_creator_identities_id_fk" FOREIGN KEY ("creator_identity_id") REFERENCES "public"."creator_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_clones" ADD CONSTRAINT "voice_clones_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_clones" ADD CONSTRAINT "voice_clones_creator_identity_id_creator_identities_id_fk" FOREIGN KEY ("creator_identity_id") REFERENCES "public"."creator_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_consents" ADD CONSTRAINT "voice_consents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_consents" ADD CONSTRAINT "voice_consents_creator_identity_id_creator_identities_id_fk" FOREIGN KEY ("creator_identity_id") REFERENCES "public"."creator_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voice_clone_samples_identity_idx" ON "voice_clone_samples" USING btree ("creator_identity_id","created_at");--> statement-breakpoint
CREATE INDEX "voice_clone_samples_clone_idx" ON "voice_clone_samples" USING btree ("clone_id");--> statement-breakpoint
CREATE INDEX "voice_clones_identity_idx" ON "voice_clones" USING btree ("creator_identity_id","created_at");--> statement-breakpoint
CREATE INDEX "voice_clones_workspace_idx" ON "voice_clones" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_consents_identity_uq" ON "voice_consents" USING btree ("creator_identity_id");