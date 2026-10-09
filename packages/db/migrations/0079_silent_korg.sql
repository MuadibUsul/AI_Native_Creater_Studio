CREATE TABLE "selection_anchors" (
	"id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"sequence_id" text NOT NULL,
	"revision" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"created_by" text,
	"anchor" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "selection_anchors_pkey" PRIMARY KEY("workspace_id","project_id","id","revision")
);
--> statement-breakpoint
ALTER TABLE "selection_anchors" ADD CONSTRAINT "selection_anchors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection_anchors" ADD CONSTRAINT "selection_anchors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection_anchors" ADD CONSTRAINT "selection_anchors_sequence_id_project_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."project_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "selection_anchors_project_idx" ON "selection_anchors" USING btree ("workspace_id","project_id","created_at");