import { createHash } from 'node:crypto'

export const GOVERNANCE_BUDGET_SETTLEMENT_SQL = `
ALTER TABLE governance_budget_accounts
  DROP CONSTRAINT IF EXISTS governance_budget_accounts_check;
ALTER TABLE governance_budget_accounts
  DROP CONSTRAINT IF EXISTS governance_budget_accounts_check1;

ALTER TABLE governance_budget_reservations
  ADD COLUMN IF NOT EXISTS provider_call_id TEXT,
  ADD COLUMN IF NOT EXISTS model_ref TEXT,
  ADD COLUMN IF NOT EXISTS rate_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS actual_amount_microusd BIGINT,
  ADD COLUMN IF NOT EXISTS usage_call_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_governance_budget_provider_call
  ON governance_budget_reservations(company_id, provider_call_id)
  WHERE provider_call_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_governance_budget_usage_call
  ON governance_budget_reservations(usage_call_id)
  WHERE usage_call_id IS NOT NULL;

ALTER TABLE governance_budget_reservations
  DROP CONSTRAINT IF EXISTS governance_budget_actual_nonnegative;
ALTER TABLE governance_budget_reservations
  ADD CONSTRAINT governance_budget_actual_nonnegative
  CHECK (actual_amount_microusd IS NULL OR actual_amount_microusd >= 0);
`

export function governanceBudgetSettlementChecksum(): string {
  return createHash('sha256').update(GOVERNANCE_BUDGET_SETTLEMENT_SQL).digest('hex')
}
