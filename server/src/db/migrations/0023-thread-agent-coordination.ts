import { createHash } from 'node:crypto'

export const THREAD_AGENT_COORDINATION_SQL = `
ALTER TABLE channel_tasks ADD COLUMN execution_kind TEXT NOT NULL DEFAULT 'TASK' CHECK(execution_kind IN ('TASK','CHAT'));
CREATE TABLE conversation_threads (
  id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE RESTRICT,
  company_id TEXT NOT NULL, conversation_id TEXT NOT NULL, coordinator_id TEXT NOT NULL,
  root_task_id TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 1 CHECK(round>0),
  status TEXT NOT NULL DEFAULT 'working' CHECK(status IN ('working','waiting','aggregating','completed','awaiting_input')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id,conversation_id,id),
  FOREIGN KEY(company_id,conversation_id,root_task_id) REFERENCES channel_tasks(company_id,conversation_id,id) ON DELETE RESTRICT
);
ALTER TABLE messages ADD COLUMN thread_id TEXT;
ALTER TABLE messages ADD CONSTRAINT message_thread_channel FOREIGN KEY(company_id,conversation_id,thread_id)
  REFERENCES conversation_threads(company_id,conversation_id,id) ON DELETE RESTRICT;
CREATE INDEX messages_thread_sequence ON messages(thread_id,sequence) WHERE thread_id IS NOT NULL;
CREATE TABLE thread_work (
  thread_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE RESTRICT,
  round INTEGER NOT NULL, agent_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES channel_tasks(id) ON DELETE RESTRICT,
  context_id TEXT NOT NULL REFERENCES task_execution_contexts(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK(role IN ('coordinator','member')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','waiting','aggregating','completed','blocked','failed','timed_out')),
  deadline TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '15 minutes',
  result TEXT, result_message_id TEXT REFERENCES messages(id) ON DELETE RESTRICT,
  artifact_id TEXT REFERENCES artifact_versions(id) ON DELETE RESTRICT,
  engine_session_id TEXT, engine TEXT, session_scope TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(thread_id,round,agent_id), UNIQUE(task_id)
);
CREATE INDEX thread_work_pending ON thread_work(agent_id,updated_at) WHERE state IN ('pending','running','aggregating');
CREATE TABLE thread_reads (
  thread_id TEXT NOT NULL REFERENCES conversation_threads(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(thread_id,agent_id)
);
CREATE FUNCTION cumora_inherit_message_thread() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.thread_id IS NULL AND NEW.quoted_message_id IS NOT NULL THEN
    SELECT thread_id INTO NEW.thread_id FROM messages WHERE id=NEW.quoted_message_id
      AND conversation_id=NEW.conversation_id AND company_id=NEW.company_id;
  END IF;
  IF NEW.thread_id IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM participants WHERE id=NEW.author_id AND company_id=NEW.company_id AND kind='human') THEN
      SELECT ARRAY[coordinator_id] INTO NEW.work_recipient_ids FROM conversation_threads WHERE id=NEW.thread_id;
    ELSE
      NEW.work_recipient_ids := ARRAY[]::TEXT[];
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_message_thread BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION cumora_inherit_message_thread();
`

export function threadAgentCoordinationChecksum(): string {
  return createHash('sha256').update(THREAD_AGENT_COORDINATION_SQL).digest('hex')
}
