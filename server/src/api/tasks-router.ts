import { Router, type Request } from 'express'
import type { Pool } from 'pg'
import type { AuthedRequest } from '../auth.js'
import { TaskError } from '../tasks/contracts.js'
import { TaskService, type TaskPrincipal } from '../tasks/service.js'
import { TaskExecutionService } from '../tasks/execution.js'
import { TaskKnowledgeService } from '../tasks/knowledge.js'
import { TaskOperationService } from '../tasks/operations.js'
import { TaskIngressService } from '../tasks/ingress.js'
import { TaskWorkspaceService } from '../tasks/workspace.js'

interface Deps { pool: Pool; requireCompany(req: Request & AuthedRequest): Promise<{ companyId: string; userId: string }> }

function body(req: Request, allowed: string[]): Record<string, unknown> {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some((key) => !allowed.includes(key))) throw new TaskError('INVALID_REQUEST', 400)
  return req.body
}
function text(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TaskError('INVALID_REQUEST', 400)
  return value
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) throw new TaskError('INVALID_REQUEST', 400)
  return value.map((id) => text(id))
}

export function createTasksRouter(deps: Deps): Router {
  const router = Router()
  router.use((_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next()})
  const tasks = new TaskService(deps.pool)
  const execution = new TaskExecutionService(tasks)
  const knowledge = new TaskKnowledgeService(tasks)
  const workspace = new TaskWorkspaceService(tasks)
  const principal = async (req: Request): Promise<TaskPrincipal> => {
    const auth = await deps.requireCompany(req)
    return { companyId: auth.companyId, id: auth.userId }
  }
  const route = (handler: (req: Request, actor: TaskPrincipal) => Promise<unknown>) => async (req: Request, res: import('express').Response) => {
    try { res.json(await handler(req, await principal(req))) }
    catch (error) {
      if (error instanceof TaskError) { res.status(error.status).json({ error: error.code }); return }
      if ((error as {code?:string}).code === '42P01' || (error as {code?:string}).code === '42703') {res.status(409).json({error:'TASK_SCHEMA_MIGRATION_REQUIRED'});return}
      if (['23503', '23505', '23514'].includes((error as { code?: string }).code ?? '')) { res.status(409).json({ error: 'TASK_CONSTRAINT_CONFLICT' }); return }
      throw error
    }
  }
  router.get('/configuration', route(async (_req, actor) => tasks.configuration(actor)))
  router.post('/workspace/admissions', route(async(req,actor)=>{
    const input=body(req,['computerId','engine','binaryHash','verificationRef','checks','modelProvider'])
    await workspace.admit(actor,{computerId:text(input.computerId),engine:text(input.engine),binaryHash:text(input.binaryHash),verificationRef:text(input.verificationRef,2000),checks:input.checks as Record<string,unknown>,modelProvider:input.modelProvider as 'server'|'codex-login'|undefined});return {ok:true}
  }))
  router.post('/workspace/reconcile-executor',route(async(req,actor)=>{const input=body(req,['dispatchId','generation','proof']);await workspace.reconcileExecutor(actor,{dispatchId:text(input.dispatchId),generation:Number(input.generation),proof:text(input.proof,2000)});return {ok:true}}))
  router.post('/workspace/automations',route(async(req,actor)=>{const input=body(req,['channelId','bindingId','reason','grantIds','key']);await workspace.automation(actor,{channelId:text(input.channelId),bindingId:text(input.bindingId),reason:text(input.reason),grantIds:ids(input.grantIds),key:text(input.key)});return {ok:true}}))
  router.post('/workspace/gc',route(async(_req,actor)=>({removed:await workspace.gc(actor)})))
  router.post('/operations/:id/reconcile',route(async(req,actor)=>{const input=body(req,['outcome','proof','result']);if(!['SUCCEEDED','FAILED'].includes(String(input.outcome)) || !input.result || typeof input.result!=='object') throw new TaskError('INVALID_REQUEST',400);await new TaskOperationService(tasks).reconcile(actor,String(req.params.id),input.outcome as 'SUCCEEDED'|'FAILED',text(input.proof,2000),input.result as Record<string,unknown>);return {ok:true}}))
  router.post('/board',route(async(req,actor)=>{const input=body(req,['channelId','attemptId','cardId','grantIds']);if(Boolean(input.attemptId)===Boolean(input.cardId))throw new TaskError('INVALID_REQUEST',400);const ingress=new TaskIngressService(tasks);return input.attemptId ? ingress.governed(actor,text(input.channelId),text(input.attemptId),ids(input.grantIds??[])) : ingress.board(actor,text(input.channelId),text(input.cardId),ids(input.grantIds??[]))}))
  router.get('/channel-state', route(async (req, actor) => {
    const mode = await tasks.mode(actor.companyId)
    await tasks.transaction(actor.companyId, client => tasks.member(client,actor,text(req.query.channelId)))
    return {mode: mode === 'PREPARING' && await tasks.protectsLegacy(actor.companyId) ? 'PAUSED' : mode}
  }))
  router.get('/workspace', route(async (_req, actor) => tasks.transaction(actor.companyId, async (client) => {
    await tasks.administrator(client, actor)
    return { mode: await tasks.mode(actor.companyId), failures: await workspace.readiness(client, actor.companyId) }
  })))
  router.post('/workspace/prepare', route(async (_req, actor) => { await tasks.prepare(actor); return { ok: true } }))
  router.post('/workspace/activate', route(async (_req, actor) => { await workspace.activate(actor); return { ok: true } }))
  router.post('/workspace/stop', route(async (_req, actor) => { await workspace.stop(actor); return { ok: true } }))
  router.post('/workspace/rollback', route(async (_req, actor) => { await workspace.rollback(actor); return { ok: true } }))
  router.post('/definitions', route(async (req, actor) => {
    const input = body(req, ['definitionId', 'instructions', 'name', 'role'])
    return { id: await tasks.define(actor, text(input.definitionId), { instructions: text(input.instructions, 12000), name: text(input.name), role: text(input.role) }) }
  }))
  router.post('/bindings', route(async (req, actor) => {
    const input = body(req, ['channelId', 'agentId', 'definitionVersionId', 'alias', 'isDefault'])
    if (typeof input.isDefault !== 'boolean') throw new TaskError('INVALID_REQUEST', 400)
    return { id: await tasks.bind(actor, { channelId: text(input.channelId), agentId: text(input.agentId), definitionVersionId: text(input.definitionVersionId), alias: text(input.alias), isDefault: input.isDefault }) }
  }))
  router.patch('/bindings/:id',route(async(req,actor)=>{const input=body(req,['definitionVersionId','alias','isDefault','instructions']);if(typeof input.isDefault!=='boolean')throw new TaskError('INVALID_REQUEST',400);await tasks.editBinding(actor,String(req.params.id),{definitionVersionId:text(input.definitionVersionId),alias:text(input.alias),isDefault:input.isDefault,instructions:input.instructions===undefined?undefined:text(input.instructions,12000)});return {ok:true}}))
  router.post('/bundles',route(async(req,actor)=>{const input=body(req,['bundleId','grantIds']);return {id:await tasks.bundle(actor,text(input.bundleId),ids(input.grantIds))}}))
  router.post('/access-refs',route(async(req,actor)=>{const input=body(req,['channelId','bundleVersionId']);await tasks.referenceBundle(actor,text(input.channelId),text(input.bundleVersionId));return {ok:true}}))
  router.post('/connections', route(async (req, actor) => {
    const input = body(req, ['channelId', 'adapter'])
    if (input.adapter !== 'channel') throw new TaskError('RESOURCE_ADAPTER_UNSUPPORTED', 400)
    return { id: await tasks.connectChannel(actor, text(input.channelId)) }
  }))
  router.post('/grants', route(async (req, actor) => {
    const input = body(req, ['channelId', 'rule'])
    return { id: await tasks.grantChannel(actor, text(input.channelId), input.rule) }
  }))
  router.post('/grants/:id/revoke', route(async (req, actor) => { await tasks.revokeGrant(actor, String(req.params.id)); return { ok: true } }))
  router.post('/connections/:id/revoke', route(async (req, actor) => { await tasks.revokeConnection(actor, String(req.params.id)); return { ok: true } }))
  router.get('/', route(async (req, actor) => {
    const channelId = text(req.query.channelId)
    return tasks.transaction(actor.companyId, async (client) => {
      await tasks.member(client, actor, channelId)
      return (await client.query(`SELECT id,objective,status,blocked_code,scope_revision,input_revision,accountable_binding_id,parent_task_id,root_task_id,creator_principal_id FROM channel_tasks WHERE company_id=$1 AND conversation_id=$2 ORDER BY created_at DESC,id LIMIT 50`, [actor.companyId, channelId])).rows
    })
  }))
  router.post('/', route(async (req, actor) => {
    const input = body(req, ['channelId', 'objective', 'ingressKey', 'bindingId', 'grantIds', 'messageId', 'boardCardId','governanceActionId','governanceAttemptId'])
    return tasks.create(actor, { channelId: text(input.channelId), objective: text(input.objective, 12000), ingressKey: text(input.ingressKey), grantIds: ids(input.grantIds ?? []),
      bindingId: input.bindingId === undefined ? undefined : text(input.bindingId), messageId: input.messageId === undefined ? undefined : text(input.messageId), boardCardId: input.boardCardId === undefined ? undefined : text(input.boardCardId), governanceActionId: input.governanceActionId === undefined ? undefined : text(input.governanceActionId), governanceAttemptId: input.governanceAttemptId === undefined ? undefined : text(input.governanceAttemptId) })
  }))
  router.get('/:id', route(async (req, actor) => tasks.transaction(actor.companyId, async (client) => {
    const task = await tasks.task(client, actor, String(req.params.id))
    const deliveries = await client.query(`SELECT id,scope_revision,artifact_ids,evidence_ids,summary,limitations,message_id FROM task_deliveries WHERE company_id=$1 AND task_id=$2 ORDER BY created_at`, [actor.companyId, task.id])
    const visible=[]
    for(const delivery of deliveries.rows)if(delivery.message_id && await execution.deliveryVisibleInTransaction(client,actor.companyId,delivery.message_id))visible.push(delivery)
    const inputs=await client.query(`SELECT id,kind,reference_id,input_revision,retired_at FROM task_inputs WHERE company_id=$1 AND task_id=$2 ORDER BY created_at,id`,[actor.companyId,task.id])
    return { ...task, deliveries: visible,inputs:inputs.rows }
  })))
  router.post('/:id/inputs', route(async (req, actor) => {
    const input = body(req, ['text', 'messageId'])
    if (!!input.text === !!input.messageId) throw new TaskError('INVALID_REQUEST', 400)
    await tasks.supplement(actor, String(req.params.id), { text: input.text === undefined ? undefined : text(input.text, 12000), messageId: input.messageId === undefined ? undefined : text(input.messageId) })
    return { ok: true }
  }))
  router.post('/:id/inputs/:inputId/retire',route(async(req,actor)=>{await tasks.retireInput(actor,String(req.params.id),String(req.params.inputId));return {ok:true}}))
  router.post('/:id/drive', route(async (req, actor) => { const input = body(req, ['key']); return { dispatchId: await tasks.drive(actor, String(req.params.id), text(input.key)) } }))
  router.post('/:id/governance-artifacts',route(async(req,actor)=>{const input=body(req,['versionId','content']);return {id:await execution.importGovernance(actor,String(req.params.id),text(input.versionId),text(input.content,2000000))}}))
  router.post('/:id/steer',route(async(req,actor)=>{const input=body(req,['key','text']);return {dispatchId:await tasks.steer(actor,String(req.params.id),text(input.key),text(input.text,12000))}}))
  router.post('/:id/cancel', route(async (req, actor) => { await tasks.cancel(actor, String(req.params.id)); return { ok: true } }))
  router.post('/:id/scope', route(async (req, actor) => { const input = body(req, ['objective']); await tasks.reviseScope(actor, String(req.params.id), text(input.objective, 12000)); return { ok: true } }))
  router.post('/:id/grants', route(async (req, actor) => { const input = body(req, ['grantIds']); await tasks.approveGrants(actor, String(req.params.id), ids(input.grantIds)); return { ok: true } }))
  router.post('/:id/controllers', route(async (req, actor) => { const input = body(req, ['principalId', 'actions']); await tasks.controller(actor, String(req.params.id), text(input.principalId), ids(input.actions)); return { ok: true } }))
  router.get('/artifacts/:id', route(async(req,actor)=>{const a=await execution.readArtifact(actor,String(req.params.id));return {content:a.content.toString('utf8'),mediaType:a.mediaType,hash:a.hash}}))
  router.get('/artifacts/:id/content', async (req, res) => {
    try {
      const version = await execution.readArtifact(await principal(req), String(req.params.id))
      res.setHeader('Content-Type', version.mediaType)
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('ETag', `"${version.hash}"`)
      res.send(version.content)
    } catch (error) { if (error instanceof TaskError) { res.status(error.status).json({ error: error.code }); return }; throw error }
  })
  router.post('/knowledge/candidates', route(async (req, actor) => {
    const input = body(req, ['artifactVersionId', 'body', 'ownerKind'])
    if (!['CHANNEL', 'AGENT'].includes(String(input.ownerKind))) throw new TaskError('INVALID_REQUEST', 400)
    return { id: await knowledge.candidate(actor, { artifactVersionId: text(input.artifactVersionId), body: text(input.body, 12000), ownerKind: input.ownerKind as 'CHANNEL' | 'AGENT' }) }
  }))
  router.post('/knowledge/:id/confirm', route(async (req, actor) => { await knowledge.confirm(actor, String(req.params.id)); return { ok: true } }))
  router.post('/knowledge/:id/invalidate', route(async (req, actor) => { await knowledge.invalidate(actor, String(req.params.id)); return { ok: true } }))
  router.post('/knowledge/:id/publish', route(async (req, actor) => {
    const input = body(req, ['targetChannelId'])
    return { id: await knowledge.publish(actor, String(req.params.id), text(input.targetChannelId), []) }
  }))
  return router
}
