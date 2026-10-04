CREATE TABLE "content_blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"position" integer NOT NULL,
	"block_type" text NOT NULL,
	"level" integer,
	"text" text,
	"items" jsonb,
	"table" jsonb,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text,
	"title" text NOT NULL,
	"language" text NOT NULL,
	"author" text,
	"source_url" text,
	"published_at" text,
	"normalization" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schema_version" text DEFAULT '0.1' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"publisher" text NOT NULL,
	"author" text,
	"published_at" text,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_hash" text NOT NULL,
	"excerpt" text NOT NULL,
	"snapshot_kind" text DEFAULT 'live_fetch' NOT NULL,
	"snapshot_asset_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_blocks" ADD CONSTRAINT "content_blocks_document_id_content_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."content_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_blocks" ADD CONSTRAINT "content_blocks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_documents" ADD CONSTRAINT "content_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_documents" ADD CONSTRAINT "content_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_sources" ADD CONSTRAINT "project_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_sources" ADD CONSTRAINT "project_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_blocks_document_position_uq" ON "content_blocks" USING btree ("document_id","position");--> statement-breakpoint
CREATE INDEX "content_blocks_document_idx" ON "content_blocks" USING btree ("document_id","position");--> statement-breakpoint
CREATE INDEX "content_blocks_workspace_idx" ON "content_blocks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "content_documents_project_idx" ON "content_documents" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "content_documents_workspace_idx" ON "content_documents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "project_sources_project_idx" ON "project_sources" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "project_sources_workspace_idx" ON "project_sources" USING btree ("workspace_id");