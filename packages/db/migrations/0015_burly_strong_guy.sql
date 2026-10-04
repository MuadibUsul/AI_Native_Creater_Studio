CREATE TABLE "budget_counters" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"period_key" text NOT NULL,
	"spent_credits" integer DEFAULT 0 NOT NULL,
	"reserved_credits" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"job_id" text NOT NULL,
	"reserved_credits" integer NOT NULL,
	"period_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settled_credits" integer,
	"status" text DEFAULT 'HELD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"release_reason" text
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"entry_type" text NOT NULL,
	"amount" integer NOT NULL,
	"reference_type" text NOT NULL,
	"reference_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_generations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"job_id" text,
	"provider_id" text NOT NULL,
	"model_id" text NOT NULL,
	"operation" text NOT NULL,
	"credential_mode" text NOT NULL,
	"input_hash" text NOT NULL,
	"status" text DEFAULT 'RECORDED' NOT NULL,
	"provider_job_id" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"estimated_cost" jsonb,
	"actual_cost" jsonb,
	"estimated_credits" integer,
	"actual_credits" integer,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_budgets" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"period" text DEFAULT 'MONTHLY' NOT NULL,
	"limit_credits" integer DEFAULT 0 NOT NULL,
	"per_job_max_credits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budget_counters" ADD CONSTRAINT "budget_counters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_generations" ADD CONSTRAINT "provider_generations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_budgets" ADD CONSTRAINT "workspace_budgets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_counters_workspace_period_uq" ON "budget_counters" USING btree ("workspace_id","period_key");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_holds_workspace_job_uq" ON "credit_holds" USING btree ("workspace_id","job_id");--> statement-breakpoint
CREATE INDEX "credit_holds_status_idx" ON "credit_holds" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "credit_ledger_workspace_created_idx" ON "credit_ledger" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_ledger_reference_idx" ON "credit_ledger" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_generations_key_uq" ON "provider_generations" USING btree ("workspace_id","job_id","attempt","provider_id","operation");--> statement-breakpoint
CREATE INDEX "provider_generations_workspace_created_idx" ON "provider_generations" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "provider_generations_provider_job_idx" ON "provider_generations" USING btree ("provider_id","provider_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_budgets_workspace_uq" ON "workspace_budgets" USING btree ("workspace_id");