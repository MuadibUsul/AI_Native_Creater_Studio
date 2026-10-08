CREATE TABLE "admin_role_scopes" (
	"id" text PRIMARY KEY NOT NULL,
	"role_grant_id" text NOT NULL,
	"scope_kind" text NOT NULL,
	"workspace_id" text,
	"resource_kind" text,
	"resource_id" text,
	"ticket_id" text,
	"max_credits" integer,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"granted_by_principal_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_role_scopes_kind_check" CHECK ("admin_role_scopes"."scope_kind" in ('PLATFORM', 'WORKSPACE', 'OBJECT')),
	CONSTRAINT "admin_role_scopes_resource_kind_check" CHECK ("admin_role_scopes"."resource_kind" is null or "admin_role_scopes"."resource_kind" in ('USER', 'WORKSPACE', 'PROJECT', 'JOB', 'ABUSE_FLAG', 'SUPPORT_GRANT', 'LEDGER_ENTRY', 'PLAN')),
	CONSTRAINT "admin_role_scopes_shape_check" CHECK ((
    ("admin_role_scopes"."scope_kind" = 'PLATFORM' and "admin_role_scopes"."workspace_id" is null and "admin_role_scopes"."resource_kind" is null and "admin_role_scopes"."resource_id" is null)
    or ("admin_role_scopes"."scope_kind" = 'WORKSPACE' and "admin_role_scopes"."workspace_id" is not null and "admin_role_scopes"."resource_kind" is null and "admin_role_scopes"."resource_id" is null)
    or ("admin_role_scopes"."scope_kind" = 'OBJECT' and "admin_role_scopes"."workspace_id" is not null and "admin_role_scopes"."resource_kind" is not null and "admin_role_scopes"."resource_id" is not null)
  )),
	CONSTRAINT "admin_role_scopes_amount_check" CHECK ("admin_role_scopes"."max_credits" is null or "admin_role_scopes"."max_credits" >= 0),
	CONSTRAINT "admin_role_scopes_time_check" CHECK ("admin_role_scopes"."expires_at" is null or "admin_role_scopes"."expires_at" > "admin_role_scopes"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD COLUMN "ticket_id" text;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD COLUMN "beneficiary_principal_id" text;--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD COLUMN "scope" text;--> statement-breakpoint
ALTER TABLE "admin_role_scopes" ADD CONSTRAINT "admin_role_scopes_role_grant_id_admin_role_grants_id_fk" FOREIGN KEY ("role_grant_id") REFERENCES "public"."admin_role_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_role_scopes_grant_idx" ON "admin_role_scopes" USING btree ("role_grant_id","revoked_at");--> statement-breakpoint
CREATE INDEX "admin_role_scopes_workspace_idx" ON "admin_role_scopes" USING btree ("workspace_id","revoked_at");--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_access_grants_beneficiary_principal_id_admin_principals_id_fk" FOREIGN KEY ("beneficiary_principal_id") REFERENCES "public"."admin_principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_principals" ADD CONSTRAINT "admin_principals_environment_check" CHECK ("admin_principals"."environment" in ('DEVELOPMENT', 'TEST', 'STAGING', 'PRODUCTION'));--> statement-breakpoint
ALTER TABLE "admin_role_grants" ADD CONSTRAINT "admin_role_grants_role_check" CHECK ("admin_role_grants"."role" in ('PLATFORM_OWNER', 'SUPPORT_L1', 'SUPPORT_L2', 'PRODUCTION_OPERATOR', 'PROVIDER_MANAGER', 'BILLING_OPERATOR', 'BILLING_APPROVER', 'CONTENT_REVIEWER', 'REVIEW_LEAD', 'AI_QUALITY', 'STRATEGY_CURATOR', 'GROWTH_ANALYST', 'PRIVACY_OFFICER', 'SECURITY_ADMIN', 'AUDITOR', 'SERVICE_ACCOUNT'));--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_environment_check" CHECK ("admin_sessions"."environment" in ('DEVELOPMENT', 'TEST', 'STAGING', 'PRODUCTION'));--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_grants_scope_check" CHECK ("support_access_grants"."scope" is null or "support_access_grants"."scope" = 'SUMMARY_READ');--> statement-breakpoint
ALTER TABLE "support_access_grants" ADD CONSTRAINT "support_grants_binding_check" CHECK ((
      "support_access_grants"."ticket_id" is null and "support_access_grants"."beneficiary_principal_id" is null and "support_access_grants"."scope" is null
    ) or (
      "support_access_grants"."ticket_id" is not null and "support_access_grants"."beneficiary_principal_id" is not null and "support_access_grants"."scope" is not null
    ));
--> statement-breakpoint
CREATE FUNCTION "bump_admin_role_scope_version"() RETURNS trigger AS $$
DECLARE
  changed_role_grant_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    changed_role_grant_id := OLD."role_grant_id";
  ELSE
    changed_role_grant_id := NEW."role_grant_id";
  END IF;
  UPDATE "admin_principals"
  SET "grant_version" = "grant_version" + 1, "updated_at" = now()
  WHERE "id" = (
    SELECT "principal_id" FROM "admin_role_grants"
    WHERE "id" = changed_role_grant_id
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "admin_role_scopes_version_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "admin_role_scopes"
FOR EACH ROW EXECUTE FUNCTION "bump_admin_role_scope_version"();
