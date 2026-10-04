CREATE TABLE "provider_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"provider_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"encrypted_secret" jsonb,
	"masked_token" text NOT NULL,
	"key_version" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"last_tested_at" timestamp with time zone,
	"last_test_status" text,
	"last_test_mode" text
);
--> statement-breakpoint
CREATE TABLE "workspace_provider_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"selection_mode" text DEFAULT 'AUTOMATIC' NOT NULL,
	"connection_id" text,
	"scope_identity_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_provider_settings" ADD CONSTRAINT "workspace_provider_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_provider_settings" ADD CONSTRAINT "workspace_provider_settings_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_connections_workspace_idx" ON "provider_connections" USING btree ("workspace_id","provider_id");--> statement-breakpoint
CREATE INDEX "provider_connections_status_idx" ON "provider_connections" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_provider_settings_scope_kind_uq" ON "workspace_provider_settings" USING btree ("workspace_id","kind","scope_identity_id");