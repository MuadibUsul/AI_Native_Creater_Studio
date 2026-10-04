CREATE TABLE "provider_result_states" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"job_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"provider_job_id" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"collect_attempts" integer DEFAULT 0 NOT NULL,
	"last_error" jsonb,
	"bytes_collected" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"collected_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"status" text DEFAULT 'VERIFIED' NOT NULL,
	"payload_hash" text NOT NULL,
	"job_id" text,
	"attempt" integer,
	"note" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "provider_result_states" ADD CONSTRAINT "provider_result_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_result_states_workspace_job_uq" ON "provider_result_states" USING btree ("workspace_id","job_id");--> statement-breakpoint
CREATE INDEX "provider_result_states_status_expiry_idx" ON "provider_result_states" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_uq" ON "webhook_events" USING btree ("provider_id","provider_event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_received_idx" ON "webhook_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "webhook_events_job_idx" ON "webhook_events" USING btree ("job_id");