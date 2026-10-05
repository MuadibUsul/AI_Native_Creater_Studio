CREATE TABLE "billing_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"type" text NOT NULL,
	"plan_key" text,
	"provider_subscription_ref" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_billing_states" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'NONE' NOT NULL,
	"plan_key" text,
	"provider_subscription_ref" text,
	"current_period_end" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_billing_states" ADD CONSTRAINT "workspace_billing_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_events_provider_event_uq" ON "billing_events" USING btree ("provider_event_id");--> statement-breakpoint
CREATE INDEX "billing_events_ws_idx" ON "billing_events" USING btree ("workspace_id","received_at");--> statement-breakpoint
CREATE INDEX "workspace_billing_states_state_idx" ON "workspace_billing_states" USING btree ("state");