import {createHash} from 'node:crypto'

export const TASK_DEFINITION_SNAPSHOTS_SQL=`
ALTER TABLE channel_tasks ADD COLUMN definition_version_id TEXT;
ALTER TABLE channel_tasks ADD COLUMN configuration JSONB;
UPDATE channel_tasks t SET definition_version_id=b.definition_version_id,configuration=jsonb_build_object(
  'instructions',COALESCE((SELECT x.configuration->>'instructions' FROM task_execution_contexts x WHERE x.task_id=t.id AND x.company_id=t.company_id ORDER BY x.created_at,x.id LIMIT 1),b.configuration->>'instructions',d.body->>'instructions',''),
  'role',d.body->>'role')
FROM channel_agent_bindings b JOIN agent_definition_versions d ON d.id=b.definition_version_id AND d.company_id=b.company_id
WHERE t.accountable_binding_id=b.id AND t.company_id=b.company_id;
ALTER TABLE channel_tasks ALTER COLUMN definition_version_id SET NOT NULL;
ALTER TABLE channel_tasks ALTER COLUMN configuration SET NOT NULL;
ALTER TABLE channel_tasks ADD CONSTRAINT task_definition_tenant_fk FOREIGN KEY(definition_version_id,company_id) REFERENCES agent_definition_versions(id,company_id) ON DELETE RESTRICT;
CREATE TRIGGER task_definition_snapshot_immutable BEFORE UPDATE OF definition_version_id,configuration ON channel_tasks FOR EACH ROW EXECUTE FUNCTION immutable_task_version();
`
export function taskDefinitionSnapshotsChecksum():string{return createHash('sha256').update(TASK_DEFINITION_SNAPSHOTS_SQL).digest('hex')}
