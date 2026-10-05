import { createHash } from 'node:crypto'

/** Even a completed/blocked executor owns its slot until its supervisor confirms it stopped. */
export const TASK_EXECUTOR_FENCES_SQL = `
DROP INDEX task_agent_live_dispatch;
CREATE UNIQUE INDEX task_agent_live_dispatch ON task_dispatches(company_id,agent_id)
WHERE state IN ('CLAIMED','UNKNOWN','COMPLETED','BLOCKED') AND stopped_at IS NULL;

CREATE FUNCTION validate_task_dispatch_context() RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM task_execution_contexts x JOIN channel_tasks t ON t.id=x.task_id AND t.company_id=x.company_id
    JOIN channel_agent_bindings b ON b.id=x.binding_id AND b.company_id=x.company_id
    WHERE x.id=NEW.context_id AND x.company_id=NEW.company_id AND x.task_id=NEW.task_id AND b.agent_id=NEW.agent_id AND b.conversation_id=t.conversation_id) THEN
    RAISE EXCEPTION 'dispatch context must pin task binding and agent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER dispatch_context_consistency BEFORE INSERT OR UPDATE OF context_id,task_id,company_id,agent_id ON task_dispatches
FOR EACH ROW EXECUTE FUNCTION validate_task_dispatch_context();

CREATE FUNCTION validate_task_message_channel() RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM channel_tasks t JOIN messages m ON m.conversation_id=t.conversation_id AND m.company_id=t.company_id
    WHERE t.id=NEW.task_id AND t.company_id=NEW.company_id AND m.id=NEW.message_id) THEN
    RAISE EXCEPTION 'task messages must belong to task channel' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER task_message_consistency BEFORE INSERT OR UPDATE ON task_message_links FOR EACH ROW EXECUTE FUNCTION validate_task_message_channel();

CREATE FUNCTION validate_task_artifact_binding() RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM channel_tasks t JOIN channel_agent_bindings b ON b.company_id=t.company_id AND b.conversation_id=t.conversation_id
    WHERE t.id=NEW.task_id AND t.company_id=NEW.company_id AND b.id=NEW.producer_binding_id) THEN
    RAISE EXCEPTION 'artifact producer must belong to task channel' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER artifact_binding_consistency BEFORE INSERT ON artifact_versions FOR EACH ROW EXECUTE FUNCTION validate_task_artifact_binding();
`

export function taskExecutorFencesChecksum(): string { return createHash('sha256').update(TASK_EXECUTOR_FENCES_SQL).digest('hex') }
