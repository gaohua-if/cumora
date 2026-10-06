import { createHash } from 'node:crypto'

export const CONFIGURATION_WORKBENCH_SQL = `
CREATE TABLE configuration_workspace_settings (
  company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  language TEXT NOT NULL DEFAULT 'zh-CN' CHECK(language IN('zh-CN','en'))
);
CREATE TABLE skill_versions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  body JSONB NOT NULL,
  content_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id,skill_id,version),
  UNIQUE(id,company_id)
);
CREATE TRIGGER skill_version_immutable BEFORE UPDATE ON skill_versions
  FOR EACH ROW EXECUTE FUNCTION immutable_task_version();
ALTER TABLE conversations ADD COLUMN task_configuration JSONB NOT NULL DEFAULT '{}';
ALTER TABLE access_bundle_versions ADD COLUMN body JSONB NOT NULL DEFAULT '{}';
CREATE TRIGGER access_bundle_version_immutable BEFORE UPDATE ON access_bundle_versions
  FOR EACH ROW EXECUTE FUNCTION immutable_task_version();
ALTER TABLE channel_agent_bindings ADD COLUMN eligibility_version INTEGER NOT NULL DEFAULT 1;
UPDATE channel_agent_bindings SET eligibility_version=version;
CREATE FUNCTION task_binding_eligibility_revision() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version<>OLD.version AND NEW.definition_version_id IS NOT DISTINCT FROM OLD.definition_version_id
    AND NEW.configuration IS NOT DISTINCT FROM OLD.configuration
    AND NEW.alias IS NOT DISTINCT FROM OLD.alias AND NEW.is_default IS NOT DISTINCT FROM OLD.is_default
    OR NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.eligibility_version=OLD.eligibility_version+1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER task_binding_eligibility_fence BEFORE UPDATE ON channel_agent_bindings
  FOR EACH ROW EXECUTE FUNCTION task_binding_eligibility_revision();
`

export function configurationWorkbenchChecksum(): string { return createHash('sha256').update(CONFIGURATION_WORKBENCH_SQL).digest('hex') }
