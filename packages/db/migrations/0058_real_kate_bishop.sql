CREATE TABLE "project_sequences" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"frame_rate" jsonb NOT NULL,
	"start" jsonb NOT NULL,
	"duration" jsonb NOT NULL,
	"parent_sequence_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_clips" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"sequence_id" text NOT NULL,
	"track_id" text NOT NULL,
	"asset_version_id" text,
	"nested_sequence_id" text,
	"source_stream_id" text,
	"source_range" jsonb NOT NULL,
	"sequence_range" jsonb NOT NULL,
	"time_mapping" jsonb NOT NULL,
	"av_group_id" text,
	"parent_clip_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sequence_clips_source_xor_ck" CHECK (("sequence_clips"."asset_version_id" IS NULL) <> ("sequence_clips"."nested_sequence_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "sequence_tracks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"sequence_id" text NOT NULL,
	"kind" text NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_sequences" ADD CONSTRAINT "project_sequences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_sequences" ADD CONSTRAINT "project_sequences_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_clips" ADD CONSTRAINT "sequence_clips_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_clips" ADD CONSTRAINT "sequence_clips_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_clips" ADD CONSTRAINT "sequence_clips_sequence_id_project_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."project_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_clips" ADD CONSTRAINT "sequence_clips_track_id_sequence_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."sequence_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_clips" ADD CONSTRAINT "sequence_clips_asset_version_id_asset_versions_id_fk" FOREIGN KEY ("asset_version_id") REFERENCES "public"."asset_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_tracks" ADD CONSTRAINT "sequence_tracks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_tracks" ADD CONSTRAINT "sequence_tracks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_tracks" ADD CONSTRAINT "sequence_tracks_sequence_id_project_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."project_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_sequences_workspace_project_idx" ON "project_sequences" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE INDEX "project_sequences_parent_idx" ON "project_sequences" USING btree ("parent_sequence_id");--> statement-breakpoint
CREATE INDEX "sequence_clips_workspace_project_idx" ON "sequence_clips" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE INDEX "sequence_clips_sequence_track_idx" ON "sequence_clips" USING btree ("sequence_id","track_id");--> statement-breakpoint
CREATE INDEX "sequence_clips_asset_version_idx" ON "sequence_clips" USING btree ("asset_version_id");--> statement-breakpoint
CREATE INDEX "sequence_clips_nested_sequence_idx" ON "sequence_clips" USING btree ("nested_sequence_id");--> statement-breakpoint
CREATE INDEX "sequence_clips_av_group_idx" ON "sequence_clips" USING btree ("av_group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_tracks_sequence_position_uq" ON "sequence_tracks" USING btree ("sequence_id","position");--> statement-breakpoint
CREATE INDEX "sequence_tracks_workspace_project_idx" ON "sequence_tracks" USING btree ("workspace_id","project_id");