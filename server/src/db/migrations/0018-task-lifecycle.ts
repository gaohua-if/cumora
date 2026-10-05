import { createHash } from 'node:crypto'
export const TASK_LIFECYCLE_SQL = `
CREATE TRIGGER task_bundle_immutable BEFORE UPDATE ON access_bundle_versions FOR EACH ROW EXECUTE FUNCTION immutable_task_version();
ALTER TABLE artifact_versions ADD COLUMN retention_until TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '365 days';
CREATE UNIQUE INDEX task_computer_tenant ON computers(id,company_id);
ALTER TABLE task_runtime_admissions ADD CONSTRAINT task_admission_computer_fk FOREIGN KEY(computer_id,company_id) REFERENCES computers(id,company_id) ON DELETE RESTRICT;
CREATE FUNCTION invalidate_departed_task_principal() RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN
  IF NEW.departed_at IS NOT NULL AND OLD.departed_at IS NULL THEN
    UPDATE channel_agent_bindings SET status='ENDED',version=version+1 WHERE company_id=NEW.company_id AND agent_id=NEW.id AND status='ACTIVE';
    UPDATE access_grants SET revoked_at=NOW(),version=version+1 WHERE company_id=NEW.company_id AND revoked_at IS NULL AND (caller_principal_id=NEW.id OR issuer_principal_id=NEW.id);
    UPDATE access_connections SET status='REVOKED' WHERE company_id=NEW.company_id AND owner_principal_id=NEW.id;
    UPDATE task_execution_contexts x SET revoked_at=NOW() WHERE x.company_id=NEW.company_id AND (x.binding_id IN(SELECT id FROM channel_agent_bindings WHERE company_id=NEW.company_id AND agent_id=NEW.id) OR x.task_id IN(SELECT id FROM channel_tasks WHERE company_id=NEW.company_id AND creator_principal_id=NEW.id));
    UPDATE task_dispatches d SET state=CASE WHEN d.state='PENDING' THEN 'CANCELLED' ELSE 'UNKNOWN' END WHERE d.company_id=NEW.company_id AND d.state IN('PENDING','CLAIMED') AND d.context_id IN(SELECT id FROM task_execution_contexts WHERE company_id=NEW.company_id AND revoked_at IS NOT NULL);
    UPDATE knowledge_publications SET revoked_at=NOW() WHERE company_id=NEW.company_id AND published_by=NEW.id;
  END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER task_departure AFTER UPDATE OF departed_at ON participants FOR EACH ROW EXECUTE FUNCTION invalidate_departed_task_principal();
CREATE FUNCTION invalidate_revoked_task_computer() RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN
  IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
    UPDATE task_runtime_admissions SET revoked_at=NOW() WHERE company_id=NEW.company_id AND computer_id=NEW.id;
    UPDATE task_execution_contexts SET revoked_at=NOW() WHERE company_id=NEW.company_id AND computer_id=NEW.id;
    UPDATE task_dispatches SET state=CASE WHEN state='PENDING' THEN 'CANCELLED' ELSE 'UNKNOWN' END WHERE company_id=NEW.company_id AND state IN('PENDING','CLAIMED') AND context_id IN(SELECT id FROM task_execution_contexts WHERE company_id=NEW.company_id AND computer_id=NEW.id);
  END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER task_computer_revoke AFTER UPDATE OF revoked_at ON computers FOR EACH ROW EXECUTE FUNCTION invalidate_revoked_task_computer();
CREATE FUNCTION retain_task_artifact() RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN
  IF OLD.retention_until>NOW() OR OLD.governance_version_id IS NOT NULL OR EXISTS(SELECT 1 FROM artifact_handoffs WHERE company_id=OLD.company_id AND version_id=OLD.id) OR EXISTS(SELECT 1 FROM task_deliveries WHERE company_id=OLD.company_id AND (artifact_ids @> jsonb_build_array(OLD.id) OR evidence_ids @> jsonb_build_array(OLD.id))) THEN
    RAISE EXCEPTION 'task artifact is retained or referenced' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END
$body$;
CREATE TRIGGER task_artifact_retention BEFORE DELETE ON artifact_versions FOR EACH ROW EXECUTE FUNCTION retain_task_artifact();
`
export function taskLifecycleChecksum():string { return createHash('sha256').update(TASK_LIFECYCLE_SQL).digest('hex') }
