import { createHash } from 'node:crypto'

export const TASK_SOURCE_AND_GOVERNANCE_LINKS_SQL = `
ALTER TABLE channel_tasks ADD COLUMN governance_attempt_id TEXT REFERENCES governance_action_attempts(id) ON DELETE RESTRICT;
ALTER TABLE messages ADD COLUMN task_source_version INTEGER NOT NULL DEFAULT 1 CHECK(task_source_version>0);
ALTER TABLE task_inputs ADD COLUMN retired_at TIMESTAMPTZ;
CREATE FUNCTION rotate_task_message_source_version() RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body OR NEW.attachment IS DISTINCT FROM OLD.attachment OR NEW.author_id IS DISTINCT FROM OLD.author_id OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN
    NEW.task_source_version:=OLD.task_source_version+1;
  END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER message_task_source_version BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION rotate_task_message_source_version();
CREATE TRIGGER knowledge_content_immutable BEFORE UPDATE OF owner_kind,owner_id,body,content_hash,provenance,version ON knowledge_entries FOR EACH ROW EXECUTE FUNCTION immutable_task_version();
CREATE TRIGGER task_input_content_immutable BEFORE UPDATE OF task_id,company_id,kind,reference_id,content,content_hash,provenance,input_revision ON task_inputs FOR EACH ROW EXECUTE FUNCTION immutable_task_version();
CREATE TRIGGER task_context_content_immutable BEFORE UPDATE OF task_id,company_id,binding_id,scope_revision,input_revision,workspace_generation,binding_version,assignment_id,computer_id,runtime,configuration,input_ids ON task_execution_contexts FOR EACH ROW EXECUTE FUNCTION immutable_task_version();
CREATE TRIGGER task_grant_bound_immutable BEFORE UPDATE OF company_id,task_id,source_grant_id,source_version,scope_revision,rule,parent_grant_id ON task_grant_versions FOR EACH ROW EXECUTE FUNCTION immutable_task_version();
`

export function taskSourceAndGovernanceLinksChecksum(): string { return createHash('sha256').update(TASK_SOURCE_AND_GOVERNANCE_LINKS_SQL).digest('hex') }
