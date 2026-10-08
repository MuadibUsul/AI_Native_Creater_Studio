CREATE TABLE "project_object_locks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"object_kind" text NOT NULL,
	"object_id" text NOT NULL,
	"dimensions" jsonb NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_object_locks_kind_ck" CHECK ("project_object_locks"."object_kind" in ('PROJECT','SCENE','SEQUENCE','TRACK','CLIP','VISUAL_OBJECT','CAPTION','AUDIO_REGION')),
	CONSTRAINT "project_object_locks_dimensions_ck" CHECK (jsonb_typeof("project_object_locks"."dimensions") = 'array' and jsonb_array_length("project_object_locks"."dimensions") > 0 and "project_object_locks"."dimensions" <@ '["CONTENT","POSITION","DURATION","ASSET","STYLE","TRACK"]'::jsonb)
);
--> statement-breakpoint
ALTER TABLE "project_object_locks" ADD CONSTRAINT "project_object_locks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_object_locks" ADD CONSTRAINT "project_object_locks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_object_locks_object_uq" ON "project_object_locks" USING btree ("project_id","object_kind","object_id");--> statement-breakpoint
CREATE INDEX "project_object_locks_scope_idx" ON "project_object_locks" USING btree ("workspace_id","project_id");