-- 修正 0095 的只增不改触发器：删除工作区时，授权记录会经 workspace_id 外键直接级联，
-- 此时身份档案行可能还在（级联顺序不定），原触发器会拒绝整个工作区删除。
-- 规则不变：记录不可单独删除；只有父行（身份档案或工作区）已不存在时才允许随之清理。
CREATE OR REPLACE FUNCTION "protect_identity_consent_record"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "creator_identities" WHERE "id" = OLD."creator_identity_id")
      AND EXISTS (SELECT 1 FROM "workspaces" WHERE "id" = OLD."workspace_id") THEN
      RAISE EXCEPTION 'identity consent records are append-only';
    END IF;
    RETURN OLD;
  END IF;
  -- 只允许用户注销时把操作人置空（外键 ON DELETE SET NULL），其余字段不可改写
  IF NEW."actor_id" IS NULL AND (to_jsonb(NEW) - 'actor_id') = (to_jsonb(OLD) - 'actor_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'identity consent records are append-only';
END;
$$ LANGUAGE plpgsql;
