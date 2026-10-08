CREATE TABLE "composition_animation_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"sequence_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"property_path" text NOT NULL,
	"parameter_schema_version" text NOT NULL,
	"time_binding" jsonb NOT NULL,
	"keyframes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "composition_audio_regions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"sequence_id" text NOT NULL,
	"track_id" text NOT NULL,
	"time_binding" jsonb NOT NULL,
	"local_range" jsonb NOT NULL,
	"sequence_range" jsonb NOT NULL,
	"source_stream_id" text NOT NULL,
	"channel_mapping" jsonb NOT NULL,
	"gain_db" text NOT NULL,
	"pan" text NOT NULL,
	"fade_in" jsonb NOT NULL,
	"fade_out" jsonb NOT NULL,
	"parameters" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "composition_caption_spans" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"sequence_id" text NOT NULL,
	"track_id" text NOT NULL,
	"time_binding" jsonb NOT NULL,
	"local_range" jsonb NOT NULL,
	"sequence_range" jsonb NOT NULL,
	"text" text NOT NULL,
	"language_tag" text NOT NULL,
	"style" jsonb NOT NULL,
	"words" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"speech_anchor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "composition_effect_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"sequence_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"effect_type" text NOT NULL,
	"effect_version" text NOT NULL,
	"required_capability" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "composition_visual_objects" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"sequence_id" text NOT NULL,
	"track_id" text NOT NULL,
	"kind" text NOT NULL,
	"parent_object_id" text,
	"semantic_scene_id" text,
	"time_binding" jsonb NOT NULL,
	"local_range" jsonb NOT NULL,
	"sequence_range" jsonb NOT NULL,
	"component" jsonb,
	"parameters" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "composition_animation_bindings" ADD CONSTRAINT "composition_animation_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_animation_bindings" ADD CONSTRAINT "composition_animation_bindings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_animation_bindings" ADD CONSTRAINT "composition_animation_bindings_sequence_id_project_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."project_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_audio_regions" ADD CONSTRAINT "composition_audio_regions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_audio_regions" ADD CONSTRAINT "composition_audio_regions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_audio_regions" ADD CONSTRAINT "composition_audio_regions_sequence_id_project_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."project_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_audio_regions" ADD CONSTRAINT "composition_audio_regions_track_id_sequence_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."sequence_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_caption_spans" ADD CONSTRAINT "composition_caption_spans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_caption_spans" ADD CONSTRAINT "composition_caption_spans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_caption_spans" ADD CONSTRAINT "composition_caption_spans_sequence_id_project_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."project_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_caption_spans" ADD CONSTRAINT "composition_caption_spans_track_id_sequence_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."sequence_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_effect_instances" ADD CONSTRAINT "composition_effect_instances_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_effect_instances" ADD CONSTRAINT "composition_effect_instances_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_effect_instances" ADD CONSTRAINT "composition_effect_instances_sequence_id_project_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."project_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_visual_objects" ADD CONSTRAINT "composition_visual_objects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_visual_objects" ADD CONSTRAINT "composition_visual_objects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_visual_objects" ADD CONSTRAINT "composition_visual_objects_sequence_id_project_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."project_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "composition_visual_objects" ADD CONSTRAINT "composition_visual_objects_track_id_sequence_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."sequence_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "composition_animation_bindings_scope_idx" ON "composition_animation_bindings" USING btree ("workspace_id","project_id","sequence_id");--> statement-breakpoint
CREATE INDEX "composition_animation_bindings_target_idx" ON "composition_animation_bindings" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE INDEX "composition_audio_regions_scope_idx" ON "composition_audio_regions" USING btree ("workspace_id","project_id","sequence_id");--> statement-breakpoint
CREATE INDEX "composition_audio_regions_track_idx" ON "composition_audio_regions" USING btree ("track_id");--> statement-breakpoint
CREATE INDEX "composition_caption_spans_scope_idx" ON "composition_caption_spans" USING btree ("workspace_id","project_id","sequence_id");--> statement-breakpoint
CREATE INDEX "composition_caption_spans_track_idx" ON "composition_caption_spans" USING btree ("track_id");--> statement-breakpoint
CREATE INDEX "composition_caption_spans_speech_anchor_idx" ON "composition_caption_spans" USING btree ("speech_anchor_id");--> statement-breakpoint
CREATE INDEX "composition_effect_instances_scope_idx" ON "composition_effect_instances" USING btree ("workspace_id","project_id","sequence_id");--> statement-breakpoint
CREATE INDEX "composition_effect_instances_target_idx" ON "composition_effect_instances" USING btree ("target_kind","target_id");--> statement-breakpoint
CREATE INDEX "composition_visual_objects_scope_idx" ON "composition_visual_objects" USING btree ("workspace_id","project_id","sequence_id");--> statement-breakpoint
CREATE INDEX "composition_visual_objects_track_idx" ON "composition_visual_objects" USING btree ("track_id");--> statement-breakpoint
CREATE INDEX "composition_visual_objects_parent_idx" ON "composition_visual_objects" USING btree ("parent_object_id");