CREATE TABLE "creator_learnings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"title" text NOT NULL,
	"explanation" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"recommendation" jsonb NOT NULL,
	"channel_mutation_applied" boolean DEFAULT false NOT NULL,
	"accepted_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"reverted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creator_learnings" ADD CONSTRAINT "creator_learnings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_learnings" ADD CONSTRAINT "creator_learnings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_learnings" ADD CONSTRAINT "creator_learnings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "creator_learnings_channel_idx" ON "creator_learnings" USING btree ("workspace_id","channel_id","created_at");--> statement-breakpoint
CREATE INDEX "creator_learnings_project_idx" ON "creator_learnings" USING btree ("project_id","created_at");