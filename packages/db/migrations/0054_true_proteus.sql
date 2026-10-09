CREATE TABLE "admin_emergency_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"environment" text NOT NULL,
	"principal_id" text NOT NULL,
	"action" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"incident_id" text NOT NULL,
	"reason" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"alerted_at" timestamp with time zone,
	"review_due_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_principal_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_emergency_environment_check" CHECK ("admin_emergency_grants"."environment" in ('DEVELOPMENT', 'TEST', 'STAGING', 'PRODUCTION')),
	CONSTRAINT "admin_emergency_action_target_check" CHECK ((
    ("admin_emergency_grants"."action" = 'PAUSE_NEW_GENERATION' and "admin_emergency_grants"."target_kind" = 'WORKSPACE')
    or ("admin_emergency_grants"."action" = 'REVOKE_COMPROMISED_OPS_SESSION' and "admin_emergency_grants"."target_kind" = 'OPS_SESSION')
  )),
	CONSTRAINT "admin_emergency_target_check" CHECK (length(btrim("admin_emergency_grants"."target_id")) > 0),
	CONSTRAINT "admin_emergency_incident_check" CHECK (length(btrim("admin_emergency_grants"."incident_id")) between 1 and 128),
	CONSTRAINT "admin_emergency_reason_check" CHECK (length(btrim("admin_emergency_grants"."reason")) between 10 and 500),
	CONSTRAINT "admin_emergency_time_check" CHECK ("admin_emergency_grants"."expires_at" > "admin_emergency_grants"."starts_at" and "admin_emergency_grants"."expires_at" <= "admin_emergency_grants"."starts_at" + interval '30 minutes'),
	CONSTRAINT "admin_emergency_review_due_check" CHECK ("admin_emergency_grants"."review_due_at" >= "admin_emergency_grants"."expires_at" and "admin_emergency_grants"."review_due_at" <= "admin_emergency_grants"."expires_at" + interval '24 hours'),
	CONSTRAINT "admin_emergency_review_check" CHECK (("admin_emergency_grants"."reviewed_at" is null and "admin_emergency_grants"."reviewed_by_principal_id" is null) or ("admin_emergency_grants"."reviewed_at" is not null and "admin_emergency_grants"."reviewed_by_principal_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "admin_permission_policy_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"environment" text NOT NULL,
	"version" text NOT NULL,
	"rules_hash" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"created_by_principal_id" text,
	"published_by_principal_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "admin_policy_environment_check" CHECK ("admin_permission_policy_versions"."environment" in ('DEVELOPMENT', 'TEST', 'STAGING', 'PRODUCTION')),
	CONSTRAINT "admin_policy_status_check" CHECK ("admin_permission_policy_versions"."status" in ('DRAFT', 'ACTIVE', 'RETIRED')),
	CONSTRAINT "admin_policy_hash_check" CHECK ("admin_permission_policy_versions"."rules_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "admin_policy_version_check" CHECK (length(btrim("admin_permission_policy_versions"."version")) between 1 and 80),
	CONSTRAINT "admin_policy_lifecycle_check" CHECK ((
    ("admin_permission_policy_versions"."status" = 'DRAFT' and "admin_permission_policy_versions"."published_at" is null and "admin_permission_policy_versions"."retired_at" is null)
    or ("admin_permission_policy_versions"."status" = 'ACTIVE' and "admin_permission_policy_versions"."published_at" is not null and "admin_permission_policy_versions"."retired_at" is null and "admin_permission_policy_versions"."published_by_principal_id" is not null)
    or ("admin_permission_policy_versions"."status" = 'RETIRED' and "admin_permission_policy_versions"."published_at" is not null and "admin_permission_policy_versions"."retired_at" is not null and "admin_permission_policy_versions"."published_by_principal_id" is not null)
  ))
);
--> statement-breakpoint
CREATE INDEX "admin_emergency_principal_target_idx" ON "admin_emergency_grants" USING btree ("principal_id","environment","action","target_id");--> statement-breakpoint
CREATE INDEX "admin_emergency_expires_idx" ON "admin_emergency_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_policy_environment_version_unique" ON "admin_permission_policy_versions" USING btree ("environment","version");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_policy_one_active_per_environment" ON "admin_permission_policy_versions" USING btree ("environment") WHERE "admin_permission_policy_versions"."status" = 'ACTIVE';
--> statement-breakpoint
CREATE FUNCTION "protect_admin_policy_version"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'published policy versions are immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'RETIRED' THEN
    RAISE EXCEPTION 'retired policy versions are immutable';
  END IF;
  IF OLD."status" = 'ACTIVE' THEN
    IF NEW."status" NOT IN ('ACTIVE', 'RETIRED') OR
       (to_jsonb(NEW) - 'status' - 'retired_at') <> (to_jsonb(OLD) - 'status' - 'retired_at') THEN
      RAISE EXCEPTION 'published policy versions are immutable';
    END IF;
  END IF;
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'RETIRED' THEN
    RAISE EXCEPTION 'draft policy cannot retire without publication';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "admin_policy_immutability_trigger"
BEFORE UPDATE OR DELETE ON "admin_permission_policy_versions"
FOR EACH ROW EXECUTE FUNCTION "protect_admin_policy_version"();
--> statement-breakpoint
CREATE FUNCTION "protect_admin_emergency_grant"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'emergency grants retain their evidence';
  END IF;
  IF (to_jsonb(NEW) - 'alerted_at' - 'revoked_at' - 'reviewed_at' - 'reviewed_by_principal_id') <>
     (to_jsonb(OLD) - 'alerted_at' - 'revoked_at' - 'reviewed_at' - 'reviewed_by_principal_id') THEN
    RAISE EXCEPTION 'emergency grant scope is immutable';
  END IF;
  IF (OLD."alerted_at" IS NOT NULL AND NEW."alerted_at" IS DISTINCT FROM OLD."alerted_at") OR
     (OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at") OR
     (OLD."reviewed_at" IS NOT NULL AND (NEW."reviewed_at" IS DISTINCT FROM OLD."reviewed_at" OR NEW."reviewed_by_principal_id" IS DISTINCT FROM OLD."reviewed_by_principal_id")) THEN
    RAISE EXCEPTION 'emergency grant evidence cannot be rewritten';
  END IF;
  IF NEW."reviewed_by_principal_id" = NEW."principal_id" THEN
    RAISE EXCEPTION 'emergency grant cannot self-review';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "admin_emergency_immutability_trigger"
BEFORE UPDATE OR DELETE ON "admin_emergency_grants"
FOR EACH ROW EXECUTE FUNCTION "protect_admin_emergency_grant"();
