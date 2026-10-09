ALTER TABLE "edit_events" ADD COLUMN "object_kind" text;--> statement-breakpoint
ALTER TABLE "edit_events" ADD COLUMN "object_id" text;--> statement-breakpoint
CREATE INDEX "edit_events_project_object_idx" ON "edit_events" USING btree ("project_id","object_kind","object_id");