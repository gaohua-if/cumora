import { createHash } from 'node:crypto'

export const GOVERNANCE_MEMBERSHIP_HISTORY_SQL = `
ALTER TABLE governance_role_assignments
  DROP CONSTRAINT IF EXISTS governance_role_assignments_company_id_human_user_id_fkey;
ALTER TABLE governance_mandates
  DROP CONSTRAINT IF EXISTS governance_mandates_company_id_sponsor_user_id_fkey;

CREATE OR REPLACE FUNCTION validate_governance_human_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'governance_role_assignments' THEN
    IF NOT EXISTS (SELECT 1 FROM company_members WHERE company_id=NEW.company_id AND user_id=NEW.human_user_id) THEN
      RAISE EXCEPTION 'role assignee must be a current workspace member' USING ERRCODE='23503';
    END IF;
  ELSIF TG_TABLE_NAME = 'governance_mandates' THEN
    IF NOT EXISTS (SELECT 1 FROM company_members WHERE company_id=NEW.company_id AND user_id=NEW.sponsor_user_id) THEN
      RAISE EXCEPTION 'mandate sponsor must be a current workspace member' USING ERRCODE='23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS governance_role_assignment_member_guard ON governance_role_assignments;
CREATE TRIGGER governance_role_assignment_member_guard
  BEFORE INSERT OR UPDATE OF company_id,human_user_id ON governance_role_assignments
  FOR EACH ROW EXECUTE FUNCTION validate_governance_human_membership();
DROP TRIGGER IF EXISTS governance_mandate_sponsor_member_guard ON governance_mandates;
CREATE TRIGGER governance_mandate_sponsor_member_guard
  BEFORE INSERT OR UPDATE OF company_id,sponsor_user_id ON governance_mandates
  FOR EACH ROW EXECUTE FUNCTION validate_governance_human_membership();
`

export function governanceMembershipHistoryChecksum(): string {
  return createHash('sha256').update(GOVERNANCE_MEMBERSHIP_HISTORY_SQL).digest('hex')
}
