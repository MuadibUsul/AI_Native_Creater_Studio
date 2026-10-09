CREATE TABLE "upload_parts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"upload_intent_id" text NOT NULL,
	"part_number" integer NOT NULL,
	"storage_key" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"size_bytes" bigint,
	"checksum_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "upload_intents" ADD COLUMN "upload_mode" text DEFAULT 'SINGLE' NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_intents" ADD COLUMN "part_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "upload_intents" ADD COLUMN "part_count" integer;--> statement-breakpoint
ALTER TABLE "upload_parts" ADD CONSTRAINT "upload_parts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_parts" ADD CONSTRAINT "upload_parts_upload_intent_id_upload_intents_id_fk" FOREIGN KEY ("upload_intent_id") REFERENCES "public"."upload_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "upload_parts_intent_number_uq" ON "upload_parts" USING btree ("upload_intent_id","part_number");--> statement-breakpoint
CREATE INDEX "upload_parts_workspace_intent_idx" ON "upload_parts" USING btree ("workspace_id","upload_intent_id");