ALTER TABLE "sequence_tracks" ADD COLUMN "solo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sequence_tracks" ADD COLUMN "sync_locked" boolean DEFAULT false NOT NULL;