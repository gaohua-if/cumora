import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { priceFor, type TokenUsage } from '../agents/cost.js'

export class GovernanceBudgetError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

async function audit(client: import('pg').PoolClient, row: any, eventType: string, payload: unknown): Promise<void> {
  const reservationId = (payload as { reservationId?: string })?.reservationId ?? row.reservation_id
  const aggregateVersion = eventType === 'MODEL_CALL_AUTHORIZED' ? 1 : 2
  await client.query(`INSERT INTO governance_events
    (id,company_id,aggregate_type,aggregate_id,aggregate_version,event_type,actor_type,actor_id,sponsor_user_id,sponsor_assignment_id,mandate_id,mandate_version,card_id,action_id,attempt_id,plan_epoch,correlation_id,payload)
    VALUES ($1,$2,'BUDGET_RESERVATION',$3,$4,$5,'AGENT',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
  [`gev-${randomUUID()}`, row.company_id, reservationId, aggregateVersion, eventType, row.agent_id, row.sponsor_user_id, row.sponsor_assignment_id, row.mandate_id, row.mandate_version, row.card_id, row.action_id, row.attempt_id, row.plan_epoch, randomUUID(), JSON.stringify(payload)])
}

export async function authorizeGovernedModelCall(pool: Pool, args: {
  runId: string; agentId: string; companyId: string; providerCallId: string; model: string; maxInputTokens: number; maxOutputTokens: number
}): Promise<{ reservationId: string; amountMicrousd: number } | null> {
  const rate = priceFor(args.model)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const row = (await client.query<any>(`SELECT r.governance_attempt_id,at.id AS attempt_id,at.agent_id,at.state AS attempt_state,at.lease_expires_at,at.lease_generation,at.mandate_id,at.mandate_version,at.sponsor_user_id,at.sponsor_assignment_id,
      a.id AS action_id,a.version AS action_version,a.card_id,a.plan_epoch,a.budget_account_id,c.plan_epoch AS current_epoch,c.governance_state,m.status AS mandate_status,m.valid_until,
      EXISTS (SELECT 1 FROM governance_role_assignments ra JOIN company_members cm ON cm.company_id=ra.company_id AND cm.user_id=ra.human_user_id WHERE ra.id=m.sponsor_assignment_id AND ra.status='ACTIVE' AND ra.assignment_type='PRIMARY' AND ra.valid_from<=NOW() AND (ra.valid_until IS NULL OR ra.valid_until>NOW())) AS sponsor_valid,b.*
      FROM agent_runs r JOIN governance_action_attempts at ON at.id=r.governance_attempt_id JOIN governance_actions a ON a.id=at.action_id
      JOIN board_cards c ON c.id=a.card_id JOIN governance_mandates m ON m.id=at.mandate_id AND m.mandate_version=at.mandate_version
      JOIN governance_budget_accounts b ON b.id=a.budget_account_id
      WHERE r.id=$1 AND r.agent_id=$2 AND r.company_id=$3 FOR UPDATE OF at,a,c,m,b`, [args.runId, args.agentId, args.companyId])).rows[0]
    if (!row) { await client.query('COMMIT'); return null }
    if (rate.verified !== true) throw new GovernanceBudgetError('UNVERIFIED_MODEL_RATE', 'governed model calls require an operator-supplied model rate')
    if (!['RUNNING', 'WAITING_HUMAN'].includes(row.attempt_state) || (row.lease_expires_at && new Date(row.lease_expires_at) <= new Date()) || row.plan_epoch !== row.current_epoch || ['PAUSED', 'CANCELLED', 'DONE'].includes(row.governance_state) || row.mandate_status !== 'ACTIVE' || new Date(row.valid_until) <= new Date() || !row.sponsor_valid) throw new GovernanceBudgetError('LEASE_INVALID', 'governance attempt is stale or no longer executable')
    if (row.status !== 'ACTIVE') throw new GovernanceBudgetError('BUDGET_UNAVAILABLE', 'governance budget is not active')
    const inputRate = Math.max(rate.inPer1M, rate.cachedInPer1M, rate.cacheWritePer1M)
    const amount = Math.ceil(args.maxInputTokens * inputRate + args.maxOutputTokens * rate.outPer1M)
    if (!Number.isSafeInteger(amount) || amount < 0) throw new GovernanceBudgetError('INVALID_COST', 'model-call upper bound is invalid')
    const duplicate = (await client.query<any>('SELECT * FROM governance_budget_reservations WHERE company_id=$1 AND provider_call_id=$2 FOR UPDATE', [args.companyId, args.providerCallId])).rows[0]
    if (duplicate) { await client.query('COMMIT'); return { reservationId: duplicate.id, amountMicrousd: Number(duplicate.amount_microusd) } }
    if (BigInt(row.spent_microusd) + BigInt(row.reserved_microusd) + BigInt(amount) > BigInt(row.limit_microusd) || Number(row.model_calls_spent) + Number(row.model_calls_reserved) + 1 > Number(row.model_call_limit)) throw new GovernanceBudgetError('BUDGET_EXCEEDED', 'governance hard budget exhausted')
    const reservationId = `bres-${randomUUID().slice(0, 12)}`
    const snapshot = { model: args.model, maxInputTokens: args.maxInputTokens, maxOutputTokens: args.maxOutputTokens, ...rate }
    await client.query(`INSERT INTO governance_budget_reservations (id,company_id,parent_account_id,action_id,amount_microusd,model_calls,provider_call_id,model_ref,rate_snapshot) VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8::jsonb)`, [reservationId, args.companyId, row.budget_account_id, row.action_id, amount, args.providerCallId, args.model, JSON.stringify(snapshot)])
    await client.query('UPDATE governance_budget_accounts SET reserved_microusd=reserved_microusd+$1,model_calls_reserved=model_calls_reserved+1,version=version+1,updated_at=NOW() WHERE id=$2', [amount, row.budget_account_id])
    await audit(client, row, 'MODEL_CALL_AUTHORIZED', { reservationId, providerCallId: args.providerCallId, model: args.model, amountMicrousd: amount })
    await client.query('COMMIT'); return { reservationId, amountMicrousd: amount }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}

export async function settleGovernedModelCall(pool: Pool, args: {
  runId: string; agentId: string; companyId: string; providerCallId: string; usage: TokenUsage
}): Promise<{ actualAmountMicrousd: number; budgetFrozen: boolean } | null> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const row = (await client.query<any>(`SELECT r.id AS reservation_id,r.state AS reservation_state,r.amount_microusd,r.actual_amount_microusd,r.rate_snapshot,
      at.id AS attempt_id,at.agent_id,at.mandate_id,at.mandate_version,at.sponsor_user_id,at.sponsor_assignment_id,a.id AS action_id,a.version AS action_version,a.card_id,a.plan_epoch,a.budget_account_id,b.*,ar.id AS run_id
      FROM agent_runs ar JOIN governance_action_attempts at ON at.id=ar.governance_attempt_id JOIN governance_actions a ON a.id=at.action_id
      JOIN governance_budget_reservations r ON r.action_id=a.id AND r.provider_call_id=$4 JOIN governance_budget_accounts b ON b.id=r.parent_account_id
      WHERE ar.id=$1 AND ar.agent_id=$2 AND ar.company_id=$3 FOR UPDATE OF r,b`, [args.runId, args.agentId, args.companyId, args.providerCallId])).rows[0]
    if (!row) { await client.query('COMMIT'); return null }
    const rate = row.rate_snapshot as { inPer1M: number; cachedInPer1M: number; cacheWritePer1M: number; outPer1M: number }
    const actual = Math.ceil(args.usage.inputTokens * rate.inPer1M + args.usage.cachedInputTokens * rate.cachedInPer1M + args.usage.cacheCreationTokens * rate.cacheWritePer1M + args.usage.outputTokens * rate.outPer1M)
    if (row.reservation_state === 'CONSUMED') { await client.query('COMMIT'); return { actualAmountMicrousd: Number(row.actual_amount_microusd), budgetFrozen: row.status === 'FROZEN' } }
    const freeze = BigInt(row.spent_microusd) + BigInt(actual) > BigInt(row.limit_microusd) || Number(row.model_calls_spent) + 1 > Number(row.model_call_limit) || actual > Number(row.amount_microusd)
    await client.query(`UPDATE governance_budget_reservations SET state='CONSUMED',actual_amount_microusd=$1,usage_call_id=$2,settled_at=NOW() WHERE id=$3`, [actual, args.providerCallId, row.reservation_id])
    await client.query(`UPDATE governance_budget_accounts SET reserved_microusd=reserved_microusd-$1,model_calls_reserved=model_calls_reserved-1,spent_microusd=spent_microusd+$2,model_calls_spent=model_calls_spent+1,status=CASE WHEN $3 THEN 'FROZEN' ELSE status END,version=version+1,updated_at=NOW() WHERE id=$4`, [row.amount_microusd, actual, freeze, row.budget_account_id])
    await audit(client, row, freeze ? 'MODEL_CALL_SETTLED_AND_FROZEN' : 'MODEL_CALL_SETTLED', { reservationId: row.reservation_id, providerCallId: args.providerCallId, actualAmountMicrousd: actual, freeze })
    await client.query('COMMIT'); return { actualAmountMicrousd: actual, budgetFrozen: freeze }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
}
