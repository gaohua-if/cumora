import { createHash } from 'node:crypto'

export const GOVERNANCE_IDEMPOTENCY_SQL = `
ALTER TABLE governance_approvals ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
UPDATE governance_approvals SET idempotency_key = id WHERE idempotency_key IS NULL;
ALTER TABLE governance_approvals ALTER COLUMN idempotency_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_governance_approval_idempotency
  ON governance_approvals(company_id, requested_by, operation_type, idempotency_key);
`

export function governanceIdempotencyChecksum(): string {
  return createHash('sha256').update(GOVERNANCE_IDEMPOTENCY_SQL).digest('hex')
}
