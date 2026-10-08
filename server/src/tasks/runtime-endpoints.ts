import { governedTaskModelCall } from './governance.js'
import { GovernanceBudgetError } from '../governance/runtime-budget.js'
import { TaskPlanService } from './plans.js'
import type { Router, Request, Response, RequestHandler } from 'express'
import type { AgentRuntimeClaims } from '../agents/runtime/jwt.js'
import { taskService } from './legacy-guard.js'
import { TaskError, hashContent, } from './contracts.js'
import { TaskExecutionService, type Claim } from './execution.js'
import { getTrackedLlmClient } from '../agents/llm-ledger.js'
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses.js'
import { authorizeLocalModel, settleLocalModel, localModelRequest, taskRuntimeModel } from './local-model.js'

type Wrap = (handler: (claims: AgentRuntimeClaims & { companyId: string }, req: Request, res: Response) => Promise<void>) => RequestHandler
const execution = new TaskExecutionService(taskService)

function parseClaim(value: unknown): Claim {
  if (!value || typeof value !== 'object') throw new TaskError('INVALID_CLAIM', 400)
  const claim = value as Claim
  if (!['id', 'contextId', 'token'].every((key) => typeof (claim as unknown as Record<string, unknown>)[key] === 'string') || !Number.isInteger(claim.generation) || claim.generation < 1) throw new TaskError('INVALID_CLAIM', 400)
  return claim
}

async function claimOwner(claims: AgentRuntimeClaims & { companyId: string }, claim: Claim): Promise<void> {
  const owned = await taskService.pool.query(`SELECT 1 FROM task_dispatches d JOIN task_execution_contexts x ON x.id=d.context_id AND x.company_id=d.company_id
    WHERE d.company_id=$1 AND d.agent_id=$2 AND d.id=$3 AND d.context_id=$4 AND d.claim_generation=$5 AND d.claim_token_hash=$6 AND x.computer_id IS NOT DISTINCT FROM $7`,
    [claims.companyId, claims.sub, claim.id, claim.contextId, claim.generation, hashContent(claim.token), claims.computerId ?? null])
  if (!owned.rowCount) throw new TaskError('TASK_RUNTIME_OWNER_DENIED', 403)
}

export function attachTaskRuntimeEndpoints(router: Router, wrap: Wrap): void {
  const route = (handler: (claims: AgentRuntimeClaims & { companyId: string }, req: Request, res: Response) => Promise<void>) => wrap(async (claims, req, res) => {
    try { await handler(claims, req, res) }
    catch (error) { if (error instanceof TaskError || error instanceof GovernanceBudgetError) { res.status(error instanceof TaskError?error.status:409).json({ error: error.code }); return }; throw error }
  })
  router.post('/tasks/claim', route(async (claims, _req, res) => {
    const agent = await taskService.pool.query(`SELECT p.engine,c.kind FROM participants p JOIN computers c ON c.id=p.computer_id AND c.company_id=p.company_id
      JOIN task_runtime_admissions a ON a.company_id=p.company_id AND a.computer_id=p.computer_id AND a.engine=p.engine AND a.revoked_at IS NULL
      WHERE p.company_id=$1 AND p.id=$2 AND c.id=$3 AND c.kind<>'cloud' AND c.revoked_at IS NULL`, [claims.companyId, claims.sub, claims.computerId])
    if (!agent.rows[0] || agent.rows[0].engine !== 'codex' || await taskService.mode(claims.companyId) !== 'TASK') throw new TaskError('RUNTIME_CAPABILITY_UNQUALIFIED', 403)
    const claim = await taskService.claim(claims.companyId, claims.sub, `local:${claims.computerId}`)
    if (claim) await claimOwner(claims, claim)
    res.json({ claim })
  }))
  router.post('/tasks/context', route(async (claims, req, res) => {
    const claim = parseClaim(req.body?.claim)
    await claimOwner(claims, claim)
    const resolved = await execution.context(claims.companyId, claim)
    const admission = await taskService.pool.query(`SELECT capabilities FROM task_runtime_admissions WHERE company_id=$1 AND computer_id=$2 AND engine='codex' AND revoked_at IS NULL`, [claims.companyId, claims.computerId])
    if (!admission.rows[0]?.capabilities?.binaryHash) throw new TaskError('RUNTIME_CAPABILITY_UNQUALIFIED', 403)
    const plan = await taskService.pool.query(`SELECT 1 FROM task_plan_versions WHERE company_id=$1 AND task_id=$2 AND (plan->>'scopeRevision')::int=$3`, [claims.companyId, resolved.task.id, resolved.task.scope_revision])
    res.json({ context: { taskId: resolved.task.id, objective: resolved.task.objective, scopeRevision: resolved.task.scope_revision,
      parentTaskId: resolved.task.parent_task_id, canPlan: !resolved.task.parent_task_id && !plan.rowCount,
      eligibleBindings: resolved.eligibleBindings, rootGrantIds: resolved.rootGrantIds,
      instructions: resolved.instructions, inputs: resolved.inputs.map((input) => ({ id: input.id, content: input.content })) }, model: await taskRuntimeModel(taskService, resolved, claim.contextId),
      modelProvider: admission.rows[0].capabilities.modelProvider ?? 'server', binaryHash: admission.rows[0].capabilities.binaryHash })
  }))
  router.post('/tasks/heartbeat', route(async (claims, req, res) => { const claim = parseClaim(req.body?.claim); await claimOwner(claims, claim); await execution.heartbeat(claims.companyId, claim); res.json({ ok: true }) }))
  router.post('/tasks/model/authorize', route(async (claims, req, res) => {
    const claim = parseClaim(req.body?.claim); await claimOwner(claims, claim)
    res.json(await authorizeLocalModel(taskService, claims.companyId, claims.sub, claim, req.body?.request))
  }))
  router.post('/tasks/model/receipt', route(async (claims, req, res) => {
    const claim = parseClaim(req.body?.claim); await claimOwner(claims, claim)
    await settleLocalModel(taskService, claims.companyId, claims.sub, claim, req.body?.receipt ?? {})
    res.json({ ok: true })
  }))
  router.post('/tasks/model', route(async (claims, req, res) => {
    const claim = parseClaim(req.body?.claim)
    await claimOwner(claims, claim)
    const context = await execution.context(claims.companyId, claim)
    const modelRequest: ResponseCreateParamsNonStreaming = localModelRequest(context, req.body?.request)
    const runId=`task-local:${claim.id}`
    await taskService.pool.query(`INSERT INTO agent_runs(id,agent_id,company_id,task_id,task_context_id,trigger,status,governance_attempt_id) VALUES($1,$2,$3,$4,$5,$6,'running',$7) ON CONFLICT(id) DO NOTHING`,[runId,claims.sub,claims.companyId,context.task.id,claim.contextId,{kind:'task',executor:'local'},context.task.governance_attempt_id])
    const client = await getTrackedLlmClient({ purpose: 'agent-turn', companyId: claims.companyId, agentId: claims.sub,
      conversationId: context.task.conversation_id, runId, extras: { taskId: context.task.id, taskContextId: claim.contextId, executor: 'local-codex-isolated' } })
    const response = await governedTaskModelCall(taskService.pool,context.task,claims.sub,runId,String(modelRequest.model),modelRequest,()=>client.responses.create(modelRequest,{maxRetries:0}))
    // Revalidation after the provider call prevents stale results from becoming protected local work.
    await execution.context(claims.companyId, claim)
    res.json(response)
  }))
  router.post('/tasks/plan',route(async(claims,req,res)=>{const claim=parseClaim(req.body?.claim);await claimOwner(claims,claim);res.json({planId:await new TaskPlanService(taskService).propose(claims.companyId,claim,req.body?.plan)})}))
  router.post('/tasks/artifacts', route(async (claims, req, res) => {
    const claim = parseClaim(req.body?.claim); await claimOwner(claims, claim)
    if (typeof req.body?.content !== 'string' || typeof req.body?.mediaType !== 'string') throw new TaskError('INVALID_ARTIFACT', 400)
    res.json(await execution.artifact(claims.companyId, claim, { content: req.body.content, mediaType: req.body.mediaType }))
  }))
  router.post('/tasks/deliver', route(async (claims, req, res) => {
    const claim = parseClaim(req.body?.claim); await claimOwner(claims, claim)
    const input = req.body?.delivery
    if (!input || typeof input.summary !== 'string' || !Array.isArray(input.artifactIds) || input.artifactIds.some((id: unknown) => typeof id !== 'string')) throw new TaskError('INVALID_DELIVERY', 400)
    const context = await execution.context(claims.companyId, claim)
    const evidence = await taskService.pool.query<{ id: string }>(`SELECT a.id FROM task_plan_versions p CROSS JOIN LATERAL jsonb_array_elements(p.plan->'members') m
      JOIN task_deliveries d ON d.task_id=m->>'taskId' AND d.company_id=p.company_id
      JOIN channel_tasks child ON child.id=d.task_id AND child.company_id=d.company_id AND child.scope_revision=d.scope_revision
      JOIN artifact_versions a ON a.id IN(SELECT jsonb_array_elements_text(d.artifact_ids)) AND a.company_id=p.company_id
      WHERE p.company_id=$1 AND p.task_id=$2 AND (p.plan->>'scopeRevision')::int=$3 AND m->>'role'='VERIFY'`, [claims.companyId, context.task.id, context.task.scope_revision])
    res.json({ deliveryId: await execution.deliver(claims.companyId, claim, { summary: input.summary, artifactIds: input.artifactIds, evidenceIds: evidence.rows.map(row => row.id), key: `dispatch:${claim.id}` }) })
  }))
  router.post('/tasks/block', route(async (claims, req, res) => { const claim = parseClaim(req.body?.claim); await claimOwner(claims, claim); const code=typeof req.body?.code==='string' && /^[A-Z0-9_:.\-,]{1,200}$/.test(req.body.code)?req.body.code:'LOCAL_TASK_BLOCKED'; await execution.block(claims.companyId, claim, code); res.json({ ok: true }) }))
  router.post('/tasks/stopped', route(async (claims, req, res) => { const claim = parseClaim(req.body?.claim); await claimOwner(claims, claim); await taskService.confirmStopped(claims.companyId, claim.id, claim.generation, claim.token); await taskService.pool.query(`UPDATE agent_runs SET status=CASE WHEN EXISTS(SELECT 1 FROM task_dispatches WHERE id=$1 AND state='COMPLETED') THEN 'completed' ELSE 'failed' END,finished_at=NOW() WHERE task_context_id=$2 AND status='running'`,[claim.id,claim.contextId]); res.json({ ok: true }) }))
}
