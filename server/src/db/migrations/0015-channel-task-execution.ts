import { createHash } from 'node:crypto'

/** Append-only task contract. Historical migrations remain byte-for-byte stable. */
export const CHANNEL_TASK_EXECUTION_SQL = `
CREATE TABLE task_workspace_settings (
  company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'LEGACY' CHECK (mode IN ('LEGACY','PREPARING','TASK')),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE agent_definition_versions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  definition_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  body JSONB NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id,id), UNIQUE (company_id,definition_id,version)
);
CREATE TABLE channel_agent_bindings (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, definition_version_id TEXT NOT NULL,
  alias TEXT NOT NULL, is_default BOOLEAN NOT NULL DEFAULT FALSE,
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ENDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id,conversation_id,id), UNIQUE (company_id,id),
  FOREIGN KEY (conversation_id,company_id) REFERENCES conversations(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id,company_id) REFERENCES participants(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id,definition_version_id) REFERENCES agent_definition_versions(company_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX task_binding_active ON channel_agent_bindings(company_id,conversation_id,agent_id) WHERE status='ACTIVE';
CREATE UNIQUE INDEX task_binding_default ON channel_agent_bindings(company_id,conversation_id) WHERE status='ACTIVE' AND is_default;
CREATE TABLE access_connections (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  owner_principal_id TEXT NOT NULL, identity_kind TEXT NOT NULL CHECK (identity_kind IN ('PERSONAL','SERVICE')),
  access_identity TEXT NOT NULL, adapter TEXT NOT NULL, configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  credential_ref TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  UNIQUE(company_id,id)
);
CREATE TABLE access_grants (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  issuer_principal_id TEXT NOT NULL, caller_principal_id TEXT NOT NULL,
  connection_id TEXT, rule JSONB NOT NULL, authority_ref TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, revoked_at TIMESTAMPTZ, expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(company_id,id),
  FOREIGN KEY (conversation_id,company_id) REFERENCES conversations(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id,connection_id) REFERENCES access_connections(company_id,id) ON DELETE RESTRICT
);
CREATE TABLE access_bundle_versions (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  bundle_id TEXT NOT NULL, version INTEGER NOT NULL CHECK (version > 0),
  grant_ids JSONB NOT NULL, created_by TEXT NOT NULL,
  UNIQUE(company_id,id), UNIQUE(company_id,bundle_id,version)
);
CREATE TABLE channel_access_refs (
  company_id TEXT NOT NULL, conversation_id TEXT NOT NULL, bundle_version_id TEXT NOT NULL,
  PRIMARY KEY(company_id,conversation_id,bundle_version_id),
  FOREIGN KEY (conversation_id,company_id) REFERENCES conversations(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id,bundle_version_id) REFERENCES access_bundle_versions(company_id,id) ON DELETE RESTRICT
);
CREATE TABLE channel_tasks (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  creator_principal_id TEXT NOT NULL, accountable_binding_id TEXT NOT NULL,
  parent_task_id TEXT, root_task_id TEXT NOT NULL,
  objective TEXT NOT NULL CHECK(length(objective) BETWEEN 1 AND 12000),
  scope_revision INTEGER NOT NULL DEFAULT 1 CHECK(scope_revision>0),
  input_revision INTEGER NOT NULL DEFAULT 1 CHECK(input_revision>0),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','BLOCKED','DELIVERED','CANCELLED')),
  blocked_code TEXT, version INTEGER NOT NULL DEFAULT 1,
  reply_message_id TEXT, ingress_key TEXT NOT NULL,
  governance_action_id TEXT REFERENCES governance_actions(id) ON DELETE RESTRICT,
  board_card_id TEXT REFERENCES board_cards(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id,id), UNIQUE(company_id,conversation_id,id),
  UNIQUE(company_id,ingress_key),
  FOREIGN KEY (conversation_id,company_id) REFERENCES conversations(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id,conversation_id,accountable_binding_id) REFERENCES channel_agent_bindings(company_id,conversation_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id,conversation_id,parent_task_id) REFERENCES channel_tasks(company_id,conversation_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id,conversation_id,root_task_id) REFERENCES channel_tasks(company_id,conversation_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK(parent_task_id IS DISTINCT FROM id)
);
CREATE TABLE task_controller_grants (
  company_id TEXT NOT NULL, task_id TEXT NOT NULL, principal_id TEXT NOT NULL,
  actions JSONB NOT NULL, granted_by TEXT NOT NULL, revoked_at TIMESTAMPTZ,
  PRIMARY KEY(company_id,task_id,principal_id),
  FOREIGN KEY(company_id,task_id) REFERENCES channel_tasks(company_id,id) ON DELETE RESTRICT
);
CREATE TABLE task_scope_revisions (
  company_id TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL,
  objective TEXT NOT NULL, changed_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(company_id,task_id,revision),
  FOREIGN KEY(company_id,task_id) REFERENCES channel_tasks(company_id,id) ON DELETE RESTRICT
);
CREATE TABLE task_grant_versions (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, task_id TEXT NOT NULL,
  source_grant_id TEXT NOT NULL, source_version INTEGER NOT NULL, scope_revision INTEGER NOT NULL,
  rule JSONB NOT NULL, parent_grant_id TEXT, revoked_at TIMESTAMPTZ,
  UNIQUE(company_id,id),
  FOREIGN KEY(company_id,task_id) REFERENCES channel_tasks(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,source_grant_id) REFERENCES access_grants(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,parent_grant_id) REFERENCES task_grant_versions(company_id,id) ON DELETE RESTRICT
);
CREATE TABLE task_message_links (
  company_id TEXT NOT NULL, task_id TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK(purpose IN ('TRIGGER','SUPPLEMENT','STATUS','DELIVERY')),
  PRIMARY KEY(company_id,task_id,message_id),
  FOREIGN KEY(company_id,task_id) REFERENCES channel_tasks(company_id,id) ON DELETE RESTRICT
);
CREATE TABLE task_inputs (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('TEXT','MESSAGE','ARTIFACT','KNOWLEDGE')),
  reference_id TEXT, content TEXT, content_hash TEXT NOT NULL,
  provenance JSONB NOT NULL, input_revision INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(company_id,id),
  FOREIGN KEY(company_id,task_id) REFERENCES channel_tasks(company_id,id) ON DELETE RESTRICT
);
CREATE TABLE task_execution_contexts (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, task_id TEXT NOT NULL,
  binding_id TEXT NOT NULL, scope_revision INTEGER NOT NULL, input_revision INTEGER NOT NULL,
  workspace_generation INTEGER NOT NULL, binding_version INTEGER NOT NULL,
  assignment_id TEXT NOT NULL, computer_id TEXT, runtime JSONB NOT NULL,
  configuration JSONB NOT NULL, input_ids JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ, UNIQUE(company_id,id),
  FOREIGN KEY(company_id,task_id) REFERENCES channel_tasks(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,binding_id) REFERENCES channel_agent_bindings(company_id,id) ON DELETE RESTRICT
);
CREATE TABLE task_dispatches (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, task_id TEXT NOT NULL, context_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, dispatch_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','CLAIMED','COMPLETED','BLOCKED','UNKNOWN','CANCELLED')),
  claim_generation INTEGER NOT NULL DEFAULT 0, claimant TEXT, claim_token_hash TEXT,
  lease_expires_at TIMESTAMPTZ, stopped_at TIMESTAMPTZ, result_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(company_id,id), UNIQUE(company_id,dispatch_key),
  FOREIGN KEY(company_id,task_id) REFERENCES channel_tasks(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,context_id) REFERENCES task_execution_contexts(company_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX task_agent_live_dispatch ON task_dispatches(company_id,agent_id) WHERE state IN ('CLAIMED','UNKNOWN') AND stopped_at IS NULL;
CREATE INDEX task_dispatch_pending ON task_dispatches(company_id,agent_id,created_at) WHERE state='PENDING';
CREATE TABLE task_plan_versions (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, task_id TEXT NOT NULL,
  revision INTEGER NOT NULL, plan JSONB NOT NULL, created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(company_id,id), UNIQUE(company_id,task_id,revision),
  FOREIGN KEY(company_id,task_id) REFERENCES channel_tasks(company_id,id) ON DELETE RESTRICT
);
CREATE TABLE task_dependencies (
  company_id TEXT NOT NULL, task_id TEXT NOT NULL, dependency_task_id TEXT NOT NULL,
  PRIMARY KEY(company_id,task_id,dependency_task_id), CHECK(task_id<>dependency_task_id),
  FOREIGN KEY(company_id,task_id) REFERENCES channel_tasks(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,dependency_task_id) REFERENCES channel_tasks(company_id,id) ON DELETE RESTRICT
);
CREATE TABLE artifact_versions (
  id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, company_id TEXT NOT NULL, task_id TEXT NOT NULL,
  producer_binding_id TEXT NOT NULL, media_type TEXT NOT NULL,
  content BYTEA NOT NULL, content_hash TEXT NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
  provenance JSONB NOT NULL, input_version_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  governance_version_id TEXT UNIQUE REFERENCES governance_artifact_versions(version_id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(company_id,id), UNIQUE(company_id,artifact_id,content_hash),
  FOREIGN KEY(company_id,task_id) REFERENCES channel_tasks(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,producer_binding_id) REFERENCES channel_agent_bindings(company_id,id) ON DELETE RESTRICT
);
CREATE TABLE task_deliveries (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, task_id TEXT NOT NULL, scope_revision INTEGER NOT NULL,
  artifact_ids JSONB NOT NULL, evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary TEXT NOT NULL, limitations JSONB NOT NULL DEFAULT '[]'::jsonb,
  message_id TEXT REFERENCES messages(id) ON DELETE RESTRICT, delivery_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(company_id,id), UNIQUE(company_id,task_id,delivery_key),
  FOREIGN KEY(company_id,task_id) REFERENCES channel_tasks(company_id,id) ON DELETE RESTRICT
);
CREATE TABLE artifact_handoffs (
  company_id TEXT NOT NULL, version_id TEXT NOT NULL, consumer_task_id TEXT NOT NULL, consumer_binding_id TEXT NOT NULL,
  content_hash TEXT NOT NULL, checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(company_id,version_id,consumer_task_id,consumer_binding_id),
  FOREIGN KEY(company_id,version_id) REFERENCES artifact_versions(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,consumer_task_id) REFERENCES channel_tasks(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,consumer_binding_id) REFERENCES channel_agent_bindings(company_id,id) ON DELETE RESTRICT
);
CREATE TABLE knowledge_entries (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  owner_kind TEXT NOT NULL CHECK(owner_kind IN ('CHANNEL','AGENT')), owner_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, body TEXT NOT NULL, content_hash TEXT NOT NULL,
  provenance JSONB NOT NULL, state TEXT NOT NULL DEFAULT 'CANDIDATE' CHECK(state IN ('CANDIDATE','CONFIRMED','INVALIDATED')),
  pinned BOOLEAN NOT NULL DEFAULT FALSE, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id,id)
);
CREATE TABLE knowledge_publications (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, knowledge_id TEXT NOT NULL, knowledge_version INTEGER NOT NULL,
  target_conversation_id TEXT NOT NULL, published_by TEXT NOT NULL, authority_refs JSONB NOT NULL,
  revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id,knowledge_id,knowledge_version,target_conversation_id),
  FOREIGN KEY(company_id,knowledge_id) REFERENCES knowledge_entries(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(target_conversation_id,company_id) REFERENCES conversations(id,company_id) ON DELETE RESTRICT
);
CREATE TABLE task_operation_records (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, task_id TEXT NOT NULL, context_id TEXT NOT NULL,
  operation_key TEXT NOT NULL, request_hash TEXT NOT NULL, request JSONB NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PREPARED','DISPATCHED','SUCCEEDED','FAILED','UNKNOWN')),
  result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(company_id,task_id,operation_key),
  FOREIGN KEY(company_id,task_id) REFERENCES channel_tasks(company_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,context_id) REFERENCES task_execution_contexts(company_id,id) ON DELETE RESTRICT
);
CREATE TABLE task_runtime_admissions (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT, computer_id TEXT NOT NULL,
  protocol_version INTEGER NOT NULL CHECK(protocol_version=1), engine TEXT NOT NULL,
  capabilities JSONB NOT NULL, verified_by TEXT NOT NULL, verification_ref TEXT NOT NULL,
  revoked_at TIMESTAMPTZ, PRIMARY KEY(company_id,computer_id,engine)
);
CREATE TABLE task_authorization_events (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  task_id TEXT, principal_id TEXT NOT NULL, operation TEXT NOT NULL, outcome TEXT NOT NULL,
  references_json JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(company_id,task_id) REFERENCES channel_tasks(company_id,id) ON DELETE RESTRICT
);
ALTER TABLE agent_runs ADD COLUMN task_id TEXT REFERENCES channel_tasks(id) ON DELETE RESTRICT;
ALTER TABLE agent_runs ADD COLUMN task_context_id TEXT REFERENCES task_execution_contexts(id) ON DELETE RESTRICT;

CREATE FUNCTION end_task_binding_on_membership_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN
  UPDATE channel_agent_bindings SET status='ENDED',version=version+1
    WHERE company_id=OLD.company_id AND conversation_id=OLD.conversation_id AND agent_id=OLD.participant_id AND status='ACTIVE';
  RETURN OLD;
END
$body$;
CREATE TRIGGER task_membership_end AFTER DELETE ON conversation_members FOR EACH ROW EXECUTE FUNCTION end_task_binding_on_membership_delete();
CREATE FUNCTION validate_task_hierarchy() RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN
  IF NEW.parent_task_id IS NULL THEN
    IF NEW.root_task_id<>NEW.id THEN RAISE EXCEPTION 'root task must reference itself' USING ERRCODE='23514'; END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM channel_tasks p WHERE p.id=NEW.parent_task_id AND p.company_id=NEW.company_id AND p.conversation_id=NEW.conversation_id AND p.parent_task_id IS NULL AND p.root_task_id=NEW.root_task_id) THEN
      RAISE EXCEPTION 'only same-channel one-level task delegation is allowed' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER task_hierarchy BEFORE INSERT OR UPDATE OF parent_task_id,root_task_id,company_id,conversation_id ON channel_tasks FOR EACH ROW EXECUTE FUNCTION validate_task_hierarchy();
CREATE FUNCTION immutable_task_version() RETURNS TRIGGER LANGUAGE plpgsql AS $body$
BEGIN RAISE EXCEPTION 'task content versions are immutable' USING ERRCODE='23514'; END
$body$;
CREATE TRIGGER artifact_immutable BEFORE UPDATE ON artifact_versions FOR EACH ROW EXECUTE FUNCTION immutable_task_version();
CREATE TRIGGER definition_immutable BEFORE UPDATE ON agent_definition_versions FOR EACH ROW EXECUTE FUNCTION immutable_task_version();
CREATE TRIGGER plan_immutable BEFORE UPDATE ON task_plan_versions FOR EACH ROW EXECUTE FUNCTION immutable_task_version();
CREATE TRIGGER scope_immutable BEFORE UPDATE ON task_scope_revisions FOR EACH ROW EXECUTE FUNCTION immutable_task_version();
`

export function channelTaskExecutionChecksum(): string {
  return createHash('sha256').update(CHANNEL_TASK_EXECUTION_SQL).digest('hex')
}
