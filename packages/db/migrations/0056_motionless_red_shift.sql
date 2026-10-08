CREATE TABLE "workspace_feature_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"feature_key" text NOT NULL,
	"requested_enabled" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_feature_preferences" ADD CONSTRAINT "workspace_feature_preferences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_feature_preferences" ADD CONSTRAINT "workspace_feature_preferences_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_feature_preferences" ADD CONSTRAINT "workspace_feature_preferences_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_feature_preferences_workspace_key_uq" ON "workspace_feature_preferences" USING btree ("workspace_id","feature_key");--> statement-breakpoint
CREATE INDEX "workspace_feature_preferences_workspace_idx" ON "workspace_feature_preferences" USING btree ("workspace_id");