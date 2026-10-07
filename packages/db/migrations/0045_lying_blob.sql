CREATE TABLE "cms_ingestions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"project_id" text NOT NULL,
	"document_id" text NOT NULL,
	"status" text DEFAULT 'INGESTED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cms_ingestions" ADD CONSTRAINT "cms_ingestions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_ingestions" ADD CONSTRAINT "cms_ingestions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cms_ingestions" ADD CONSTRAINT "cms_ingestions_document_id_content_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."content_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cms_ingestions_event_uq" ON "cms_ingestions" USING btree ("workspace_id","source","external_id","content_hash");--> statement-breakpoint
CREATE INDEX "cms_ingestions_lookup_idx" ON "cms_ingestions" USING btree ("workspace_id","source","external_id");