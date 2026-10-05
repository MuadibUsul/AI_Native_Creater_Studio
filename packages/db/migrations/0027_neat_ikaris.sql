CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_key" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"entitlements" jsonb NOT NULL,
	"price" jsonb,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"plan_key" text NOT NULL,
	"plan_version" integer NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"assigned_by" text
);
--> statement-breakpoint
ALTER TABLE "workspace_subscriptions" ADD CONSTRAINT "workspace_subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plans_key_version_uq" ON "plans" USING btree ("plan_key","version");--> statement-breakpoint
CREATE INDEX "plans_key_idx" ON "plans" USING btree ("plan_key","version");--> statement-breakpoint
CREATE INDEX "workspace_subscriptions_ws_idx" ON "workspace_subscriptions" USING btree ("workspace_id","started_at");