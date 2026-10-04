ALTER TABLE "edit_events" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "edit_events_project_seq_idx" ON "edit_events" USING btree ("project_id","seq");