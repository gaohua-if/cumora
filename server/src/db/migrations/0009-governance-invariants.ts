import { createHash } from 'node:crypto'

export const GOVERNANCE_INVARIANTS_SQL = `
CREATE OR REPLACE FUNCTION enforce_governance_primary_term() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assignment_type <> 'PRIMARY' OR NEW.status <> 'ACTIVE' THEN RETURN NEW; END IF;
  PERFORM 1 FROM governance_roles WHERE company_id=NEW.company_id AND id=NEW.role_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM governance_role_assignments a
    WHERE a.company_id=NEW.company_id AND a.role_id=NEW.role_id
      AND a.assignment_type='PRIMARY' AND a.status='ACTIVE' AND a.id<>NEW.id
      AND tstzrange(a.valid_from,COALESCE(a.valid_until,'infinity'::timestamptz),'[)')
          && tstzrange(NEW.valid_from,COALESCE(NEW.valid_until,'infinity'::timestamptz),'[)')
  ) THEN RAISE EXCEPTION 'overlapping Primary assignment' USING ERRCODE='23P01'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS governance_primary_term_guard ON governance_role_assignments;
CREATE TRIGGER governance_primary_term_guard BEFORE INSERT OR UPDATE OF role_id,assignment_type,status,valid_from,valid_until
  ON governance_role_assignments FOR EACH ROW EXECUTE FUNCTION enforce_governance_primary_term();

ALTER TABLE governance_actions DROP CONSTRAINT IF EXISTS governance_actions_active_attempt_fk;
ALTER TABLE governance_actions ADD CONSTRAINT governance_actions_active_attempt_fk
  FOREIGN KEY (active_attempt_id) REFERENCES governance_action_attempts(id) ON DELETE RESTRICT;
ALTER TABLE governance_budget_reservations DROP CONSTRAINT IF EXISTS governance_budget_reservation_operation_fk;
ALTER TABLE governance_budget_reservations ADD CONSTRAINT governance_budget_reservation_operation_fk
  FOREIGN KEY (operation_id) REFERENCES governance_operations(id) ON DELETE RESTRICT;
ALTER TABLE governance_interventions DROP CONSTRAINT IF EXISTS governance_intervention_submission_fk;
ALTER TABLE governance_interventions ADD CONSTRAINT governance_intervention_submission_fk
  FOREIGN KEY (submission_id) REFERENCES governance_submissions(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_governance_final_acceptance
  ON governance_reviews(submission_id) WHERE stage='FINAL_ACCEPTANCE' AND decision='ACCEPT';

CREATE OR REPLACE FUNCTION reject_immutable_governance_record_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'governance record is immutable'; END; $$;
DROP TRIGGER IF EXISTS governance_artifacts_immutable ON governance_artifact_versions;
CREATE TRIGGER governance_artifacts_immutable BEFORE UPDATE OR DELETE ON governance_artifact_versions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_governance_record_mutation();
DROP TRIGGER IF EXISTS governance_reviews_immutable ON governance_reviews;
CREATE TRIGGER governance_reviews_immutable BEFORE UPDATE OR DELETE ON governance_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_governance_record_mutation();
DROP TRIGGER IF EXISTS governance_manifests_immutable ON governance_manifests;
CREATE TRIGGER governance_manifests_immutable BEFORE UPDATE OR DELETE ON governance_manifests
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_governance_record_mutation();
DROP TRIGGER IF EXISTS shipping_verification_results_immutable ON shipping_verification_results;
CREATE TRIGGER shipping_verification_results_immutable BEFORE UPDATE OR DELETE ON shipping_verification_results
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_governance_record_mutation();
`

export function governanceInvariantsChecksum(): string {
  return createHash('sha256').update(GOVERNANCE_INVARIANTS_SQL).digest('hex')
}
