import { randomUUID } from 'node:crypto'
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses.js'
import { enforceModelPolicy, realTaskModel } from '../agents/model-policy.js'
import { recordLlmCallsBatch, type LlmCallStatus } from '../agents/llm-ledger.js'
import { usageFromOpenAI } from '../agents/cost.js'
import { authorizeGovernedModelCall, settleGovernedModelCall } from '../governance/runtime-budget.js'
import { TaskError, hashContent, canonicalJson, taskLocalToolsAllowed } from './contracts.js'
import { TaskExecutionService, type Claim, type ResolvedTask } from './execution.js'
import type { TaskService } from './service.js'
import { listAgentsForComputer } from '../agents/computer/registry.js'
import { env } from '../env.js'

/** Both runtime context and authorized requests resolve the same local model.
 * Account credentials stay entirely on the paired computer. */
export async function taskRuntimeModel(tasks: TaskService, context: ResolvedTask, contextId: string): Promise<string> {
  const result = await tasks.pool.query(`SELECT x.computer_id,a.capabilities->>'modelProvider' AS provider
    FROM task_execution_contexts x LEFT JOIN task_runtime_admissions a ON a.company_id=x.company_id
      AND a.computer_id=x.computer_id AND a.engine='codex' AND a.revoked_at IS NULL
    WHERE x.company_id=$1 AND x.id=$2 AND x.binding_id=$3 AND x.revoked_at IS NULL`, [context.task.company_id, contextId, context.bindingId])
  const local = result.rows[0]
  if (local?.provider === 'codex-login') {
    const agent = (await listAgentsForComputer(local.computer_id)).find((a) => a.id === context.agentId)
    if (!agent?.model) throw new TaskError('LOCAL_MODEL_NOT_CONFIGURED')
    return enforceModelPolicy(agent.model, 'agent-turn')
  }
  if (env.LOCAL_ONLY) throw new TaskError('SERVER_MODEL_UNAVAILABLE', 503)
  return enforceModelPolicy(realTaskModel(), 'agent-turn')
}

export function localModelRequest(context: ResolvedTask, value: unknown, model = enforceModelPolicy(realTaskModel(), 'agent-turn')): ResponseCreateParamsNonStreaming {
  const request = value as Record<string, unknown> | null
  if (!request || typeof request !== 'object' || !Array.isArray(request.input) || Buffer.byteLength(JSON.stringify(request)) > 2_000_000) throw new TaskError('RUNTIME_MODEL_INPUT_DENIED', 403)
  if (request.previous_response_id != null && request.previous_response_id !== '') throw new TaskError('RUNTIME_PREVIOUS_RESPONSE_DENIED', 403)
  if (request.tools !== undefined && !taskLocalToolsAllowed(request.tools)) throw new TaskError('RUNTIME_MODEL_TOOL_DENIED', 403)
  return { model: enforceModelPolicy(model, 'agent-turn'), stream: false, store: false,
    input: request.input as ResponseCreateParamsNonStreaming['input'], tools: request.tools as ResponseCreateParamsNonStreaming['tools'],
    instructions: `${context.instructions}\nExecute only task ${context.task.id}: ${context.task.objective}\n${typeof request.instructions === 'string' ? request.instructions : ''}`,
    max_output_tokens: 16000 }
}

/** A durable, single-use permit. Provider credentials never reach this server. */
export async function authorizeLocalModel(tasks: TaskService, companyId: string, agentId: string, claim: Claim, value: unknown) {
  const execution = new TaskExecutionService(tasks)
  const context = await execution.context(companyId, claim)
  const request = localModelRequest(context, value)
  request.model = await taskRuntimeModel(tasks, context, claim.contextId)
  const id = randomUUID()
  const runId = `task-local:${claim.id}`
  await tasks.transaction(companyId, async client => {
    await execution.resolve(client, companyId, claim)
    const admitted = await client.query(`SELECT 1 FROM task_execution_contexts x JOIN task_runtime_admissions a ON a.company_id=x.company_id AND a.computer_id=x.computer_id AND a.engine='codex'
      WHERE x.company_id=$1 AND x.id=$2 AND a.revoked_at IS NULL AND a.capabilities->>'modelProvider'='codex-login'`, [companyId, claim.contextId])
    if (!admitted.rowCount) throw new TaskError('LOCAL_MODEL_PROVIDER_NOT_ADMITTED', 403)
    await client.query(`INSERT INTO agent_runs(id,agent_id,company_id,task_id,task_context_id,trigger,status,governance_attempt_id) VALUES($1,$2,$3,$4,$5,$6,'running',$7) ON CONFLICT(id) DO NOTHING`,
      [runId, agentId, companyId, context.task.id, claim.contextId, { kind: 'task', executor: 'local-codex-login' }, context.task.governance_attempt_id])
    await client.query(`INSERT INTO task_authorization_events(id,company_id,task_id,principal_id,operation,outcome,references_json) VALUES($1,$2,$3,$4,'model.codex-login','PREPARED',$5)`,
      [id, companyId, context.task.id, agentId, { contextId: claim.contextId, generation: claim.generation, runId, model: request.model, requestHash: hashContent(canonicalJson(request)) }])
  })
  if (context.task.governance_attempt_id) {
    const reserved = await authorizeGovernedModelCall(tasks.pool, { runId, companyId, agentId, providerCallId: id, model: String(request.model),
      maxInputTokens: Buffer.byteLength(JSON.stringify(request)) + 4096, maxOutputTokens: 16000 })
    if (!reserved) throw new TaskError('GOVERNANCE_MAPPING_REQUIRED', 403)
  }
  await tasks.transaction(companyId, async client => {
    await execution.resolve(client, companyId, claim)
    await client.query(`UPDATE task_authorization_events SET outcome='AUTHORIZED' WHERE company_id=$1 AND id=$2 AND outcome='PREPARED'`, [companyId, id])
  })
  return { permitId: id, request }
}

export async function settleLocalModel(tasks: TaskService, companyId: string, agentId: string, claim: Claim, receipt: { permitId?: unknown; status?: unknown; usage?: unknown; latencyMs?: unknown }) {
  if (typeof receipt.permitId !== 'string' || !['ok', 'failed', 'timeout', 'rate_limited'].includes(String(receipt.status)) || typeof receipt.latencyMs !== 'number' || !Number.isFinite(receipt.latencyMs) || receipt.latencyMs < 0 || receipt.latencyMs > 600000) throw new TaskError('INVALID_MODEL_RECEIPT', 400)
  const usage = usageFromOpenAI(receipt.usage)
  if (Object.values(usage).some(value => !Number.isSafeInteger(value) || value < 0 || value > 20_000_000)) throw new TaskError('INVALID_MODEL_RECEIPT', 400)
  const context = await new TaskExecutionService(tasks).context(companyId, claim)
  const permit = (await tasks.pool.query(`SELECT * FROM task_authorization_events WHERE company_id=$1 AND id=$2 AND principal_id=$3 AND operation='model.codex-login'`, [companyId, receipt.permitId, agentId])).rows[0]
  if (!permit || permit.task_id !== context.task.id || permit.references_json.contextId !== claim.contextId || permit.references_json.generation !== claim.generation || !['AUTHORIZED', 'SETTLED'].includes(permit.outcome)) throw new TaskError('MODEL_PERMIT_DENIED', 403)
  const receiptHash = hashContent(canonicalJson(receipt))
  if (permit.outcome === 'SETTLED' && permit.references_json.receiptHash !== receiptHash) throw new TaskError('MODEL_RECEIPT_CONFLICT')
  if (context.task.governance_attempt_id && receipt.status === 'ok') {
    if (!receipt.usage) throw new TaskError('PROVIDER_USAGE_UNKNOWN')
    const settled = await settleGovernedModelCall(tasks.pool, { runId: permit.references_json.runId, companyId, agentId, providerCallId: permit.id, usage })
    if (!settled) throw new TaskError('GOVERNANCE_MAPPING_REQUIRED', 403)
  }
  await tasks.transaction(companyId, async client => {
    await new TaskExecutionService(tasks).resolve(client, companyId, claim)
    const current = (await client.query(`SELECT outcome,references_json FROM task_authorization_events WHERE company_id=$1 AND id=$2 FOR UPDATE`, [companyId, permit.id])).rows[0]
    if (current.outcome === 'SETTLED') { if (current.references_json.receiptHash !== receiptHash) throw new TaskError('MODEL_RECEIPT_CONFLICT'); return }
    await recordLlmCallsBatch([{ companyId, agentId, conversationId: context.task.conversation_id, runId: permit.references_json.runId,
      purpose: 'agent-turn', source: 'byoa-codex', model: permit.references_json.model, status: receipt.status as LlmCallStatus,
      usage: receipt.usage ? usage : null, latencyMs: receipt.latencyMs as number,
      extras: { taskId: context.task.id, taskContextId: claim.contextId, executor: 'local-codex-login', permitId: permit.id } }], client)
    await client.query(`UPDATE task_authorization_events SET outcome='SETTLED',references_json=references_json||$3::jsonb WHERE company_id=$1 AND id=$2`, [companyId, permit.id, JSON.stringify({ receiptHash })])
  })
}
