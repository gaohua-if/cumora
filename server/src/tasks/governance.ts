import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { TaskError } from './contracts.js'
import type { TaskRecord, BindingRecord } from './service.js'
import { authorizeGovernedModelCall, settleGovernedModelCall } from '../governance/runtime-budget.js'
import { usageFromOpenAI } from '../agents/cost.js'

/** Task grants augment, and never replace, the existing governance authority. */
export async function checkTaskGovernance(client: PoolClient, task: TaskRecord, binding: BindingRecord): Promise<void> {
  if (!task.board_card_id && !task.governance_action_id && !task.governance_attempt_id) return
  if(task.board_card_id && !task.governance_action_id && !task.governance_attempt_id){
    const ordinary=await client.query(`SELECT 1 FROM board_cards c JOIN boards b ON b.id=c.board_id WHERE c.id=$1 AND b.company_id=$2 AND c.governance_mode='COLLABORATION' FOR SHARE OF c,b`,[task.board_card_id,task.company_id])
    if(ordinary.rowCount)return
  }
  if (!task.board_card_id || !task.governance_action_id || !task.governance_attempt_id) throw new TaskError('GOVERNANCE_MAPPING_REQUIRED', 403)
  const result = await client.query(`SELECT 1 FROM governance_action_attempts at
    JOIN governance_actions a ON a.id=at.action_id AND a.company_id=at.company_id
    JOIN board_cards c ON c.id=a.card_id
    JOIN boards board ON board.id=c.board_id AND board.company_id=a.company_id
    JOIN governance_mandates m ON m.id=at.mandate_id AND m.mandate_version=at.mandate_version AND m.company_id=at.company_id
    JOIN governance_role_assignments ra ON ra.id=at.sponsor_assignment_id AND ra.company_id=at.company_id AND ra.human_user_id=at.sponsor_user_id
    JOIN company_members cm ON cm.company_id=ra.company_id AND cm.user_id=ra.human_user_id
    JOIN governance_budget_accounts b ON b.id=a.budget_account_id AND b.company_id=a.company_id
    WHERE at.company_id=$1 AND at.id=$2 AND a.id=$3 AND c.id=$4 AND at.agent_id=$5 AND a.assigned_agent_id=$5
      AND at.runtime_assignment_id=$6 AND a.active_attempt_id=at.id AND a.plan_epoch=c.plan_epoch
      AND at.state IN('RUNNING','WAITING_HUMAN') AND (at.lease_expires_at IS NULL OR at.lease_expires_at>NOW())
      AND a.state IN('RUNNING','WAITING_HUMAN') AND c.governance_state NOT IN('PAUSED','CANCELLED','DONE')
      AND m.valid_from<=NOW() AND ($7::boolean OR at.sponsor_user_id=$8) AND m.status='ACTIVE' AND m.valid_until>NOW() AND ra.status='ACTIVE' AND ra.assignment_type='PRIMARY'
      AND ra.valid_from<=NOW() AND (ra.valid_until IS NULL OR ra.valid_until>NOW()) AND b.status='ACTIVE'
    FOR SHARE OF at,a,c,m,ra,cm,b`, [task.company_id, task.governance_attempt_id, task.governance_action_id, task.board_card_id, binding.agent_id, binding.runtime_assignment_id,!!task.parent_task_id,task.creator_principal_id])
  if (!result.rowCount) throw new TaskError('GOVERNANCE_AUTHORITY_REVOKED', 403)
}

export async function governedTaskModelCall<T extends { usage?: unknown }>(pool: Pool, task: TaskRecord, agentId: string, runId: string,
  model: string, request: unknown, invoke: () => Promise<T>): Promise<T> {
  const callId = randomUUID()
  if (task.governance_attempt_id) {
    const reserved = await authorizeGovernedModelCall(pool, { runId, agentId, companyId: task.company_id, providerCallId: callId,
      model, maxInputTokens: Buffer.byteLength(JSON.stringify(request)) + 4096, maxOutputTokens: 16000 })
    if (!reserved) throw new TaskError('GOVERNANCE_MAPPING_REQUIRED', 403)
  }
  // A failed/unknown provider call keeps its reservation; it cannot be silently replayed.
  const response = await invoke()
  if(task.governance_attempt_id && !response.usage) throw new TaskError('PROVIDER_USAGE_UNKNOWN')
  if (task.governance_attempt_id) await settleGovernedModelCall(pool, { runId, agentId, companyId: task.company_id,
    providerCallId: callId, usage: usageFromOpenAI(response.usage) })
  return response
}
