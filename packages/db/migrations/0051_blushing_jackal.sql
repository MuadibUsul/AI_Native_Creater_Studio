CREATE TABLE "admin_principals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"environment" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"grant_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "admin_role_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"role" text NOT NULL,
	"granted_by_principal_id" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"auth_session_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"environment" text NOT NULL,
	"grant_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"reauthenticated_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent_hash" text,
	"ip_hash" text,
	"reauth_failures" integer DEFAULT 0 NOT NULL,
	"reauth_locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_principals" ADD CONSTRAINT "admin_principals_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_role_grants" ADD CONSTRAINT "admin_role_grants_principal_id_admin_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."admin_principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_principal_id_admin_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."admin_principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_auth_session_id_session_id_fk" FOREIGN KEY ("auth_session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_principals_user_environment_unique" ON "admin_principals" USING btree ("user_id","environment");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_role_grants_active_unique" ON "admin_role_grants" USING btree ("principal_id","role") WHERE "admin_role_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "admin_role_grants_principal_idx" ON "admin_role_grants" USING btree ("principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_sessions_auth_session_unique" ON "admin_sessions" USING btree ("auth_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_sessions_token_hash_unique" ON "admin_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "admin_sessions_principal_idx" ON "admin_sessions" USING btree ("principal_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "two_factor_user_unique" ON "two_factor" USING btree ("user_id");
--> statement-breakpoint
CREATE FUNCTION "bump_admin_grant_version"() RETURNS trigger AS $$
BEGIN
  UPDATE "admin_principals"
  SET "grant_version" = "grant_version" + 1, "updated_at" = now()
  WHERE "id" = COALESCE(NEW."principal_id", OLD."principal_id");
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "admin_role_grants_version_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "admin_role_grants"
FOR EACH ROW EXECUTE FUNCTION "bump_admin_grant_version"();
