CREATE TABLE "provider_catalog_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"catalog" jsonb NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_catalog_versions" ADD CONSTRAINT "provider_catalog_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_catalog_versions_version_uq" ON "provider_catalog_versions" USING btree ("version");--> statement-breakpoint
CREATE INDEX "provider_catalog_versions_created_idx" ON "provider_catalog_versions" USING btree ("created_at");