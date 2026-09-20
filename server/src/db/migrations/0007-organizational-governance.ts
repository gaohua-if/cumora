import { createHash } from 'node:crypto'

/**
 * Migration 0007: the durable P0 organizational-governance model.
 *
 * Keep authorization-bearing relations normalized. JSONB is reserved for
 * immutable snapshots and bounded lists whose contents are always validated by
 * the command layer before insertion.
 */
export const ORGANIZATIONAL_GOVERNANCE_SQL = `
ALTER TABLE board_cards ADD COLUMN IF NOT EXISTS governance_mode TEXT NOT NULL DEFAULT 'COLLABORATION';
ALTER TABLE board_cards ADD COLUMN IF NOT EXISTS governance_state TEXT;
ALTER TABLE board_cards ADD COLUMN IF NOT EXISTS governance_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE board_cards ADD COLUMN IF NOT EXISTS plan_epoch INTEGER;
ALTER TABLE board_cards ADD COLUMN IF NOT EXISTS accountable_role_id TEXT;
ALTER TABLE board_cards ADD COLUMN IF NOT EXISTS human_sponsor_user_id TEXT;
ALTER TABLE board_cards ADD COLUMN IF NOT EXISTS definition_of_done TEXT;
ALTER TABLE board_cards ADD COLUMN IF NOT EXISTS review_policy JSONB;
ALTER TABLE board_cards ADD COLUMN IF NOT EXISTS budget_account_id TEXT;
ALTER TABLE board_cards ADD COLUMN IF NOT EXISTS governance_deadline TIMESTAMP WITH TIME ZONE;
ALTER TABLE board_cards ADD COLUMN IF NOT EXISTS active_plan_id TEXT;
ALTER TABLE board_cards ADD COLUMN IF NOT EXISTS accepted_submission_id TEXT;
ALTER TABLE board_cards ADD COLUMN IF NOT EXISTS shipping_feature_id TEXT;
ALTER TABLE board_cards ADD COLUMN IF NOT EXISTS delivery_gate TEXT;
ALTER TABLE board_cards ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE board_cards DROP CONSTRAINT IF EXISTS board_cards_governance_mode_check;
ALTER TABLE board_cards ADD CONSTRAINT board_cards_governance_mode_check
  CHECK (governance_mode IN ('COLLABORATION','GOVERNED'));
ALTER TABLE board_cards DROP CONSTRAINT IF EXISTS board_cards_governance_state_check;
ALTER TABLE board_cards ADD CONSTRAINT board_cards_governance_state_check
  CHECK (governance_state IS NULL OR governance_state IN
    ('READY','IN_PROGRESS','IN_REVIEW','PAUSED','DONE','CANCELLED'));
ALTER TABLE board_cards DROP CONSTRAINT IF EXISTS board_cards_governance_shape_check;
ALTER TABLE board_cards ADD CONSTRAINT board_cards_governance_shape_check CHECK (
  (governance_mode = 'COLLABORATION' AND governance_state IS NULL AND plan_epoch IS NULL)
  OR
  (governance_mode = 'GOVERNED' AND governance_state IS NOT NULL AND plan_epoch IS NOT NULL
    AND plan_epoch >= 1 AND accountable_role_id IS NOT NULL
    AND human_sponsor_user_id IS NOT NULL AND definition_of_done IS NOT NULL
    AND review_policy IS NOT NULL AND delivery_gate IN ('CODE_ACCEPTED','PRODUCTION_READBACK'))
);

CREATE TABLE IF NOT EXISTS governance_roles (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  responsibility_scope TEXT NOT NULL DEFAULT '',
  grantable_grants JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMP WITH TIME ZONE,
  UNIQUE (company_id, id),
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS governance_role_assignments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  human_user_id TEXT NOT NULL,
  assignment_type TEXT NOT NULL DEFAULT 'PRIMARY' CHECK (assignment_type IN ('PRIMARY','BACKUP')),
  valid_from TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  valid_until TIMESTAMP WITH TIME ZONE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ENDED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  FOREIGN KEY (company_id, role_id) REFERENCES governance_roles(company_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id, human_user_id) REFERENCES company_members(company_id, user_id) ON DELETE RESTRICT,
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_governance_active_primary
  ON governance_role_assignments(role_id)
  WHERE assignment_type = 'PRIMARY' AND status = 'ACTIVE' AND valid_until IS NULL;
CREATE INDEX IF NOT EXISTS idx_governance_role_assignments_human
  ON governance_role_assignments(company_id, human_user_id, status);

CREATE TABLE IF NOT EXISTS governance_budget_accounts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE RESTRICT,
  parent_account_id TEXT REFERENCES governance_budget_accounts(id) ON DELETE RESTRICT,
  limit_microusd BIGINT NOT NULL CHECK (limit_microusd >= 0),
  spent_microusd BIGINT NOT NULL DEFAULT 0 CHECK (spent_microusd >= 0),
  reserved_microusd BIGINT NOT NULL DEFAULT 0 CHECK (reserved_microusd >= 0),
  model_call_limit INTEGER NOT NULL CHECK (model_call_limit >= 0),
  model_calls_spent INTEGER NOT NULL DEFAULT 0 CHECK (model_calls_spent >= 0),
  model_calls_reserved INTEGER NOT NULL DEFAULT 0 CHECK (model_calls_reserved >= 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','FROZEN','CLOSED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CHECK (spent_microusd + reserved_microusd <= limit_microusd),
  CHECK (model_calls_spent + model_calls_reserved <= model_call_limit),
  UNIQUE (company_id, id)
);

CREATE TABLE IF NOT EXISTS governance_mandates (
  id TEXT NOT NULL,
  mandate_version INTEGER NOT NULL CHECK (mandate_version >= 1),
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE RESTRICT,
  role_id TEXT NOT NULL,
  sponsor_user_id TEXT NOT NULL,
  sponsor_assignment_id TEXT NOT NULL REFERENCES governance_role_assignments(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  grants JSONB NOT NULL,
  data_resource_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  tool_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  budget_account_id TEXT NOT NULL REFERENCES governance_budget_accounts(id) ON DELETE RESTRICT,
  budget_limit_microusd BIGINT NOT NULL CHECK (budget_limit_microusd >= 0),
  model_call_limit INTEGER NOT NULL CHECK (model_call_limit >= 0),
  valid_from TIMESTAMP WITH TIME ZONE NOT NULL,
  valid_until TIMESTAMP WITH TIME ZONE NOT NULL,
  max_delegation_depth INTEGER NOT NULL DEFAULT 0 CHECK (max_delegation_depth BETWEEN 0 AND 1),
  allowed_delegatee_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  autonomy_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','SUSPENDED','REVOKED','EXPIRED')),
  state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version >= 1),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, mandate_version),
  FOREIGN KEY (company_id, role_id) REFERENCES governance_roles(company_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id, sponsor_user_id) REFERENCES company_members(company_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, company_id) REFERENCES participants(id, company_id) ON DELETE RESTRICT,
  CHECK (valid_until > valid_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_governance_active_mandate_version
  ON governance_mandates(id) WHERE status IN ('ACTIVE','SUSPENDED');
CREATE INDEX IF NOT EXISTS idx_governance_mandates_agent_card
  ON governance_mandates(company_id, agent_id, card_id, status);

CREATE TABLE IF NOT EXISTS governance_card_plans (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  epoch INTEGER NOT NULL CHECK (epoch >= 1),
  goal TEXT NOT NULL,
  definition_of_done TEXT NOT NULL,
  input_version_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  action_specs JSONB NOT NULL DEFAULT '[]'::jsonb,
  budget_allocation JSONB NOT NULL DEFAULT '{}'::jsonb,
  deadline TIMESTAMP WITH TIME ZONE,
  risk_summary TEXT NOT NULL DEFAULT '',
  review_policy JSONB NOT NULL,
  shipping_contract_revision INTEGER,
  created_by TEXT NOT NULL,
  approved_by TEXT,
  state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','ACTIVE','SUPERSEDED','REJECTED')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE (card_id, epoch),
  UNIQUE (card_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_governance_active_card_plan
  ON governance_card_plans(card_id) WHERE state = 'ACTIVE';

CREATE TABLE IF NOT EXISTS governance_card_claims (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE RESTRICT,
  holder_type TEXT NOT NULL CHECK (holder_type IN ('HUMAN','AGENT')),
  holder_id TEXT NOT NULL,
  lease_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  released_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_governance_live_card_claim
  ON governance_card_claims(card_id) WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS governance_actions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE RESTRICT,
  plan_epoch INTEGER NOT NULL CHECK (plan_epoch >= 1),
  parent_action_id TEXT REFERENCES governance_actions(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (purpose IN ('PRODUCE','COORDINATE','VERIFY')),
  objective TEXT NOT NULL,
  input_version_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  expected_output TEXT,
  definition_of_done TEXT,
  permission_snapshot JSONB NOT NULL,
  authorization_chain_refs JSONB NOT NULL,
  budget_account_id TEXT NOT NULL REFERENCES governance_budget_accounts(id) ON DELETE RESTRICT,
  deadline TIMESTAMP WITH TIME ZONE,
  remaining_delegation_depth INTEGER NOT NULL DEFAULT 0 CHECK (remaining_delegation_depth BETWEEN 0 AND 1),
  assigned_agent_id TEXT NOT NULL,
  active_attempt_id TEXT,
  state TEXT NOT NULL DEFAULT 'CREATED' CHECK (state IN
    ('CREATED','READY','RUNNING','WAITING_HUMAN','BLOCKED','SUBMITTED','CANCELLING','COMPLETED','CANCELLED','SUPERSEDED','FAILED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  terminal_reason TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  FOREIGN KEY (assigned_agent_id, company_id) REFERENCES participants(id, company_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_governance_actions_card
  ON governance_actions(card_id, plan_epoch, created_at);

CREATE TABLE IF NOT EXISTS governance_action_attempts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  action_id TEXT NOT NULL REFERENCES governance_actions(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  mandate_id TEXT NOT NULL,
  mandate_version INTEGER NOT NULL,
  sponsor_user_id TEXT NOT NULL,
  sponsor_assignment_id TEXT NOT NULL REFERENCES governance_role_assignments(id) ON DELETE RESTRICT,
  runtime_assignment_id TEXT NOT NULL,
  runtime_ref TEXT,
  model_ref TEXT,
  state TEXT NOT NULL DEFAULT 'RUNNING' CHECK (state IN
    ('RUNNING','WAITING_HUMAN','STOPPING','SUCCEEDED','FAILED','LOST','CANCELLED')),
  lease_generation INTEGER NOT NULL DEFAULT 1 CHECK (lease_generation >= 1),
  lease_expires_at TIMESTAMP WITH TIME ZONE,
  last_heartbeat_at TIMESTAMP WITH TIME ZONE,
  checkpoint_ref TEXT,
  result_ref TEXT,
  failure_class TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMP WITH TIME ZONE,
  FOREIGN KEY (mandate_id, mandate_version) REFERENCES governance_mandates(id, mandate_version) ON DELETE RESTRICT,
  FOREIGN KEY (agent_id, company_id) REFERENCES participants(id, company_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_governance_executable_attempt
  ON governance_action_attempts(action_id)
  WHERE state IN ('RUNNING','WAITING_HUMAN','STOPPING');

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS governance_attempt_id TEXT REFERENCES governance_action_attempts(id) ON DELETE SET NULL;
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS governance_attempt_id TEXT REFERENCES governance_action_attempts(id) ON DELETE SET NULL;
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS governance_attempt_id TEXT REFERENCES governance_action_attempts(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS governance_budget_reservations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  parent_account_id TEXT NOT NULL REFERENCES governance_budget_accounts(id) ON DELETE RESTRICT,
  child_account_id TEXT REFERENCES governance_budget_accounts(id) ON DELETE RESTRICT,
  action_id TEXT REFERENCES governance_actions(id) ON DELETE RESTRICT,
  operation_id TEXT,
  amount_microusd BIGINT NOT NULL CHECK (amount_microusd >= 0),
  model_calls INTEGER NOT NULL DEFAULT 0 CHECK (model_calls >= 0),
  state TEXT NOT NULL DEFAULT 'RESERVED' CHECK (state IN ('RESERVED','CONSUMED','RELEASED')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS governance_operations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE RESTRICT,
  action_id TEXT REFERENCES governance_actions(id) ON DELETE RESTRICT,
  attempt_id TEXT REFERENCES governance_action_attempts(id) ON DELETE RESTRICT,
  plan_epoch INTEGER NOT NULL,
  operation_type TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PREPARED' CHECK (state IN
    ('PREPARED','DISPATCHED','SUCCEEDED','FAILED','UNKNOWN','CANCELLED')),
  provider_receipt JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, action_id, operation_type, idempotency_key)
);

CREATE TABLE IF NOT EXISTS governance_approvals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE RESTRICT,
  action_id TEXT REFERENCES governance_actions(id) ON DELETE RESTRICT,
  plan_epoch INTEGER NOT NULL,
  mandate_id TEXT,
  mandate_version INTEGER,
  operation_type TEXT NOT NULL,
  normalized_request_hash TEXT NOT NULL,
  resource_version_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  policy_version INTEGER NOT NULL,
  designated_approver_role_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  decided_by TEXT,
  decided_assignment_id TEXT REFERENCES governance_role_assignments(id) ON DELETE RESTRICT,
  decided_at TIMESTAMP WITH TIME ZONE,
  decision_comment TEXT,
  consumed_by_operation_id TEXT REFERENCES governance_operations(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN
    ('PENDING','APPROVED','REJECTED','EXPIRED','INVALIDATED','CONSUMED')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS governance_interventions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE RESTRICT,
  action_id TEXT REFERENCES governance_actions(id) ON DELETE RESTRICT,
  plan_epoch INTEGER NOT NULL,
  request_type TEXT NOT NULL CHECK (request_type IN
    ('CLARIFICATION','PLAN_REVIEW','PERMISSION','APPROVAL','ARTIFACT_REVIEW','ARBITRATION','TAKEOVER')),
  requested_by TEXT NOT NULL,
  responsible_role_id TEXT NOT NULL,
  designated_user_id TEXT,
  context_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  proposed_action JSONB,
  risks JSONB NOT NULL DEFAULT '[]'::jsonb,
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  timeout_behavior TEXT NOT NULL DEFAULT 'REJECT',
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  approval_id TEXT REFERENCES governance_approvals(id) ON DELETE RESTRICT,
  submission_id TEXT,
  resume_token_hash TEXT,
  resolved_by TEXT,
  resolved_at TIMESTAMP WITH TIME ZONE,
  resolution JSONB,
  state TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','RESOLVED','REJECTED','EXPIRED','INVALIDATED')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS governance_artifact_versions (
  version_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE RESTRICT,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  hash_algorithm TEXT NOT NULL DEFAULT 'SHA256' CHECK (hash_algorithm = 'SHA256'),
  media_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
  storage_object_id TEXT,
  storage_version TEXT,
  external_source_ref JSONB,
  producer_principal_ids JSONB NOT NULL,
  source_action_id TEXT REFERENCES governance_actions(id) ON DELETE RESTRICT,
  source_attempt_id TEXT REFERENCES governance_action_attempts(id) ON DELETE RESTRICT,
  source_human_operation_id TEXT,
  input_version_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_version_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  derived_from_version_id TEXT REFERENCES governance_artifact_versions(version_id) ON DELETE RESTRICT,
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  allowed_reader_scope JSONB NOT NULL DEFAULT '[]'::jsonb,
  retention_until TIMESTAMP WITH TIME ZONE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('EVIDENCE','DELIVERABLE')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE (artifact_id, content_hash),
  CHECK (storage_object_id IS NOT NULL OR external_source_ref IS NOT NULL),
  CHECK (source_action_id IS NOT NULL OR source_human_operation_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_governance_artifacts_card
  ON governance_artifact_versions(card_id, created_at DESC);

CREATE TABLE IF NOT EXISTS governance_submissions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE RESTRICT,
  action_id TEXT REFERENCES governance_actions(id) ON DELETE RESTRICT,
  human_operation_id TEXT,
  plan_epoch INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  version INTEGER NOT NULL DEFAULT 1,
  artifact_version_refs JSONB NOT NULL,
  evidence_version_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  producer_principal_ids JSONB NOT NULL,
  definition_of_done_snapshot TEXT NOT NULL,
  review_policy_snapshot JSONB NOT NULL,
  shipping_contract_revision INTEGER,
  completion_summary TEXT NOT NULL,
  known_limitations JSONB NOT NULL DEFAULT '[]'::jsonb,
  unresolved_risks JSONB NOT NULL DEFAULT '[]'::jsonb,
  submitted_by TEXT NOT NULL,
  submitted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  state TEXT NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (state IN
    ('PENDING_REVIEW','ACCEPTED','CHANGES_REQUESTED','REJECTED','SUPERSEDED')),
  UNIQUE (card_id, plan_epoch, revision),
  CHECK ((action_id IS NOT NULL) <> (human_operation_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_governance_pending_submission
  ON governance_submissions(card_id, plan_epoch) WHERE state = 'PENDING_REVIEW';

CREATE TABLE IF NOT EXISTS governance_reviews (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  submission_id TEXT NOT NULL REFERENCES governance_submissions(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN ('INDEPENDENT_CHECK','FINAL_ACCEPTANCE')),
  decision TEXT NOT NULL CHECK (decision IN ('ACCEPT','REQUEST_CHANGES','REJECT')),
  reviewer_type TEXT NOT NULL CHECK (reviewer_type IN ('HUMAN','AGENT')),
  reviewer_id TEXT NOT NULL,
  basis_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  plan_epoch INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE (submission_id, stage, reviewer_type, reviewer_id)
);

CREATE TABLE IF NOT EXISTS governance_manifests (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  card_id TEXT NOT NULL REFERENCES board_cards(id) ON DELETE RESTRICT,
  plan_epoch INTEGER NOT NULL,
  submission_id TEXT NOT NULL REFERENCES governance_submissions(id) ON DELETE RESTRICT,
  payload JSONB NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE (card_id, plan_epoch)
);

CREATE TABLE IF NOT EXISTS governance_events (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('HUMAN','AGENT','SERVICE')),
  actor_id TEXT NOT NULL,
  acting_role_id TEXT,
  sponsor_user_id TEXT,
  sponsor_assignment_id TEXT,
  mandate_id TEXT,
  mandate_version INTEGER,
  card_id TEXT,
  action_id TEXT,
  attempt_id TEXT,
  plan_epoch INTEGER,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  idempotency_key TEXT,
  security_label TEXT NOT NULL DEFAULT 'INTERNAL',
  occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (aggregate_type, aggregate_id, aggregate_version, event_type)
);
CREATE INDEX IF NOT EXISTS idx_governance_events_card
  ON governance_events(company_id, card_id, occurred_at, id);

CREATE TABLE IF NOT EXISTS governance_idempotency (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('HUMAN','AGENT','SERVICE')),
  actor_id TEXT NOT NULL,
  command_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result JSONB NOT NULL,
  event_id TEXT REFERENCES governance_events(id) ON DELETE RESTRICT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, actor_type, actor_id, command_name, idempotency_key)
);

ALTER TABLE shipping_features ADD COLUMN IF NOT EXISTS contract_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE shipping_features ADD COLUMN IF NOT EXISTS governance_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shipping_verifications ADD COLUMN IF NOT EXISTS latest_result_id TEXT;
ALTER TABLE shipping_releases ADD COLUMN IF NOT EXISTS artifact_version_refs JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE shipping_releases ADD COLUMN IF NOT EXISTS contract_revision INTEGER;

CREATE TABLE IF NOT EXISTS shipping_verification_results (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  feature_id TEXT NOT NULL REFERENCES shipping_features(id) ON DELETE RESTRICT,
  verification_id TEXT NOT NULL REFERENCES shipping_verifications(id) ON DELETE RESTRICT,
  verification_attempt_id TEXT NOT NULL,
  contract_revision INTEGER NOT NULL CHECK (contract_revision >= 1),
  card_id TEXT REFERENCES board_cards(id) ON DELETE RESTRICT,
  plan_epoch INTEGER,
  artifact_version_refs JSONB NOT NULL,
  candidate_hash TEXT NOT NULL,
  verifier_id TEXT NOT NULL,
  producer_builder_snapshot JSONB NOT NULL,
  evidence_version_refs JSONB NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('PASSED','FAILED','WAIVED')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE (verification_id, verification_attempt_id)
);

ALTER TABLE shipping_verifications DROP CONSTRAINT IF EXISTS shipping_verifications_latest_result_fk;
ALTER TABLE shipping_verifications ADD CONSTRAINT shipping_verifications_latest_result_fk
  FOREIGN KEY (latest_result_id) REFERENCES shipping_verification_results(id) ON DELETE RESTRICT;

ALTER TABLE board_cards DROP CONSTRAINT IF EXISTS board_cards_accountable_role_fk;
ALTER TABLE board_cards ADD CONSTRAINT board_cards_accountable_role_fk
  FOREIGN KEY (accountable_role_id) REFERENCES governance_roles(id) ON DELETE RESTRICT;
ALTER TABLE board_cards DROP CONSTRAINT IF EXISTS board_cards_budget_account_fk;
ALTER TABLE board_cards ADD CONSTRAINT board_cards_budget_account_fk
  FOREIGN KEY (budget_account_id) REFERENCES governance_budget_accounts(id) ON DELETE RESTRICT;
ALTER TABLE board_cards DROP CONSTRAINT IF EXISTS board_cards_active_plan_fk;
ALTER TABLE board_cards ADD CONSTRAINT board_cards_active_plan_fk
  FOREIGN KEY (active_plan_id) REFERENCES governance_card_plans(id) ON DELETE RESTRICT;
ALTER TABLE board_cards DROP CONSTRAINT IF EXISTS board_cards_accepted_submission_fk;
ALTER TABLE board_cards ADD CONSTRAINT board_cards_accepted_submission_fk
  FOREIGN KEY (accepted_submission_id) REFERENCES governance_submissions(id) ON DELETE RESTRICT;
ALTER TABLE board_cards DROP CONSTRAINT IF EXISTS board_cards_shipping_feature_fk;
ALTER TABLE board_cards ADD CONSTRAINT board_cards_shipping_feature_fk
  FOREIGN KEY (shipping_feature_id) REFERENCES shipping_features(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_governed_card_shipping_feature
  ON board_cards(shipping_feature_id) WHERE shipping_feature_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_board_cards_governance
  ON board_cards(board_id, governance_mode, governance_state, updated_at DESC);

CREATE OR REPLACE FUNCTION reject_governance_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'governance events are append-only';
END;
$$;
DROP TRIGGER IF EXISTS governance_events_append_only ON governance_events;
CREATE TRIGGER governance_events_append_only
  BEFORE UPDATE OR DELETE ON governance_events
  FOR EACH ROW EXECUTE FUNCTION reject_governance_event_mutation();
`

export function organizationalGovernanceChecksum(): string {
  return createHash('sha256').update(ORGANIZATIONAL_GOVERNANCE_SQL).digest('hex')
}
