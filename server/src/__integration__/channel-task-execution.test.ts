import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../db/pool.js'
import { ensureSchemaOnce, resetAllTables, teardownAll } from './_helpers.js'
import { TaskService } from '../tasks/service.js'
import { hashContent } from '../tasks/contracts.js'
import { TaskExecutionService } from '../tasks/execution.js'
import { TaskKnowledgeService } from '../tasks/knowledge.js'
import { runCloudTask } from '../tasks/runner.js'
import { inprocClient } from '../agents/runtime/inproc-client.js'
import { runCli } from '../agents/cli.js'
import { TaskWorkspaceService } from '../tasks/workspace.js'
import { TaskPlanService } from '../tasks/plans.js'
import { TaskOperationService } from '../tasks/operations.js'
import { TaskIngressService } from '../tasks/ingress.js'
import { buildApiTestApp } from './_helpers.js'
import { drainRealtimeOutbox } from '../realtime-outbox.js'
import { Pool } from 'pg'
import { verifySchemaCompatibility } from '../db/schema-version.js'

const service = new TaskService(pool)
const principal = { companyId: 'task-test', id: 'owner' }
before(ensureSchemaOnce)
beforeEach(resetAllTables)
after(async () => { await teardownAll() })

async function apiSession(actor='owner') {
  const app=await buildApiTestApp(actor)
  const server=app.listen(0,'127.0.0.1')
  await new Promise<void>(resolve=>server.once('listening',resolve))
  const address=server.address()
  if(!address || typeof address==='string')throw new Error('test server failed to bind')
  return {server,request:async(path:string,method='GET',body?:unknown)=>{
    const response=await fetch(`http://127.0.0.1:${address.port}/api${path}`,{method,headers:{'x-company-id':'task-test','content-type':'application/json','idempotency-key':crypto.randomUUID()},body:body===undefined?undefined:JSON.stringify(body)})
    return {status:response.status,body:await response.json() as any}
  },close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))}
}

async function seed() {
  await pool.query(`INSERT INTO companies(id,name,slug,owner_user_id) VALUES('task-test','Task test','task-test','owner'),('other-test','Other','other-test','owner')`)
  await pool.query(`INSERT INTO users(id,email,display_name) VALUES('owner','owner@task.test','Owner')`)
  await pool.query(`INSERT INTO users(id,email,display_name) VALUES('observer','observer@task.test','Observer')`)
  await pool.query(`INSERT INTO company_members(company_id,user_id,role) VALUES('task-test','owner','owner'),('task-test','observer','member')`)
  for (const [id, kind] of [['owner', 'human'], ['observer', 'human'], ['agent', 'agent']]) {
    await pool.query(`INSERT INTO participants(id,company_id,kind,name,initial,avatar_bg,status) VALUES($1,'task-test',$2,$1,'T','#fff','avail')`, [id, kind])
  }
  await pool.query(`INSERT INTO conversations(id,company_id,kind,title,members) VALUES('channel','task-test','group','Channel','["owner","observer","agent"]'),('other-channel','task-test','group','Other','["owner","agent"]')`)
  await service.prepare(principal)
  const definition = await service.define(principal, 'worker', { instructions: 'Work only on the requested task.' })
  const binding = await service.bind(principal, { channelId: 'channel', agentId: 'agent', definitionVersionId: definition, alias: 'Worker', isDefault: true })
  const rule = { resource: 'channel:channel', actions: ['read', 'publish'], identity: 'service:channel:channel',
    audience: { kind: 'CHANNEL', id: 'channel' }, destinations: ['task-model', 'artifact', 'channel'], expiresAt: '2099-01-01T00:00:00Z' }
  const grant = await service.grantChannel(principal, 'channel', rule)
  const task = await service.create(principal, { channelId: 'channel', objective: 'Review a patch', ingressKey: 'request', grantIds: [grant] })
  return { definition, binding, grant, task }
}

test('task schema enforces tenant/channel ownership, single defaults and immutable definitions', async () => {
  const { definition, binding, task } = await seed()
  await assert.rejects(pool.query(`UPDATE agent_definition_versions SET body='{}' WHERE id=$1`, [definition]), { code: '23514' })
  await assert.rejects(pool.query(`INSERT INTO channel_agent_bindings(id,company_id,conversation_id,agent_id,definition_version_id,alias,is_default)
    VALUES('duplicate','task-test','channel','agent',$1,'Duplicate',TRUE)`, [definition]), { code: '23505' })
  await assert.rejects(pool.query(`INSERT INTO channel_tasks(id,company_id,conversation_id,creator_principal_id,accountable_binding_id,root_task_id,objective,ingress_key,definition_version_id,configuration)
    VALUES('wrong-channel','task-test','other-channel','owner',$1,'wrong-channel','Wrong','wrong',$2,'{}')`, [binding,definition]), { code: '23503' })
  await assert.rejects(pool.query(`UPDATE channel_tasks SET company_id='other-test' WHERE id=$1`, [task.id]), { code: '23503' })
  await assert.rejects(pool.query(`UPDATE channel_tasks SET root_task_id='other' WHERE id=$1`, [task.id]), { code: '23514' })
})

test('membership removal ends the old binding and rejoin does not revive it', async () => {
  const { binding } = await seed()
  await pool.query(`DELETE FROM conversation_members WHERE conversation_id='channel' AND participant_id='agent'`)
  assert.equal((await pool.query(`SELECT status FROM channel_agent_bindings WHERE id=$1`, [binding])).rows[0].status, 'ENDED')
  await pool.query(`INSERT INTO conversation_members(conversation_id,company_id,participant_id,ordinal) VALUES('channel','task-test','agent',2)`)
  await assert.rejects(service.transaction('task-test', (client) => service.binding(client, 'task-test', 'channel', binding)), /BINDING_INELIGIBLE/)
  await assert.rejects(service.transaction('other-test', (client) => service.binding(client, 'other-test', 'channel', binding)), /BINDING_INELIGIBLE/)
})

test('existing Tasks pin immutable definitions while new Tasks use explicit Binding updates and read-only coordination',async()=>{
  const {task,binding,definition,grant}=await seed()
  const nextDefinition=await service.define(principal,'worker',{instructions:'NEW_DEFINITION_ONLY',role:'COORDINATOR'})
  await service.editBinding(principal,binding,{definitionVersionId:nextDefinition,alias:'Aida',isDefault:true,instructions:'NEW_BINDING_OVERRIDE'})
  await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id='task-test'`)
  await service.drive(principal,task.id,'fixed-definition')
  const oldClaim=(await service.claim('task-test','agent','old-definition'))!
  const oldContext=await new TaskExecutionService(service).context('task-test',oldClaim)
  assert.equal(oldContext.task.definition_version_id,definition)
  assert.equal(oldContext.instructions,'Work only on the requested task.')
  await service.confirmStopped('task-test',oldClaim.id,oldClaim.generation,oldClaim.token)
  const current=await service.create(principal,{channelId:'channel',objective:'Coordinate bounded work',ingressKey:'new-definition',grantIds:[grant]})
  await assert.rejects(pool.query(`UPDATE channel_tasks SET configuration='{}' WHERE id=$1`,[current.id]),{code:'23514'})
  await service.drive(principal,current.id,'new-definition')
  const claim=(await service.claim('task-test','agent','coordinator'))!
  const context=await new TaskExecutionService(service).context('task-test',claim)
  assert.equal(context.instructions,'NEW_BINDING_OVERRIDE');assert.equal(context.task.definition_version_id,nextDefinition)
  let effects=0
  await assert.rejects(new TaskOperationService(service).execute('task-test',claim,{key:'forbidden-direct',grantId:context.rootGrantIds[0],resource:'channel:channel',action:'write',identity:'service:channel:channel',destination:'artifact',payload:{}},async()=>{effects++;return {ok:true}}),/TASK_DIRECT_OPERATION_DENIED/)
  assert.equal(effects,0)
  await service.confirmStopped('task-test',claim.id,claim.generation,claim.token)
})

test('task ingress is idempotent and channel members can supplement but cannot drive or cancel another creator task', async () => {
  const { task, grant } = await seed()
  const again = await service.create(principal, { channelId: 'channel', objective: 'Review a patch', ingressKey: 'request', grantIds: [grant] })
  assert.equal(again.id, task.id)
  await assert.rejects(service.create(principal, { channelId: 'channel', objective: 'Different', ingressKey: 'request', grantIds: [] }), /INGRESS_KEY_CONFLICT/)
  await service.supplement({ ...principal, id: 'observer' }, task.id, { text: 'Include the corner case.' })
  assert.equal((await pool.query(`SELECT input_revision,scope_revision FROM channel_tasks WHERE id=$1`, [task.id])).rows[0].input_revision, 2)
  await assert.rejects(service.drive({ ...principal, id: 'observer' }, task.id, 'drive'), /TASK_CONTROL_DENIED/)
  await assert.rejects(service.cancel({ ...principal, id: 'observer' }, task.id), /TASK_CONTROL_DENIED/)
  await assert.rejects(service.create({ ...principal, id: 'observer' }, { channelId: 'channel', objective: 'Use copied grant', ingressKey: 'copied', grantIds: [grant] }), /GRANT_CALLER_DENIED/)
})

test('durable claims fence duplicate notifications and expiry stays unknown until stopped', async () => {
  const { task } = await seed()
  await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id='task-test'`)
  const dispatch = await service.drive(principal, task.id, 'run')
  assert.equal(await service.drive(principal, task.id, 'run'), dispatch)
  const [a, b] = await Promise.all([service.claim('task-test', 'agent', 'runner-a'), service.claim('task-test', 'agent', 'runner-b')])
  const claim = a ?? b
  assert.ok(claim)
  assert.equal([a, b].filter(Boolean).length, 1)
  await pool.query(`UPDATE task_dispatches SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1`, [dispatch])
  assert.equal(await service.claim('task-test', 'agent', 'runner-c'), null)
  assert.equal((await pool.query(`SELECT state FROM task_dispatches WHERE id=$1`, [dispatch])).rows[0].state, 'UNKNOWN')
  await assert.rejects(service.confirmStopped('task-test', dispatch, claim.generation + 1, claim.token), /STALE_CLAIM/)
  await service.confirmStopped('task-test', dispatch, claim.generation, claim.token)
  assert.ok((await pool.query(`SELECT stopped_at FROM task_dispatches WHERE id=$1`, [dispatch])).rows[0].stopped_at)
})

test('revoked sources block drive and cross-channel messages are never accepted as inputs', async () => {
  const { task, grant } = await seed()
  await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id='task-test'`)
  await service.revokeGrant(principal, grant)
  await assert.rejects(service.drive(principal, task.id, 'run'), /SOURCE_REVOKED/)
  await pool.query(`INSERT INTO messages(id,company_id,conversation_id,author_id,kind,body,sequence) VALUES('wrong-message','task-test','other-channel','owner','text','Private',1)`)
  await assert.rejects(service.supplement(principal, task.id, { messageId: 'wrong-message' }), /INPUT_SOURCE_DENIED/)
  assert.equal((await pool.query(`SELECT COUNT(*)::integer AS n FROM task_execution_contexts`)).rows[0].n, 0)
})

test('artifact versions are immutable and database hash validation rejects invalid hashes', async () => {
  const { task, binding } = await seed()
  await pool.query(`INSERT INTO artifact_versions(id,artifact_id,company_id,task_id,producer_binding_id,media_type,content,content_hash,provenance)
    VALUES('version','artifact','task-test',$1,$2,'text/plain',$3,$4,'{}')`, [task.id, binding, Buffer.from('original'), hashContent('original')])
  await assert.rejects(pool.query(`UPDATE artifact_versions SET content=$1 WHERE id='version'`, [Buffer.from('changed')]), { code: '23514' })
  await assert.rejects(pool.query(`INSERT INTO artifact_versions(id,artifact_id,company_id,task_id,producer_binding_id,media_type,content,content_hash,provenance)
    VALUES('bad','artifact','task-test',$1,$2,'text/plain',$3,'bad','{}')`, [task.id, binding, Buffer.from('bad')]), { code: '23514' })
})

test('cloud task loop uses only its approved context and delivers artifact/message/outbox exactly once', async () => {
  const { task } = await seed()
  await pool.query(`INSERT INTO messages(id,company_id,conversation_id,author_id,kind,body,sequence) VALUES('secret-message','task-test','other-channel','owner','text','OTHER_TASK_SECRET',1)`)
  await pool.query(`INSERT INTO agent_workspace(agent_id,company_id,path,body,meta) VALUES('agent','task-test','memory/global/secret.md','OLD_MEMORY_SECRET','{"pinned":true}')`)
  await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id='task-test'`)
  await service.drive(principal, task.id, 'run')
  let steps = 0
  assert.equal(await runCloudTask(service, 'task-test', 'agent', async (resolved, history) => {
    const serialized = JSON.stringify({ resolved, history })
    assert.doesNotMatch(serialized, /OTHER_TASK_SECRET|OLD_MEMORY_SECRET|claim_token_hash|DATABASE_URL|credential_ref/)
    assert.equal(resolved.task.id, task.id)
    steps++
    return steps === 1 ? { text: '', calls: [{ id: 'call', name: 'artifact_create', arguments: JSON.stringify({ content: 'Checked patch', mediaType: 'text/x-diff' }) }] } : { text: 'The patch review is complete.', calls: [] }
  }), true)
  assert.equal(steps, 2)
  assert.equal((await pool.query(`SELECT status FROM channel_tasks WHERE id=$1`, [task.id])).rows[0].status, 'DELIVERED')
  assert.equal((await pool.query(`SELECT COUNT(*)::integer AS n FROM task_deliveries WHERE task_id=$1`, [task.id])).rows[0].n, 1)
  assert.equal((await pool.query(`SELECT COUNT(*)::integer AS n FROM realtime_outbox WHERE payload->>'taskDelivery'='true'`)).rows[0].n, 1)
  assert.equal(await runCloudTask(service, 'task-test', 'agent', async () => { throw new Error('must not rerun') }), false)
  await assert.rejects(inprocClient.loadInbox('agent'), /TASK_CONTEXT_REQUIRED/)
  await assert.rejects(inprocClient.loadMemory('agent', 'secret'), /TASK_CONTEXT_REQUIRED/)
  const result = await runCli(['--as', 'agent', 'workspace', 'read', 'memory/global/secret.md'])
  assert.equal(result.ok, false)
  assert.match(result.text, /TASK_CONTEXT_REQUIRED/)
})

test('artifact publication is private before delivery and current grant revoke rejects delivery without an outbox message', async () => {
  const { task, grant } = await seed()
  await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id='task-test'`)
  await service.drive(principal, task.id, 'run')
  const claim = await service.claim('task-test', 'agent', 'runner')
  assert.ok(claim)
  const execution = new TaskExecutionService(service)
  const artifact = await execution.artifact('task-test', claim, { content: 'Private draft', mediaType: 'text/plain' })
  await assert.rejects(execution.readArtifact({ ...principal, id: 'observer' }, artifact.id), /ARTIFACT_PRIVATE/)
  assert.equal((await execution.readArtifact(principal, artifact.id)).content.toString(), 'Private draft')
  await service.revokeGrant(principal, grant)
  await assert.rejects(execution.deliver('task-test', claim, { key: 'delivery', summary: 'Done', artifactIds: [artifact.id] }), /SOURCE_REVOKED/)
  await assert.rejects(execution.readArtifact(principal, artifact.id), /SOURCE_REVOKED/)
  assert.equal((await pool.query(`SELECT COUNT(*)::integer AS n FROM task_deliveries`)).rows[0].n, 0)
  assert.equal((await pool.query(`SELECT COUNT(*)::integer AS n FROM realtime_outbox`)).rows[0].n, 0)
  await service.confirmStopped('task-test', claim.id, claim.generation, claim.token)
})

test('Agent knowledge stays source-channel restricted until explicit owner publication and invalidation removes it', async () => {
  const { definition, task } = await seed()
  const sourceBinding = await service.bind(principal, { channelId: 'other-channel', agentId: 'agent', definitionVersionId: definition, alias: 'Worker', isDefault: true })
  const sourceTask = await service.create(principal, { channelId: 'other-channel', objective: 'Remember my owned finding', ingressKey: 'private-finding', bindingId: sourceBinding, grantIds: [] })
  await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id='task-test'`)
  await service.drive(principal, sourceTask.id, 'run')
  await runCloudTask(service, 'task-test', 'agent', async () => ({ text: 'Owned finding', calls: [] }))
  const version = (await pool.query(`SELECT id FROM artifact_versions WHERE task_id=$1 LIMIT 1`, [sourceTask.id])).rows[0].id
  const knowledge = new TaskKnowledgeService(service)
  const id = await knowledge.candidate(principal, { artifactVersionId: version, body: 'Owned reusable finding', ownerKind: 'AGENT' })
  await knowledge.confirm(principal, id)
  assert.equal((await knowledge.retrieve(task, 'agent')).length, 0)
  await knowledge.publish(principal, id, 'channel', [])
  assert.equal((await knowledge.retrieve(task, 'agent'))[0].body, 'Owned reusable finding')
  assert.deepEqual(await knowledge.retrieve(task,'agent','embedding:unapproved'),[])
  await service.drive(principal,task.id,'knowledge-context')
  const knowledgeClaim=(await service.claim('task-test','agent','knowledge-worker'))!
  assert.ok((await new TaskExecutionService(service).context('task-test',knowledgeClaim)).inputs.some(input=>input.content==='Owned reusable finding'))
  await knowledge.invalidate(principal, id)
  await assert.rejects(new TaskExecutionService(service).context('task-test',knowledgeClaim),/SOURCE_REVOKED/)
  await service.confirmStopped('task-test',knowledgeClaim.id,knowledgeClaim.generation,knowledgeClaim.token)
  assert.equal((await knowledge.retrieve(task, 'agent')).length, 0)
})

test('cutover checks every channel default and rollback waits for executor stop', async () => {
  const { definition, task } = await seed()
  const workspace = new TaskWorkspaceService(service)
  await assert.rejects(workspace.activate(principal), /CHANNEL_DEFAULT_MISSING/)
  await service.bind(principal, { channelId: 'other-channel', agentId: 'agent', definitionVersionId: definition, alias: 'Worker', isDefault: true })
  await workspace.activate(principal)
  await service.drive(principal, task.id, 'run')
  const claim = await service.claim('task-test', 'agent', 'runner')
  assert.ok(claim)
  await workspace.stop(principal)
  await assert.rejects(inprocClient.loadInbox('agent'), /TASK_CONTEXT_REQUIRED/)
  await assert.rejects(workspace.rollback(principal), /EXECUTOR_NOT_STOPPED/)
  await service.confirmStopped('task-test', claim.id, claim.generation, claim.token)
  await workspace.rollback(principal)
  assert.equal(await service.mode('task-test'), 'LEGACY')
})

test('REST ambiguity is transactional, explicit selection resolves it and body identities cannot spoof the caller',async()=>{
  const {task}=await seed()
  await service.create(principal,{channelId:'channel',objective:'Second task',ingressKey:'second',grantIds:[]})
  await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id='task-test'`)
  const session=await apiSession()
  try {
    const ambiguous=await session.request('/conversations/channel/messages','POST',{body:'Additional information',clientId:'ambiguous'})
    assert.equal(ambiguous.status,409);assert.equal(ambiguous.body.error,'TASK_SELECTION_REQUIRED')
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM messages WHERE client_id='ambiguous'`)).rows[0].n,0)
    const selected=await session.request('/conversations/channel/messages','POST',{body:'Additional information',clientId:'ambiguous',taskId:task.id})
    assert.equal(selected.status,202);assert.equal(selected.body.taskId,task.id)
    const replay=await session.request('/conversations/channel/messages','POST',{body:'Additional information',clientId:'ambiguous',taskId:task.id})
    assert.equal(replay.status,202);assert.equal(replay.body.id,selected.body.id);assert.equal(replay.body.taskId,task.id)
    const wrongReplay=await session.request('/conversations/channel/messages','POST',{body:'Changed request',clientId:'ambiguous',taskId:task.id})
    assert.equal(wrongReplay.body.error,'INGRESS_KEY_CONFLICT')
    const readers=await Promise.all(Array.from({length:8},(_,index)=>Promise.all([
      session.request(`/tasks/${task.id}`),
      session.request('/conversations/channel/messages','POST',{body:`Concurrent input ${index}`,clientId:`concurrent-${index}`,taskId:task.id}),
    ])))
    assert.ok(readers.every(pair=>pair[0].status===200 && pair[1].status===202))
    const spoof=await session.request('/tasks','POST',{channelId:'channel',objective:'Spoof',ingressKey:'spoof',creatorId:'observer',grantIds:[]})
    assert.equal(spoof.status,400);assert.equal(spoof.body.error,'INVALID_REQUEST')
    const state=await session.request('/tasks/channel-state?channelId=channel')
    assert.equal(state.body.mode,'TASK')
    const other=await session.request('/tasks?channelId=missing-channel')
    assert.equal(other.status,403)
  }finally{await session.close()}
})

test('input revisions fence current executors and steer is idempotent, task-scoped and controller-only',async()=>{
  const {task}=await seed()
  await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id='task-test'`)
  await service.drive(principal,task.id,'first')
  const claim=(await service.claim('task-test','agent','first'))!
  assert.ok(claim)
  await assert.rejects(service.steer({...principal,id:'observer'},task.id,'steer','Unapproved instruction'),/TASK_CONTROL_DENIED/)
  const next=await service.steer(principal,task.id,'steer','Include the retry path')
  assert.equal(await service.steer(principal,task.id,'steer','Include the retry path'),next)
  assert.equal((await pool.query(`SELECT input_revision FROM channel_tasks WHERE id=$1`,[task.id])).rows[0].input_revision,2)
  await assert.rejects(new TaskExecutionService(service).context('task-test',claim),/TASK_CONTEXT_REVOKED/)
  assert.equal(await service.claim('task-test','agent','second'),null)
  await service.confirmStopped('task-test',claim.id,claim.generation,claim.token)
  const replacement=(await service.claim('task-test','agent','second'))!
  const context=await new TaskExecutionService(service).context('task-test',replacement)
  assert.ok(context.inputs.some(input=>input.content==='Include the retry path'))
  assert.equal(context.task.id,task.id)
  await service.confirmStopped('task-test',replacement.id,replacement.generation,replacement.token)
})

test('scope revision requires stopped executors, retires the old objective and requires grants to be reapproved',async()=>{
  const {task,grant}=await seed()
  await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id='task-test'`)
  await service.drive(principal,task.id,'old')
  const claim=(await service.claim('task-test','agent','runner'))!
  await assert.rejects(service.reviseScope(principal,task.id,'New objective'),/EXECUTOR_NOT_STOPPED/)
  const execution=new TaskExecutionService(service)
  const oldArtifact=await execution.artifact('task-test',claim,{content:'Old objective output',mediaType:'text/plain'})
  await execution.deliver('task-test',claim,{key:'old-delivery',summary:'Old scope delivered',artifactIds:[oldArtifact.id]})
  await service.confirmStopped('task-test',claim.id,claim.generation,claim.token)
  await service.reviseScope(principal,task.id,'New objective')
  assert.equal((await pool.query(`SELECT status FROM channel_tasks WHERE id=$1`,[task.id])).rows[0].status,'OPEN')
  assert.equal((await pool.query(`SELECT scope_revision FROM task_deliveries WHERE task_id=$1`,[task.id])).rows[0].scope_revision,1)
  await assert.rejects(execution.readArtifact(principal,oldArtifact.id),/SOURCE_UNKNOWN/)
  await service.approveGrants(principal,task.id,[grant])
  await service.drive(principal,task.id,'new')
  const current=(await service.claim('task-test','agent','runner'))!
  const context=await new TaskExecutionService(service).context('task-test',current)
  assert.equal(context.task.scope_revision,2)
  assert.deepEqual(context.inputs.map(input=>input.content),['New objective'])
  await service.confirmStopped('task-test',current.id,current.generation,current.token)
})

test('Aida repair, independent verification and aggregation use immutable handoffs and publish only one root delivery',async()=>{
  const {task,definition}=await seed()
  const bindings:Record<string,string>={}
  for(const agent of ['repair','verify']){
    await pool.query(`INSERT INTO participants(id,company_id,kind,name,initial,avatar_bg,status) VALUES($1,'task-test','agent',$1,'A','#fff','avail')`,[agent])
    await pool.query(`INSERT INTO conversation_members(conversation_id,company_id,participant_id,ordinal) VALUES('channel','task-test',$1,$2)`,[agent,agent==='repair'?3:4])
    bindings[agent]=await service.bind(principal,{channelId:'channel',agentId:agent,definitionVersionId:definition,alias:agent,isDefault:false})
  }
  await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id='task-test'`)
  await service.drive(principal,task.id,'plan')
  const plan={parallelism:2,members:[{key:'repair',bindingId:bindings.repair,objective:'Repair the retry bug',dependsOn:[],grantIds:[],role:'WORK'},
    {key:'verify',bindingId:bindings.verify,objective:'Verify the exact repaired version',dependsOn:['repair'],grantIds:[],role:'VERIFY'}]}
  assert.equal(await runCloudTask(service,'task-test','agent',async()=>({text:'',calls:[{id:'plan',name:'task_plan',arguments:JSON.stringify(plan)}]})),true)
  const plans=new TaskPlanService(service)
  await plans.advance('task-test',task.id)
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM task_dispatches WHERE agent_id='verify'`)).rows[0].n,0)
  const repairChild=(await pool.query(`SELECT id FROM channel_tasks WHERE parent_task_id=$1 AND accountable_binding_id=$2`,[task.id,bindings.repair])).rows[0].id
  const childClaim=(await service.claim('task-test','repair','delegation-boundary'))!
  await assert.rejects(plans.propose('task-test',childClaim,plan),/DELEGATION_DEPTH_EXCEEDED/)
  await service.confirmStopped('task-test',childClaim.id,childClaim.generation,childClaim.token)
  await service.drive(principal,repairChild,'repair-after-boundary-check')
  assert.equal(await runCloudTask(service,'task-test','repair',async()=>({text:'PATCH_VERSION_EXACT',calls:[]})),true)
  const verifier=(await pool.query(`SELECT id FROM channel_tasks WHERE parent_task_id=$1 AND accountable_binding_id=$2`,[task.id,bindings.verify])).rows[0].id
  await assert.rejects(service.drive(principal,verifier,'skip-handoff'),/PLAN_HANDOFF_REQUIRED/)
  await plans.advance('task-test',task.id)
  assert.equal(await runCloudTask(service,'task-test','verify',async context=>{
    assert.ok(context.inputs.some(input=>input.content==='PATCH_VERSION_EXACT'))
    return {text:'VERIFIED_EXACT_PATCH',calls:[]}
  }),true)
  await plans.advance('task-test',task.id)
  assert.equal(await runCloudTask(service,'task-test','agent',async context=>{
    assert.ok(context.inputs.some(input=>input.content==='VERIFIED_EXACT_PATCH'))
    assert.ok(context.inputs.some(input=>input.content==='PATCH_VERSION_EXACT'))
    return {text:'Repair and verification complete.',calls:[]}
  }),true)
  assert.equal((await pool.query(`SELECT status FROM channel_tasks WHERE id=$1`,[task.id])).rows[0].status,'DELIVERED')
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM messages`)).rows[0].n,1)
  const reports=await pool.query(`SELECT a.input_version_ids,d.evidence_ids FROM task_deliveries d JOIN artifact_versions a ON a.id IN(SELECT jsonb_array_elements_text(d.artifact_ids)) WHERE d.task_id=$1`,[task.id])
  assert.ok(reports.rows[0].evidence_ids.length>0)
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM artifact_handoffs`)).rows[0].n,3)
  await service.reviseScope(principal,task.id,'A new authorized scope')
  await service.drive(principal,task.id,'second-plan')
  const nextPlan={parallelism:1,members:[{key:'new-work',bindingId:bindings.repair,objective:'Work on the second scope',dependsOn:[],grantIds:[],role:'WORK'}]}
  assert.equal(await runCloudTask(service,'task-test','agent',async()=>({text:'',calls:[{id:'next-plan',name:'task_plan',arguments:JSON.stringify(nextPlan)}]})),true)
  await plans.advance('task-test',task.id)
  assert.equal(await runCloudTask(service,'task-test','repair',async()=>({text:'NEW_SCOPE_PATCH',calls:[]})),true)
  await plans.advance('task-test',task.id)
  assert.equal(await runCloudTask(service,'task-test','agent',async context=>{assert.ok(context.inputs.some(input=>input.content==='NEW_SCOPE_PATCH'));assert.ok(!context.inputs.some(input=>input.content==='PATCH_VERSION_EXACT'));return {text:'Second scope delivered',calls:[]}}),true)
  assert.equal((await pool.query(`SELECT scope_revision,status FROM channel_tasks WHERE id=$1`,[task.id])).rows[0].scope_revision,2)
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM messages`)).rows[0].n,2)
})

test('schema 14 preparation remains LEGACY and refuses Task activation without creating tables',async()=>{
  const schema='task_schema14_test'
  await pool.query(`CREATE SCHEMA ${schema}`)
  const legacy=new Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`})
  try{
    await legacy.query(`CREATE TABLE schema_migrations (LIKE public.schema_migrations INCLUDING ALL)`)
    await legacy.query(`INSERT INTO schema_migrations SELECT * FROM public.schema_migrations WHERE version<=14`)
    await assert.rejects(verifySchemaCompatibility(legacy), /behind the supported range/)
    const preparation=new TaskService(legacy)
    assert.equal(await preparation.mode('missing-company'),'LEGACY')
    assert.equal(await preparation.protectsLegacy('missing-company'),false)
    await assert.rejects(preparation.prepare(principal),/TASK_SCHEMA_MIGRATION_REQUIRED/)
    assert.equal((await legacy.query(`SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema=$1`,[schema])).rows[0].n,1)
  }finally{await legacy.end();await pool.query(`DROP SCHEMA ${schema} CASCADE`)}
})

test('ordinary Board ingress binds an explicit work channel and rejects changed source or governance bypass',async()=>{
  await seed()
  await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id='task-test'`)
  const session=await apiSession()
  try{
    const board=(await session.request('/boards','POST',{title:'Task collaboration'})).body
    const detail=(await session.request(`/boards/${board.id}`)).body
    const card=(await session.request(`/boards/${board.id}/cards`,'POST',{title:'Read this board card',description:'BOARD_SOURCE_ONLY',columnId:detail.columns[0].id,assigneeId:'agent'})).body
    const ingress=new TaskIngressService(service)
    const task=await ingress.board(principal,'channel',card.id,[])
    assert.equal(task.board_card_id,card.id)
    assert.equal((await ingress.board(principal,'channel',card.id,[])).id,task.id)
    const claim=(await service.claim('task-test','agent','board-worker'))!
    const execution=new TaskExecutionService(service)
    assert.ok((await execution.context('task-test',claim)).inputs.some(input=>input.content.includes('BOARD_SOURCE_ONLY') && input.provenance.sources.some(source=>source.kind==='BOARD')))
    await pool.query(`UPDATE board_cards SET description='SOURCE_CHANGED' WHERE id=$1`,[card.id])
    await assert.rejects(execution.context('task-test',claim),/SOURCE_REVOKED/)
    await assert.rejects(ingress.board(principal,'other-channel',card.id,[]),/BINDING_INELIGIBLE/)
    await service.confirmStopped('task-test',claim.id,claim.generation,claim.token)
    const invalid=await session.request('/tasks/board','POST',{cardId:card.id})
    assert.equal(invalid.status,400)
  }finally{await session.close()}
})

test('device admission, revocation and stop reconciliation preserve retained versions and GC references',async()=>{
  const {task}=await seed()
  const workspace=new TaskWorkspaceService(service)
  const proof={computerId:'task-device',engine:'codex',binaryHash:'a'.repeat(64),verificationRef:'operator-reviewed-boundary-test',checks:{filesystem:true,environment:true,process:true,network:true,freshSession:true,stoppedChildren:true}}
  await pool.query(`INSERT INTO computers(id,company_id,name,kind,available_engines,status) VALUES('task-device','task-test','Task device','local','["codex"]','online')`)
  await assert.rejects(workspace.admit(principal,{...proof,engine:'unqualified'}),/RUNTIME_CAPABILITY_UNQUALIFIED/)
  await assert.rejects(workspace.admit(principal,{...proof,checks:{...proof.checks,network:false}}),/RUNTIME_CAPABILITY_UNQUALIFIED/)
  await assert.rejects(workspace.admit({companyId:'task-test',id:'observer'},proof),/ADMIN_REQUIRED/)
  await pool.query(`UPDATE participants SET computer_id='task-device',engine='codex' WHERE id='agent' AND company_id='task-test'`)
  await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id='task-test'`)
  await assert.rejects(service.drive(principal,task.id,'unqualified'),/RUNTIME_CAPABILITY_UNQUALIFIED/)
  await workspace.admit(principal,proof)
  await service.drive(principal,task.id,'admitted')
  const claim=(await service.claim('task-test','agent','local-supervisor'))!
  await assert.rejects(workspace.reconcileExecutor(principal,{dispatchId:claim.id,generation:claim.generation,proof:'Not actually stopped'}),/EXECUTOR_STILL_LEASED/)
  const execution=new TaskExecutionService(service)
  const artifact=await execution.artifact('task-test',claim,{content:'Retain this exact device output',mediaType:'text/plain'})
  await pool.query(`UPDATE computers SET revoked_at=NOW() WHERE id='task-device'`)
  await assert.rejects(execution.context('task-test',claim),/TASK_CONTEXT_REVOKED/)
  assert.equal((await pool.query(`SELECT state FROM task_dispatches WHERE id=$1`,[claim.id])).rows[0].state,'UNKNOWN')
  await workspace.reconcileExecutor(principal,{dispatchId:claim.id,generation:claim.generation,proof:'Operator inspected process tree and verified all children exited'})
  await service.cancel(principal,task.id)
  assert.equal(await workspace.gc(principal),0)
  await assert.rejects(pool.query(`DELETE FROM artifact_versions WHERE id=$1`,[artifact.id]),{code:'23514'})
  for(const id of ['expired-unreferenced','expired-referenced'])await pool.query(`INSERT INTO artifact_versions(id,artifact_id,company_id,task_id,producer_binding_id,media_type,content,content_hash,provenance,retention_until) SELECT $1,$1,company_id,task_id,producer_binding_id,media_type,content,content_hash,provenance,NOW()-INTERVAL '1 day' FROM artifact_versions WHERE id=$2`,[id,artifact.id])
  await pool.query(`INSERT INTO task_inputs(id,company_id,task_id,kind,reference_id,content,content_hash,provenance,input_revision) SELECT 'retained-reference',company_id,task_id,'ARTIFACT',id,convert_from(content,'UTF8'),content_hash,provenance,1 FROM artifact_versions WHERE id='expired-referenced'`)
  assert.equal(await workspace.gc(principal),1)
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM artifact_versions`)).rows[0].n,2)
})

test('publication races with grant revocation safely and queued outbox events survive publisher failure',async()=>{
  const {task,grant}=await seed()
  await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id='task-test'`)
  await service.drive(principal,task.id,'delivery')
  const claim=(await service.claim('task-test','agent','runner'))!
  const execution=new TaskExecutionService(service)
  const artifact=await execution.artifact('task-test',claim,{content:'Checked output',mediaType:'text/plain'})
  const outcomes=await Promise.allSettled([execution.deliver('task-test',claim,{key:'delivery',summary:'Checked output',artifactIds:[artifact.id]}),service.revokeGrant(principal,grant)])
  assert.equal(outcomes[1].status,'fulfilled')
  if(outcomes[0].status==='fulfilled'){
    const message=(await pool.query(`SELECT message_id FROM task_deliveries WHERE task_id=$1`,[task.id])).rows[0].message_id
    assert.equal(await execution.deliveryVisible('task-test',message),false)
    const failed=await drainRealtimeOutbox({publishFn:async()=>{throw new Error('Redis unavailable')}})
    assert.equal(failed.failed,1)
    await pool.query(`UPDATE realtime_outbox SET available_at=NOW()`)
    let publications=0
    const recovered=await drainRealtimeOutbox({publishFn:async()=>{publications++}})
    assert.equal(recovered.published,1);assert.equal(publications,1)
  }else{
    assert.match(String(outcomes[0].reason),/SOURCE_REVOKED/)
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM realtime_outbox`)).rows[0].n,0)
  }
  await service.confirmStopped('task-test',claim.id,claim.generation,claim.token)
})

test('external timeout after write is UNKNOWN and repeated requests never replay the effect',async()=>{
  const {task}=await seed()
  await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id='task-test'`)
  await service.drive(principal,task.id,'operation')
  const claim=(await service.claim('task-test','agent','runner'))!
  const context=await new TaskExecutionService(service).context('task-test',claim)
  const request={key:'publish-one',grantId:context.rootGrantIds[0],resource:'channel:channel',action:'publish',identity:'service:channel:channel',destination:'channel',payload:{body:'One write'}}
  const operations=new TaskOperationService(service)
  let writes=0
  await assert.rejects(operations.execute('task-test',claim,request,async()=>{writes++;throw new Error('timeout after acknowledged write')}),/EXTERNAL_OPERATION_UNKNOWN/)
  await assert.rejects(operations.execute('task-test',claim,request,async()=>{writes++;return {ok:true}}),/EXTERNAL_OPERATION_UNKNOWN/)
  await assert.rejects(operations.execute('task-test',claim,{...request,payload:{body:'Different'}},async()=>({ok:true})),/OPERATION_KEY_CONFLICT/)
  assert.equal(writes,1)
  const record=(await pool.query(`SELECT * FROM task_operation_records`)).rows[0]
  assert.equal(record.state,'UNKNOWN')
  await assert.rejects(operations.reconcile(principal,record.id,'SUCCEEDED','Observed one write and terminated sender',{ok:true}),/EXECUTOR_NOT_STOPPED/)
  await service.confirmStopped('task-test',claim.id,claim.generation,claim.token)
  await operations.reconcile(principal,record.id,'SUCCEEDED','Observed one write and terminated sender',{ok:true})
  assert.equal((await pool.query(`SELECT state FROM task_operation_records`)).rows[0].state,'SUCCEEDED')
})

test('offboarding revokes contexts, connections and knowledge publications without deleting retained artifacts',async()=>{
  const {task,grant}=await seed()
  await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id='task-test'`)
  await service.drive(principal,task.id,'offboard')
  const claim=(await service.claim('task-test','agent','runner'))!
  const execution=new TaskExecutionService(service)
  const artifact=await execution.artifact('task-test',claim,{content:'Retained evidence',mediaType:'text/plain'})
  await pool.query(`UPDATE participants SET departed_at=NOW() WHERE company_id='task-test' AND id='owner'`)
  await assert.rejects(execution.context('task-test',claim),/TASK_CONTEXT_REVOKED/)
  assert.ok((await pool.query(`SELECT revoked_at FROM access_grants WHERE id=$1`,[grant])).rows[0].revoked_at)
  assert.equal((await pool.query(`SELECT state FROM task_dispatches WHERE id=$1`,[claim.id])).rows[0].state,'UNKNOWN')
  await assert.rejects(pool.query(`DELETE FROM artifact_versions WHERE id=$1`,[artifact.id]),{code:'23514'})
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM artifact_versions`)).rows[0].n,1)
})

test('copied bundles and unauthorized automation cannot widen channel authority',async()=>{
  const {grant,binding}=await seed()
  const bundle=await service.bundle(principal,'common',[grant])
  await service.referenceBundle(principal,'channel',bundle)
  await assert.rejects(service.bundle({...principal,id:'observer'},'copied',[grant]),/GRANT_CALLER_DENIED/)
  await assert.rejects(service.referenceBundle(principal,'other-channel',bundle),/BUNDLE_NOT_APPLICABLE/)
  const ingress=new TaskIngressService(service)
  await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id='task-test'`)
  assert.equal(await ingress.synthetic('task-test','agent','idle',null,'Work'),false)
  assert.equal(await ingress.synthetic('task-test','agent','idle','channel','Work'),false)
  await assert.rejects(new TaskWorkspaceService(service).automation(principal,{channelId:'channel',bindingId:binding,reason:'idle',grantIds:[grant],key:'idle-one'}),/AUTOMATION_AUTHORITY_REQUIRED/)
  const rule={resource:'channel:channel',actions:['read','publish','automate:idle'],identity:'service:channel:channel',audience:{kind:'CHANNEL',id:'channel'},destinations:['task-model','artifact','channel'],expiresAt:'2099-01-01T00:00:00Z'}
  const automationGrant=await service.grantChannel(principal,'channel',rule)
  await new TaskWorkspaceService(service).automation(principal,{channelId:'channel',bindingId:binding,reason:'idle',grantIds:[automationGrant],key:'idle-one'})
  assert.equal(await ingress.synthetic('task-test','agent','idle','channel','Check the channel','tick-1'),true)
  assert.equal(await ingress.synthetic('task-test','agent','idle','channel','Check the channel','tick-1'),true)
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM channel_tasks WHERE ingress_key LIKE 'automation:%'`)).rows[0].n,1)
})

test('governed Task keeps mandates and hard budgets, maps immutable artifacts once and never finalizes its Card',async()=>{
  const {binding}=await seed()
  process.env.NODE_ENV='test'
  process.env.CUMORA_MODEL_PRICES_JSON=JSON.stringify({'task-budget-test':{inPer1M:1,cachedInPer1M:0.1,cacheWritePer1M:1,outPer1M:2}})
  await pool.query(`UPDATE users SET tier='pro' WHERE id='owner'`)
  const session=await apiSession()
  const request=async(path:string,body:unknown)=>{const reply=await session.request(path,'POST',body);assert.ok(reply.status<300,`${path}: ${JSON.stringify(reply.body)}`);return reply.body}
  try{
    const board=await request('/boards',{title:'Task governance'})
    const snapshot=(await session.request(`/boards/${board.id}`)).body
    const card=await request(`/boards/${board.id}/cards`,{title:'Governed repair',columnId:snapshot.columns.find((column:any)=>column.kind==='todo').id})
    const role=await request('/governance/roles',{name:'Task sponsor',responsibilityScope:'Task artifact acceptance',grantableGrants:[
      {resourceType:'CARD',resourceId:card.id,operation:'card.read'},
      {resourceType:'CARD',resourceId:card.id,operation:'card.action.create'},
      {resourceType:'CARD',resourceId:card.id,operation:'artifact.publish'},
    ]})
    await request(`/governance/roles/${role.id}/assignments`,{humanUserId:'owner',expectedVersion:1})
    const upgraded=await request(`/governance/cards/${card.id}/upgrade`,{accountableRoleId:role.id,agentId:'agent',definitionOfDone:'Independent review and Primary acceptance',deadline:new Date(Date.now()+86400000).toISOString(),budgetLimitMicrousd:1000000,modelCallLimit:3,expectedVersion:0})
    await assert.rejects(new TaskIngressService(service).board(principal,'channel',card.id,[]),/GOVERNANCE_MAPPING_REQUIRED/)
    const action=await request(`/governance/cards/${card.id}/actions`,{agentId:'agent',mandateId:upgraded.mandateId,mandateVersion:1,objective:'Produce governed evidence',grants:[],expectedVersion:1,expectedEpoch:1})
    const assignment=(await pool.query(`SELECT runtime_assignment_id FROM participants WHERE company_id='task-test' AND id='agent'`)).rows[0].runtime_assignment_id
    await request(`/governance/cards/${card.id}/claim`,{agentId:'agent',mandateId:upgraded.mandateId,expectedEpoch:1})
    const attempt=await request(`/governance/actions/${action.id}/attempts`,{runtimeAssignmentId:assignment,planEpoch:1,mandateId:upgraded.mandateId,mandateVersion:1})
    await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id='task-test'`)
    const task=await service.create(principal,{channelId:'channel',bindingId:binding,objective:'Produce governed evidence',ingressKey:'governed-task',grantIds:[],boardCardId:card.id,governanceActionId:action.id,governanceAttemptId:attempt.id})
    await service.drive(principal,task.id,'governed')
    const claim=(await service.claim('task-test','agent','governed-runner'))!
    const execution=new TaskExecutionService(service)
    const artifact=await execution.artifact('task-test',claim,{content:'Governed immutable evidence',mediaType:'text/plain'})
    const bridge=(await pool.query(`SELECT a.governance_version_id,g.content_hash FROM artifact_versions a JOIN governance_artifact_versions g ON g.version_id=a.governance_version_id WHERE a.id=$1`,[artifact.id])).rows[0]
    assert.equal(bridge.content_hash,artifact.hash)
    assert.equal(await execution.importGovernance(principal,task.id,bridge.governance_version_id,'Governed immutable evidence'),artifact.id)
    assert.equal(await execution.importGovernance(principal,task.id,bridge.governance_version_id,'Governed immutable evidence'),artifact.id)
    await assert.rejects(execution.importGovernance(principal,task.id,bridge.governance_version_id,'Wrong bytes'),/ARTIFACT_HASH_MISMATCH/)
    await service.confirmStopped('task-test',claim.id,claim.generation,claim.token)
    await service.drive(principal,task.id,'with-evidence')
    const current=(await service.claim('task-test','agent','governed-runner'))!
    const runId='task-governance-budget-run'
    await pool.query(`INSERT INTO agent_runs(id,agent_id,company_id,task_id,task_context_id,governance_attempt_id,trigger,status) VALUES($1,'agent','task-test',$2,$3,$4,'{}','running')`,[runId,task.id,current.contextId,attempt.id])
    const {governedTaskModelCall}=await import('../tasks/governance.js')
    let invoked=0
    await governedTaskModelCall(pool,task,'agent',runId,'task-budget-test',{input:'evidence'},async()=>{invoked++;return {usage:{input_tokens:20,output_tokens:10,input_tokens_details:{cached_tokens:0}}}})
    assert.equal(invoked,1)
    const budget=(await pool.query(`SELECT * FROM governance_budget_accounts WHERE id=(SELECT budget_account_id FROM governance_actions WHERE id=$1)`,[action.id])).rows[0]
    assert.equal(Number(budget.model_calls_spent),1);assert.equal(Number(budget.spent_microusd),40)
    const output=await execution.artifact('task-test',current,{content:'Final governed report',mediaType:'text/plain'})
    const before=(await pool.query(`SELECT governance_state,column_id,accepted_submission_id FROM board_cards WHERE id=$1`,[card.id])).rows[0]
    await execution.deliver('task-test',current,{key:'governed-report',summary:'Evidence produced; review still required.',artifactIds:[output.id]})
    assert.deepEqual((await pool.query(`SELECT governance_state,column_id,accepted_submission_id FROM board_cards WHERE id=$1`,[card.id])).rows[0],before)
    await service.confirmStopped('task-test',current.id,current.generation,current.token)
    await pool.query(`UPDATE governance_budget_accounts SET limit_microusd=spent_microusd WHERE id=$1`,[budget.id])
    await assert.rejects(governedTaskModelCall(pool,task,'agent',runId,'task-budget-test',{input:'blocked'},async()=>{invoked++;return {usage:{input_tokens:1,output_tokens:1}}}),/hard budget exhausted/)
    assert.equal(invoked,1)
    await pool.query(`UPDATE governance_mandates SET status='REVOKED' WHERE id=$1`,[upgraded.mandateId])
    await assert.rejects(service.create(principal,{channelId:'channel',objective:'No mandate bypass',ingressKey:'revoked-governed',grantIds:[],boardCardId:card.id,governanceActionId:action.id,governanceAttemptId:attempt.id}),/GOVERNANCE_AUTHORITY_REVOKED/)
  }finally{await session.close()}
})

test('configuration API projects accessible channels and immutable definition versions without runtime credentials',async()=>{
  const {definition}=await seed()
  await pool.query(`INSERT INTO conversations(id,company_id,kind,title,members) VALUES('hidden-channel','task-test','group','Hidden','["observer","agent"]')`)
  const session=await apiSession()
  try{
    const result=await session.request('/tasks/configuration')
    assert.equal(result.status,200);assert.match(result.body.definitions.find((row:any)=>row.id===definition).body.instructions,/Work only/)
    assert.deepEqual(result.body.channels.map((row:any)=>row.id).sort(),['channel','other-channel'])
    assert.ok(result.body.bindings.every((row:any)=>row.channel_id!=='hidden-channel'))
    assert.doesNotMatch(JSON.stringify(result.body),/device_token|claim_token|credential_ref|password_hash/)
    await pool.query(`UPDATE company_members SET role='member' WHERE company_id='task-test' AND user_id='owner'`)
    assert.equal((await session.request('/tasks/configuration')).status,403)
  }finally{await session.close()}
})

test('default Binding changes atomically while existing Task snapshots and failed edits retain their responsible Agent',async()=>{
  const {definition,binding,task}=await seed()
  await pool.query(`INSERT INTO participants(id,company_id,kind,name,initial,avatar_bg,status) VALUES('agent-two','task-test','agent','Second','T','#fff','avail')`)
  await pool.query(`INSERT INTO conversation_members(conversation_id,company_id,participant_id,ordinal) VALUES('channel','task-test','agent-two',3)`)
  const second=await service.bind(principal,{channelId:'channel',agentId:'agent-two',definitionVersionId:definition,alias:'Second',isDefault:true})
  const defaultId=async()=>(await pool.query(`SELECT id FROM channel_agent_bindings WHERE company_id='task-test' AND conversation_id='channel' AND status='ACTIVE' AND is_default`)).rows.map(row=>row.id)
  assert.deepEqual(await defaultId(),[second])
  assert.equal((await pool.query(`SELECT accountable_binding_id FROM channel_tasks WHERE id=$1`,[task.id])).rows[0].accountable_binding_id,binding)
  await service.editBinding(principal,binding,{definitionVersionId:definition,alias:'Aida',isDefault:true})
  assert.deepEqual(await defaultId(),[binding])
  await assert.rejects(service.editBinding(principal,second,{definitionVersionId:'not-a-definition',alias:'Second',isDefault:true}),{code:'23503'})
  assert.deepEqual(await defaultId(),[binding])
  const created=await service.create(principal,{channelId:'channel',objective:'New default',ingressKey:'new-default',grantIds:[]})
  assert.equal(created.accountable_binding_id,binding)
})

test('Codex login model permits enforce admission, tools, receipt deduplication and live context',async()=>{
  const {task}=await seed()
  const {authorizeLocalModel,settleLocalModel}=await import('../tasks/local-model.js')
  await pool.query(`INSERT INTO computers(id,company_id,name,kind,status,available_engines) VALUES('local-login','task-test','Local login','local','online','["codex"]')`)
  await pool.query(`UPDATE participants SET computer_id='local-login',engine='codex',model='gpt-6-sol' WHERE id='agent' AND company_id='task-test'`)
  const workspace=new TaskWorkspaceService(service)
  const admission={computerId:'local-login',engine:'codex',binaryHash:'a'.repeat(64),verificationRef:'unit permit fixture, not native qualification',checks:{filesystem:true,environment:true,process:true,network:true,freshSession:true,stoppedChildren:true}}
  await workspace.admit(principal,admission)
  await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id='task-test'`)
  await service.drive(principal,task.id,'model-permit')
  const claim=(await service.claim('task-test','agent','permit-fixture'))!
  await assert.rejects(authorizeLocalModel(service,'task-test','agent',claim,{input:[]}),/LOCAL_MODEL_PROVIDER_NOT_ADMITTED/)
  await pool.query(`UPDATE task_runtime_admissions SET capabilities=capabilities||'{"modelProvider":"codex-login"}'::jsonb WHERE company_id='task-test' AND computer_id='local-login'`)
  await assert.rejects(authorizeLocalModel(service,'task-test','agent',claim,{input:[],tools:[{type:'web_search'}]}),/RUNTIME_MODEL_TOOL_DENIED/)
  await assert.rejects(authorizeLocalModel(service,'task-test','agent',claim,{input:[],previous_response_id:'other-task'}),/RUNTIME_PREVIOUS_RESPONSE_DENIED/)
  const permit=await authorizeLocalModel(service,'task-test','agent',claim,{model:'unapproved-model',input:[{role:'user',content:'Approved task input'}],store:true})
  assert.notEqual(permit.request.model,'unapproved-model');assert.equal(permit.request.store,false)
  assert.equal(permit.request.model,'gpt-6-sol')
  const {taskRuntimeModel}=await import('../tasks/local-model.js')
  assert.equal(await taskRuntimeModel(service,await new TaskExecutionService(service).context('task-test',claim),claim.contextId),permit.request.model)
  assert.equal((await pool.query(`SELECT references_json->>'model' AS model FROM task_authorization_events WHERE id=$1`,[permit.permitId])).rows[0].model,permit.request.model)
  const receipt={permitId:permit.permitId,status:'ok',usage:{input_tokens:10,output_tokens:5},latencyMs:100}
  await settleLocalModel(service,'task-test','agent',claim,receipt)
  await settleLocalModel(service,'task-test','agent',claim,receipt)
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM llm_calls WHERE company_id='task-test' AND extras->>'permitId'=$1`,[permit.permitId])).rows[0].n,1)
  await assert.rejects(settleLocalModel(service,'task-test','agent',claim,{...receipt,latencyMs:101}),/MODEL_RECEIPT_CONFLICT/)
  await service.cancel(principal,task.id)
  await assert.rejects(settleLocalModel(service,'task-test','agent',claim,receipt),/TASK_CONTEXT_REVOKED/)
  await service.confirmStopped('task-test',claim.id,claim.generation,claim.token)
})
