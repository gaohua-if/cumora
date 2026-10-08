import assert from 'node:assert/strict'
import { before, beforeEach, after, test } from 'node:test'
import { pool } from '../db/pool.js'
import { env } from '../env.js'
import { ensureSchemaOnce, resetAllTables, teardownAll, seedUserMembership, buildApiTestApp } from './_helpers.js'
import { TaskService } from '../tasks/service.js'
import { TaskExecutionService } from '../tasks/execution.js'
import { TaskWorkspaceService } from '../tasks/workspace.js'
import { TaskIngressService } from '../tasks/ingress.js'
import { authorizeLocalModel, taskRuntimeModel } from '../tasks/local-model.js'
import { inprocClient } from '../agents/runtime/inproc-client.js'

before(ensureSchemaOnce); beforeEach(resetAllTables); after(async () => { await teardownAll() })
const actor = { companyId: 'keyless-test', id: 'keyless-owner' }
const tasks = new TaskService(pool)
const group = 'keyless-group'
async function fixture() {
  await pool.query(`INSERT INTO companies(id,name,slug,owner_user_id) VALUES($1,'Keyless',$1,$2)`, [actor.companyId, actor.id])
  await seedUserMembership(actor.id, actor.companyId)
  await pool.query(`UPDATE company_members SET role='owner' WHERE company_id=$1 AND user_id=$2`, [actor.companyId, actor.id])
  await pool.query(`INSERT INTO computers(id,company_id,name,kind,status,available_engines,detected_engines) VALUES('keyless-local',$1,'Local','local','online','["codex"]',$2)`, [actor.companyId, JSON.stringify([{id:'codex',modelCatalog:{source:'protocol',models:[{id:'account-model',name:'Account model'}],defaultModel:'account-model',defaultFastModel:null,fastModelScope:'none'}}])])
  for (const [id,name] of [['route-aida','Aida'],['route-worker','Worker'],['route-worker-long','工程师']]) {
    await pool.query(`INSERT INTO participants(id,company_id,kind,name,initial,avatar_bg,status,computer_id,engine) VALUES($1,$2,'agent',$3,'A','#fff','avail','keyless-local','codex')`, [id,actor.companyId,name])
  }
  await pool.query(`INSERT INTO conversations(id,company_id,kind,title,members) VALUES($1,$2,'group','Routing',$3),('keyless-dm',$2,'direct','Direct',$4)`, [group,actor.companyId,JSON.stringify([actor.id,'route-aida','route-worker','route-worker-long']),JSON.stringify([actor.id,'route-worker'])])
  const definition = await tasks.define(actor,'route-definition',{name:'Agent',instructions:'Handle the current task',role:'WORK'})
  const bindings: Record<string,string> = {}
  for (const [id,alias] of [['route-aida','Aida'],['route-worker','Reviewer'],['route-worker-long','工程师']]) {
    bindings[id]=await tasks.bind(actor,{channelId:group,agentId:id,definitionVersionId:definition,alias,isDefault:id==='route-aida'})
  }
  return bindings
}
let counter=0
async function message(body:string, author=actor.id, quoted?:string, channel=group, kind='text') {
  const id='route-message-'+(++counter)
  return (await pool.query(`INSERT INTO messages(id,company_id,conversation_id,author_id,body,kind,sequence,quoted_message_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[id,actor.companyId,channel,author,body,kind,counter,quoted??null])).rows[0]
}

test('all writers persist default, exact ID/name/alias, quote and explicit broadcast recipients', async () => {
  await fixture()
  assert.deepEqual((await message('ordinary work')).work_recipient_ids,['route-aida'])
  for (const body of ['@route-worker help','@Worker help','@Reviewer help']) assert.deepEqual((await message(body)).work_recipient_ids,['route-worker'])
  assert.deepEqual((await message('@工程师 分析')).work_recipient_ids,['route-worker-long'])
  for (const body of ['mail x@Worker about it','@route-worker-longer help','@WorkerSuffix help']) assert.deepEqual((await message(body)).work_recipient_ids,['route-aida'])
  assert.deepEqual((await message('@route-worker-long help')).work_recipient_ids,['route-worker-long'])
  assert.deepEqual(new Set((await message('@all review')).work_recipient_ids),new Set(['route-aida','route-worker','route-worker-long']))
  const reply=await message('worker result','route-worker')
  assert.deepEqual(reply.work_recipient_ids,['route-aida'])
  assert.deepEqual((await message('continue',actor.id,reply.id)).work_recipient_ids,['route-worker'])
  assert.deepEqual((await message('finished','route-aida')).work_recipient_ids,[])
  assert.deepEqual((await message('finished','route-aida',reply.id)).work_recipient_ids,[])
  assert.deepEqual((await message('@Worker continue','route-aida',reply.id)).work_recipient_ids,['route-worker'])
  assert.deepEqual((await message('direct',actor.id,undefined,'keyless-dm')).work_recipient_ids,['route-worker'])
  const old=await message('before default edit')
  await pool.query(`UPDATE channel_agent_bindings SET is_default=FALSE WHERE company_id=$1 AND conversation_id=$2`,[actor.companyId,group])
  await pool.query(`UPDATE channel_agent_bindings SET is_default=TRUE WHERE company_id=$1 AND conversation_id=$2 AND agent_id='route-worker'`,[actor.companyId,group])
  assert.deepEqual((await message('after default edit')).work_recipient_ids,['route-worker'])
  assert.deepEqual((await pool.query(`SELECT work_recipient_ids FROM messages WHERE id=$1`,[old.id])).rows[0].work_recipient_ids,['route-aida'])
})

test('reconnect inbox filters before its limit, preserves explicit mute exceptions and system notices', async () => {
  await fixture()
  for(let i=0;i<205;i++)await message('default work '+i)
  const target=await message('@Reviewer targeted work')
  assert.deepEqual((await inprocClient.loadInbox('route-worker')).map(row=>row.id),[target.id])
  await pool.query(`INSERT INTO conversation_mutes(user_id,conversation_id) VALUES('route-worker',$1)`,[group])
  assert.deepEqual((await inprocClient.loadInbox('route-worker')).map(row=>row.id),[target.id])
  const notice=await message('system change',actor.id,undefined,group,'system')
  await pool.query(`UPDATE messages SET delivery_recipient_id='route-worker' WHERE id=$1`,[notice.id])
  assert.ok((await inprocClient.loadInbox('route-worker')).some(row=>row.id===notice.id))
})

test('Task ingress follows durable exact targets instead of mention prefixes', async () => {
  const bindings=await fixture()
  await tasks.prepare(actor)
  await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id=$1`,[actor.companyId])
  const precise=await message('@route-worker-long help')
  const taskId=await tasks.transaction(actor.companyId,client=>new TaskIngressService(tasks).message(client,actor,precise.id,'new'))
  const task=(await pool.query(`SELECT accountable_binding_id FROM channel_tasks WHERE id=$1`,[taskId])).rows[0]
  assert.equal(task.accountable_binding_id,bindings['route-worker-long'])
})

test('keyless local permits use account models, preserve request hash and reject server dispatch', async () => {
  await fixture(); const prior=env.LOCAL_ONLY;env.LOCAL_ONLY=true
  try {
    await tasks.prepare(actor)
    const workspace=new TaskWorkspaceService(tasks)
    const admission={computerId:'keyless-local',engine:'codex',binaryHash:'a'.repeat(64),verificationRef:'isolated DB fixture',checks:{filesystem:true,environment:true,process:true,network:true,freshSession:true,stoppedChildren:true}}
    await workspace.admit(actor,admission)
    await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id=$1`,[actor.companyId])
    const task=await tasks.create(actor,{channelId:group,objective:'local work',ingressKey:'keyless-local',grantIds:[]})
    await assert.rejects(tasks.drive(actor,task.id,'no-key-server'),/SERVER_MODEL_UNAVAILABLE/)
    await workspace.admit(actor,{...admission,modelProvider:'codex-login'})
    assert.ok(!(await tasks.transaction(actor.companyId,client=>workspace.readiness(client,actor.companyId))).includes('SERVER_MODEL_UNAVAILABLE'))
    await tasks.drive(actor,task.id,'local-login')
    const claim=(await tasks.claim(actor.companyId,'route-aida','local-test'))!
    assert.ok(claim)
    const context=await new TaskExecutionService(tasks).context(actor.companyId,claim)
    assert.equal(await taskRuntimeModel(tasks,context,claim.contextId),'account-model')
    const permit=await authorizeLocalModel(tasks,actor.companyId,'route-aida',claim,{input:[],model:'unapproved'})
    assert.equal(permit.request.model,'account-model')
    const {hashContent,canonicalJson}=await import('../tasks/contracts.js')
    const refs=(await pool.query(`SELECT references_json FROM task_authorization_events WHERE id=$1`,[permit.permitId])).rows[0].references_json
    assert.equal(refs.model,permit.request.model);assert.equal(refs.requestHash,hashContent(canonicalJson(permit.request)))
  } finally {env.LOCAL_ONLY=prior}
})

test('keyless configuration and image errors disclose capability without credentials; memory still works', async () => {
  await fixture();const prior=env.LOCAL_ONLY;env.LOCAL_ONLY=true
  const app=await buildApiTestApp(actor.id),server=app.listen(0,'127.0.0.1')
  await new Promise<void>(resolve=>server.once('listening',resolve))
  const address=server.address();assert.ok(address&&typeof address!=='string')
  const request=(path:string,method='GET')=>fetch(`http://127.0.0.1:${address.port}/api${path}`,{method,headers:{'x-company-id':actor.companyId,'content-type':'application/json'}})
  try {
    const response=await request('/tasks/workbench');assert.equal(response.status,200)
    const data=await response.json() as any;assert.equal(data.runtime.mode,'local-only');assert.equal(data.runtime.serverInference,false)
    const image=await request('/agents/route-aida/avatar/generate','POST')
    assert.equal(image.status,503);assert.deepEqual(await image.json(),{error:'SERVER_MODEL_UNAVAILABLE'})
    const {gateSyntheticWake}=await import('../agents/inbox-triage.js')
    assert.equal((await gateSyntheticWake({companyId:actor.companyId,personaName:'Aida',kind:'idle',brief:'',signals:'due work'})).act,false)
    await pool.query(`UPDATE participants SET computer_id=NULL,engine='managed' WHERE id='route-worker' AND company_id=$1`,[actor.companyId])
    const {wakeAgent}=await import('../agents/scheduler.js')
    assert.equal(await wakeAgent('route-worker','manual',group),false)
    await pool.query(`INSERT INTO agent_workspace(agent_id,path,body,meta,company_id) VALUES('route-aida','memory/note/one.md','Remember local work','{"pinned":true}',$1)`,[actor.companyId])
    assert.ok((await inprocClient.loadMemory('route-aida','local work')).some(row=>row.body==='Remember local work'))
  } finally {env.LOCAL_ONLY=prior;await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
