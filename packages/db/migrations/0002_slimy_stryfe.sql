CREATE TABLE "avatar_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"creator_identity_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"provider" text,
	"provider_avatar_id" text,
	"provider_account_scope" text,
	"display_name" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"consent_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_look" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "brand_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"creator_identity_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"theme_tokens" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_style_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"version" integer NOT NULL,
	"defaults" jsonb NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"current_style_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "speech_profile_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"speech_profile_id" text NOT NULL,
	"version" integer NOT NULL,
	"fields" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "speech_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"creator_identity_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"provider" text,
	"provider_voice_id" text,
	"clone_type" text,
	"ownership_type" text,
	"verification_status" text,
	"managed_mode" text,
	"language_profile" text,
	"default_speech_profile_id" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "avatar_identities" ADD CONSTRAINT "avatar_identities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "avatar_identities" ADD CONSTRAINT "avatar_identities_creator_identity_id_creator_identities_id_fk" FOREIGN KEY ("creator_identity_id") REFERENCES "public"."creator_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_identities" ADD CONSTRAINT "brand_identities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_identities" ADD CONSTRAINT "brand_identities_creator_identity_id_creator_identities_id_fk" FOREIGN KEY ("creator_identity_id") REFERENCES "public"."creator_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_style_versions" ADD CONSTRAINT "channel_style_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_style_versions" ADD CONSTRAINT "channel_style_versions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_identities" ADD CONSTRAINT "creator_identities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speech_profile_versions" ADD CONSTRAINT "speech_profile_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speech_profile_versions" ADD CONSTRAINT "speech_profile_versions_speech_profile_id_speech_profiles_id_fk" FOREIGN KEY ("speech_profile_id") REFERENCES "public"."speech_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speech_profiles" ADD CONSTRAINT "speech_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_identities" ADD CONSTRAINT "voice_identities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_identities" ADD CONSTRAINT "voice_identities_creator_identity_id_creator_identities_id_fk" FOREIGN KEY ("creator_identity_id") REFERENCES "public"."creator_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "avatar_identities_creator_uq" ON "avatar_identities" USING btree ("creator_identity_id");--> statement-breakpoint
CREATE INDEX "avatar_identities_workspace_idx" ON "avatar_identities" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "brand_identities_creator_uq" ON "brand_identities" USING btree ("creator_identity_id");--> statement-breakpoint
CREATE INDEX "brand_identities_workspace_idx" ON "brand_identities" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_style_versions_channel_version_uq" ON "channel_style_versions" USING btree ("channel_id","version");--> statement-breakpoint
CREATE INDEX "channel_style_versions_workspace_idx" ON "channel_style_versions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "channels_workspace_idx" ON "channels" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "creator_identities_workspace_idx" ON "creator_identities" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "speech_profile_versions_profile_version_uq" ON "speech_profile_versions" USING btree ("speech_profile_id","version");--> statement-breakpoint
CREATE INDEX "speech_profile_versions_workspace_idx" ON "speech_profile_versions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "speech_profiles_workspace_idx" ON "speech_profiles" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_identities_creator_uq" ON "voice_identities" USING btree ("creator_identity_id");--> statement-breakpoint
CREATE INDEX "voice_identities_workspace_idx" ON "voice_identities" USING btree ("workspace_id");