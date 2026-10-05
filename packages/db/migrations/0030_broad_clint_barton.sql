CREATE TABLE "credit_packs" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"credits" integer NOT NULL,
	"price_minor" integer DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "credit_packs_code_version_uq" ON "credit_packs" USING btree ("code","version");--> statement-breakpoint
CREATE INDEX "credit_packs_code_idx" ON "credit_packs" USING btree ("code","version");