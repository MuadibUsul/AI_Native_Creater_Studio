CREATE TABLE "user_appearance_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'system' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_appearance_mode_check" CHECK ("user_appearance_preferences"."mode" in ('system', 'light', 'dark'))
);
--> statement-breakpoint
ALTER TABLE "user_appearance_preferences" ADD CONSTRAINT "user_appearance_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;