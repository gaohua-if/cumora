import {test,before,beforeEach,after} from 'node:test'
import assert from 'node:assert/strict'
import {pool} from '../db/pool.js'
import {ensureSchemaOnce,resetAllTables,teardownAll,buildApiTestApp} from './_helpers.js'
import {TaskService} from '../tasks/service.js'
import {TaskIngressService} from '../tasks/ingress.js'
import {dispatchEvent,type CalendarEventRow} from '../calendar.js'
import {wakeAgent,fanOutWake,claimAndWake} from '../agents/scheduler.js'
import {inprocClient} from '../agents/runtime/inproc-client.js'
import {runCli} from '../agents/cli.js'
import {processDocMention,resolveWsEventRecipientUserIds,attachWebSocket} from '../ws.js'
import express from 'express'
import OpenAI from 'openai'
import Redis from 'ioredis'
import {runCloudTask} from '../tasks/runner.js'
import {__setLlmClientOverrideForTesting} from '../llm.js'
import {drainRealtimeOutbox} from '../realtime-outbox.js'
import {CH_MESSAGE_NEW,redis,sub,type MessageNewEvent} from '../redis.js'
import {TaskWorkspaceService} from '../tasks/workspace.js'
import {createWsTicket} from '../auth.js'
import WebSocket from 'ws'
import {TaskExecutionService} from '../tasks/execution.js'
import {TaskPlanService} from '../tasks/plans.js'
import {hashContent} from '../tasks/contracts.js'
import {addConversationMember,removeConversationMember} from '../agents/membership.js'

before(ensureSchemaOnce);beforeEach(resetAllTables);after(async()=>{await teardownAll()})
const tasks=new TaskService(pool)
const principal={companyId:'task-entry-test',id:'entry-owner'}
async function seed(){
  await pool.query(`INSERT INTO companies(id,name,slug,owner_user_id) VALUES($1,'Task entries',$1,$2)`,[principal.companyId,principal.id])
  await pool.query(`INSERT INTO users(id,email,display_name) VALUES($1,'entry@task.test','Entry owner')`,[principal.id])
  await pool.query(`INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner')`,[principal.companyId,principal.id])
  for(const [id,kind]of [[principal.id,'human'],['entry-agent','agent']])await pool.query(`INSERT INTO participants(id,company_id,kind,name,initial,avatar_bg,status)VALUES($1,$2,$3,$1,'E','#fff','avail')`,[id,principal.companyId,kind])
  await pool.query(`INSERT INTO conversations(id,company_id,kind,title,members)VALUES('entry-channel',$1,'group','Entries','["entry-owner","entry-agent"]')`,[principal.companyId])
  await tasks.prepare(principal)
  const definition=await tasks.define(principal,'entries',{instructions:'Approved entry task'})
  await tasks.bind(principal,{channelId:'entry-channel',agentId:'entry-agent',definitionVersionId:definition,alias:'Worker',isDefault:true})
  await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id=$1`,[principal.companyId])
}

test('calendar enters one explicit Channel Task and blocks missing/private/paused destinations',async()=>{
  await seed()
  const now=new Date()
  const create=async(id:string,target:string|null,isPrivate=false)=>{
    const result=await pool.query<CalendarEventRow>(`INSERT INTO calendar_events(id,company_id,created_by,kind,title,assignee_id,target_conversation_id,agent_prompt,start_at,is_private,status)VALUES($1,$2,$3,'agent_task','Calendar Task','entry-agent',$4,'Approved calendar objective',$5,$6,'active') RETURNING *`,[id,principal.companyId,principal.id,target,now,isPrivate])
    return result.rows[0]
  }
  assert.equal((await dispatchEvent(await create('missing-channel',null),now)).error,'TASK_CHANNEL_REQUIRED')
  assert.equal((await dispatchEvent(await create('private-channel','entry-channel',true),now)).error,'PRIVATE_CALENDAR_AUDIENCE_DENIED')
  const event=await create('qualified-event','entry-channel')
  assert.equal((await dispatchEvent(event,now)).status,'dispatched')
  assert.equal((await dispatchEvent(event,now)).status,'duplicate')
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM channel_tasks`)).rows[0].n,1)
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM messages`)).rows[0].n,0)
  await pool.query(`UPDATE task_workspace_settings SET mode='PREPARING' WHERE company_id=$1`,[principal.companyId])
  assert.equal((await dispatchEvent(await create('paused-event','entry-channel'),now)).error,'TASK_WORKSPACE_PAUSED')
})

test('scheduler, WS mentions and retained-workspace deletion cannot bypass Task ingress',async()=>{
  await seed()
  for(const reason of ['manual','idle','background_scan','poll.updated'] as const)assert.equal(await wakeAgent('entry-agent',reason,'entry-channel'),false)
  assert.equal(await wakeAgent('entry-agent','manual',null),false)
  await fanOutWake(['entry-agent'],'entry-channel',null)
  await pool.query(`INSERT INTO documents(id,company_id,title,created_by) VALUES('entry-document',$1,'Restricted raw document',$2)`,[principal.companyId,principal.id])
  await processDocMention({documentId:'entry-document',companyId:principal.companyId,mentionerId:principal.id,requestedIds:['entry-agent']})
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM channel_tasks`)).rows[0].n,0)
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM conversations WHERE kind='direct'`)).rows[0].n,0)
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM task_authorization_events WHERE operation='ingress:doc.mention' AND outcome='TASK_DOCUMENT_INPUT_REQUIRED'`)).rows[0].n,1)
  await pool.query(`INSERT INTO messages(id,company_id,conversation_id,author_id,kind,body,sequence)VALUES('entry-unqualified-message',$1,'entry-channel',$2,'text','Unqualified native work',1)`,[principal.companyId,principal.id])
  const blocked=await tasks.create(principal,{channelId:'entry-channel',objective:'Unqualified native work',ingressKey:'unqualified-native',messageId:'entry-unqualified-message',grantIds:[]})
  await pool.query(`UPDATE participants SET engine='codex' WHERE company_id=$1 AND id='entry-agent'`,[principal.companyId])
  await new TaskIngressService(tasks).scheduleMessage(principal.companyId,'entry-unqualified-message')
  assert.deepEqual((await pool.query(`SELECT status,blocked_code FROM channel_tasks WHERE id=$1`,[blocked.id])).rows[0],{status:'BLOCKED',blocked_code:'RUNTIME_CAPABILITY_UNQUALIFIED'})
  await pool.query(`UPDATE participants SET engine=NULL WHERE company_id=$1 AND id='entry-agent'`,[principal.companyId])
  const task=await tasks.create(principal,{channelId:'entry-channel',objective:'Retained task',ingressKey:'retained',grantIds:[]})
  await tasks.cancel(principal,task.id)
  const app=await buildApiTestApp(principal.id)
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve))
  try{
    const address=server.address();assert.ok(address && typeof address!=='string')
    const legacyConvene=await fetch(`http://127.0.0.1:${address.port}/api/conversations/entry-channel/convene`,{method:'POST',headers:{'x-company-id':principal.companyId,'content-type':'application/json'},body:JSON.stringify({topic:'Cannot read raw history in Task mode'})})
    assert.equal(legacyConvene.status,403)
    assert.equal(((await legacyConvene.json()) as {error:string}).error,'TASK_CONTEXT_REQUIRED')
    assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM convene_sessions`)).rows[0].n,0)
    const response=await fetch(`http://127.0.0.1:${address.port}/api/companies/${principal.companyId}`,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({confirmation:'Task entries'})})
    assert.equal(response.status,409);assert.match((await response.json() as {error:string}).error,/retained task/)
    assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM channel_tasks WHERE id=$1`,[task.id])).rows[0].n,1)
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
  // Delivery is not TRIGGER/SUPPLEMENT, so durable scheduler replay is inert.
  await pool.query(`INSERT INTO convene_sessions(id,company_id,conversation_id,title,started_by,state) VALUES('old-live-convene',$1,'entry-channel','Old live',$2,'live')`,[principal.companyId,principal.id])
  const failures=await tasks.transaction(principal.companyId,client=>new TaskWorkspaceService(tasks).readiness(client,principal.companyId))
  assert.ok(failures.includes('LEGACY_CONVENE_RUNNING'))
  await new TaskIngressService(tasks).scheduleMessage(principal.companyId,'unknown-delivery-message')
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM task_dispatches`)).rows[0].n,0)
})

test('default cloud SDK gateway tracks calls and a real Redis disconnect recovers the durable delivery without new work',async()=>{
  await seed()
  const task=await tasks.create(principal,{channelId:'entry-channel',objective:'Only approved cloud context',ingressKey:'tracked-cloud',grantIds:[]})
  await tasks.drive(principal,task.id,'tracked-cloud')
  const provider=express();provider.use(express.json())
  let modelCalls=0
  provider.post('/v1/responses',(req,res)=>{
    modelCalls++
    assert.equal(req.body.store,false)
    assert.ok(JSON.stringify(req.body.input).includes('Only approved cloud context'))
    assert.ok(!JSON.stringify(req.body).includes('task-test-key'))
    res.json({id:'resp-task-tracked',object:'response',created_at:Math.floor(Date.now()/1000),model:req.body.model,status:'completed',output:[{id:'msg-task-tracked',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'TRACKED_CLOUD_RESPONSE',annotations:[]}]}],usage:{input_tokens:20,output_tokens:5,total_tokens:25,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}})
  })
  const server=provider.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve))
  const address=server.address();assert.ok(address && typeof address!=='string')
  const publisher=new Redis(process.env.REDIS_URL!,{lazyConnect:true,enableOfflineQueue:false,retryStrategy:()=>null})
  const subscriber=new Redis(process.env.REDIS_URL!,{lazyConnect:true,enableOfflineQueue:false,retryStrategy:()=>null})
  try{
    __setLlmClientOverrideForTesting(()=>new OpenAI({apiKey:'fixture-key',baseURL:`http://127.0.0.1:${address.port}/v1`}))
    assert.equal(await runCloudTask(tasks,principal.companyId,'entry-agent'),true)
    assert.equal(modelCalls,1)
    const ledger=(await pool.query(`SELECT extras FROM llm_calls WHERE company_id=$1`,[principal.companyId])).rows
    assert.equal(ledger.length,1);assert.equal(ledger[0].extras.taskId,task.id)
    await publisher.connect();await subscriber.connect();await subscriber.subscribe(CH_MESSAGE_NEW)
    publisher.disconnect()
    assert.equal((await drainRealtimeOutbox({publishFn:(channel,payload)=>publisher.publish(channel,JSON.stringify(payload)).then(()=>{})})).failed,1)
    await pool.query(`UPDATE realtime_outbox SET available_at=NOW()`)
    await publisher.connect()
    const observed=new Promise<{message:{id:string}}>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Redis delivery not observed')),5000);subscriber.once('message',(_channel,payload)=>{clearTimeout(timeout);resolve(JSON.parse(payload))})})
    assert.equal((await drainRealtimeOutbox({publishFn:(channel,payload)=>publisher.publish(channel,JSON.stringify(payload)).then(()=>{})})).published,1)
    const event=await observed
    await new TaskIngressService(tasks).scheduleMessage(principal.companyId,event.message.id)
    assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM task_dispatches`)).rows[0].n,1)
    assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM channel_tasks`)).rows[0].n,1)
    assert.equal((await drainRealtimeOutbox({publishFn:(channel,payload)=>publisher.publish(channel,JSON.stringify(payload)).then(()=>{})})).published,0)
  }finally{__setLlmClientOverrideForTesting(null);publisher.disconnect();subscriber.disconnect();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

test('membership change and publication serialize without opening restricted inputs or stale executor writes',async()=>{
  await seed()
  await assert.rejects(tasks.grantChannel(principal,'entry-channel',{resource:'channel:entry-channel',actions:['read'],identity:'personal:entry-owner',audience:{kind:'PERSONAL',id:principal.id},destinations:['task-model'],expiresAt:'2099-01-01T00:00:00Z'}),/RESOURCE_AUTHORITY_UNVERIFIED/)
  const task=await tasks.create(principal,{channelId:'entry-channel',objective:'Concurrent publication membership boundary',ingressKey:'member-race',grantIds:[]})
  await tasks.drive(principal,task.id,'member-race')
  const claim=(await tasks.claim(principal.companyId,'entry-agent','publication-race'))!
  const execution=new TaskExecutionService(tasks)
  const artifact=await execution.artifact(principal.companyId,claim,{content:'Whole-channel permitted output',mediaType:'text/plain'})
  const outcomes=await Promise.allSettled([
    execution.deliver(principal.companyId,claim,{key:'member-race',summary:'Published with current membership',artifactIds:[artifact.id]}),
    removeConversationMember({companyId:principal.companyId,conversationId:'entry-channel',actorId:principal.id,memberId:'entry-agent',kind:'kicked'}),
  ])
  assert.equal(outcomes[1].status,'fulfilled')
  if(outcomes[0].status==='fulfilled'){
    await assert.rejects(execution.deliver(principal.companyId,claim,{key:'member-race',summary:'Published with current membership',artifactIds:[artifact.id],limitations:['Changed intent']}),/DELIVERY_KEY_CONFLICT/)
  }else assert.match(String(outcomes[0].reason),/BINDING_INELIGIBLE|TASK_CONTEXT_REVOKED/)
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM task_deliveries`)).rows[0].n,outcomes[0].status==='fulfilled'?1:0)
  await assert.rejects(execution.context(principal.companyId,claim),/BINDING_INELIGIBLE|TASK_CONTEXT_REVOKED/)
  await tasks.confirmStopped(principal.companyId,claim.id,claim.generation,claim.token)
})

test('joining a Task channel requires current authority for its shared history before any join broadcast',async()=>{
  await seed()
  for(const id of ['entry-new-member','entry-unverified']){
    await pool.query(`INSERT INTO users(id,email,display_name) VALUES($1,$1||'@task.test',$1)`,[id])
    await pool.query(`INSERT INTO participants(id,company_id,kind,name,initial,avatar_bg,status) VALUES($1,$2,'human',$1,'N','#fff','avail')`,[id,principal.companyId])
  }
  await pool.query(`INSERT INTO company_members(company_id,user_id,role) VALUES($1,'entry-new-member','member')`,[principal.companyId])
  const grant=await tasks.grantChannel(principal,'entry-channel',{resource:'channel:entry-channel',actions:['read','publish'],identity:'service:channel:entry-channel',audience:{kind:'CHANNEL',id:'entry-channel'},destinations:['task-model','artifact','channel'],expiresAt:'2099-01-01T00:00:00Z'})
  const task=await tasks.create(principal,{channelId:'entry-channel',objective:'Shared history',ingressKey:'join-history',grantIds:[grant]})
  await tasks.drive(principal,task.id,'history')
  await runCloudTask(tasks,principal.companyId,'entry-agent',async()=>({text:'Authorized shared artifact',calls:[]}))
  const args={companyId:principal.companyId,conversationId:'entry-channel',actorId:principal.id,memberId:'entry-new-member'}
  assert.ok(await addConversationMember(args))
  await removeConversationMember({...args,kind:'kicked'})
  await assert.rejects(addConversationMember({...args,memberId:'entry-unverified'}),/MEMBERSHIP_SOURCE_AUTHORITY_REQUIRED/)
  await pool.query(`INSERT INTO messages(id,company_id,conversation_id,author_id,kind,body,sequence,quoted_message_id)
    SELECT 'entry-history-quote',$1,'entry-channel',$2,'text','An ordinary reply',MAX(m.sequence)+1,(SELECT message_id FROM task_deliveries WHERE task_id=$3)
    FROM messages m WHERE m.conversation_id='entry-channel'`,[principal.companyId,principal.id,task.id])
  await tasks.revokeGrant(principal,grant)
  const messages=(await pool.query(`SELECT COUNT(*)::int n FROM messages`)).rows[0].n
  const outbox=(await pool.query(`SELECT COUNT(*)::int n FROM realtime_outbox`)).rows[0].n
  const app=await buildApiTestApp(principal.id);const server=app.listen(0,'127.0.0.1')
  await new Promise<void>(resolve=>server.once('listening',resolve))
  try{
    const response=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/conversations/entry-channel/members`,{method:'POST',headers:{'content-type':'application/json','x-company-id':principal.companyId},body:JSON.stringify({id:args.memberId})})
    assert.equal(response.status,409);assert.equal(((await response.json()) as {error:string}).error,'MEMBERSHIP_SOURCE_AUTHORITY_REQUIRED')
    const detail=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/tasks/${task.id}`,{headers:{'x-company-id':principal.companyId}})
    assert.equal(detail.status,200)
    assert.deepEqual(((await detail.json()) as {deliveries:unknown[]}).deliveries,[])
    const history=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/conversations/entry-channel/messages`,{headers:{'x-company-id':principal.companyId}})
    assert.equal(history.status,200)
    const rows=await history.json() as {id:string;quoted:unknown}[]
    assert.equal(rows.find(row=>row.id==='entry-history-quote')?.quoted,null)
    assert.doesNotMatch(JSON.stringify(rows),/Authorized shared artifact/)
    const messageId=(await pool.query(`SELECT message_id FROM task_deliveries WHERE task_id=$1`,[task.id])).rows[0].message_id
    for(const path of [`/api/search?q=Authorized`,`/api/conversations/entry-channel/messages/${messageId}/replies`,`/api/conversations`]){
      const read=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}${path}`,{headers:{'x-company-id':principal.companyId}})
      assert.equal(read.status,200);assert.doesNotMatch(await read.text(),/Authorized shared artifact/)
    }
    const event:MessageNewEvent={type:'message.new',companyId:principal.companyId,conversationId:'entry-channel',message:{id:'entry-history-quote',conversationId:'entry-channel',authorId:principal.id,kind:'text',body:'An ordinary reply',sequence:4,at:new Date().toISOString(),quotedMessageId:messageId,quoted:{id:messageId,authorId:'entry-agent',authorName:'Worker',kind:'text',body:'Authorized shared artifact',sequence:1}}}
    const wireEvent=structuredClone(event)
    assert.ok((await resolveWsEventRecipientUserIds(event)).has(principal.id))
    assert.equal(event.message.quoted,undefined)
    if(redis.status==='wait')await redis.connect()
    if(sub.status==='wait')await sub.connect()
    await sub.subscribe(CH_MESSAGE_NEW)
    const listeners=new Set(sub.listeners('message'))
    const wss=attachWebSocket(server)
    const {ticket}=await createWsTicket(principal.id)
    const socket=new WebSocket(`ws://127.0.0.1:${(server.address() as {port:number}).port}/ws?t=${encodeURIComponent(ticket)}`)
    const frames:MessageNewEvent[]=[]
    socket.on('message',raw=>{frames.push(JSON.parse(raw.toString()) as MessageNewEvent)})
    const waitFor=async(predicate:(frame:MessageNewEvent)=>boolean)=>{
      const deadline=Date.now()+10000
      while(Date.now()<deadline){const frame=frames.find(predicate);if(frame)return frame;await new Promise(resolve=>setTimeout(resolve,20))}
      throw new Error('Required real WS frame was not received')
    }
    try{
      await waitFor(frame=>(frame as {type:string}).type==='hello')
      await redis.publish(CH_MESSAGE_NEW,JSON.stringify(wireEvent))
      const received=await waitFor(frame=>frame.message?.id==='entry-history-quote')
      assert.equal(received.message.quoted,undefined)
      assert.doesNotMatch(JSON.stringify(received),/Authorized shared artifact/)
    }finally{
      socket.terminate()
      await new Promise<void>(resolve=>wss.close(()=>resolve()))
      for(const listener of sub.listeners('message'))if(!listeners.has(listener))sub.off('message',listener as (channel:string,payload:string)=>void)
      await new Promise(resolve=>setTimeout(resolve,250))
    }
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM conversation_members WHERE participant_id=ANY($1::text[])`,[['entry-new-member','entry-unverified']])).rows[0].n,0)
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM messages`)).rows[0].n,messages)
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM realtime_outbox`)).rows[0].n,outbox)
})

test('explicit Code and Aida mentions select their own Binding without coordinator takeover',async()=>{
  await seed()
  const bindings:Record<string,string>={}
  for(const alias of ['Code','Aida']){
    const agentId=`entry-${alias.toLowerCase()}`
    await pool.query(`INSERT INTO participants(id,company_id,kind,name,initial,avatar_bg,status) VALUES($1,$2,'agent',$1,'A','#fff','avail')`,[agentId,principal.companyId])
    await pool.query(`INSERT INTO conversation_members(conversation_id,company_id,participant_id,ordinal) VALUES('entry-channel',$1,$2,$3)`,[principal.companyId,agentId,alias==='Code'?2:3])
    const definition=await tasks.define(principal,alias,{instructions:'Only explicitly assigned work',role:alias==='Aida'?'COORDINATOR':'WORK'})
    bindings[alias]=await tasks.bind(principal,{channelId:'entry-channel',agentId,definitionVersionId:definition,alias,isDefault:false})
  }
  const app=await buildApiTestApp(principal.id);const server=app.listen(0,'127.0.0.1')
  await new Promise<void>(resolve=>server.once('listening',resolve))
  try{
    for(const alias of ['Code','Aida']){
      const response=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/conversations/entry-channel/messages`,{method:'POST',headers:{'content-type':'application/json','x-company-id':principal.companyId},body:JSON.stringify({body:`@${alias} do this explicit task`,clientId:`mention-${alias}`,taskId:'new'})})
      assert.equal(response.status,202)
      const body=await response.json() as {taskId:string}
      const task=(await pool.query(`SELECT accountable_binding_id,conversation_id FROM channel_tasks WHERE id=$1`,[body.taskId])).rows[0]
      assert.equal(task.accountable_binding_id,bindings[alias]);assert.equal(task.conversation_id,'entry-channel')
    }
    assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM channel_tasks`)).rows[0].n,2)
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

test('wrong content hashes cannot deliver and revoked child sources cannot be handed back as completion evidence',async()=>{
  await seed()
  const grant=await tasks.grantChannel(principal,'entry-channel',{resource:'channel:entry-channel',actions:['read','publish'],identity:'service:channel:entry-channel',audience:{kind:'CHANNEL',id:'entry-channel'},destinations:['task-model','artifact','channel'],expiresAt:'2099-01-01T00:00:00Z'})
  const task=await tasks.create(principal,{channelId:'entry-channel',objective:'Bounded evidence handoff',ingressKey:'evidence-boundary',grantIds:[grant]})
  await tasks.drive(principal,task.id,'evidence')
  const root=(await tasks.claim(principal.companyId,'entry-agent','evidence'))!
  const execution=new TaskExecutionService(tasks)
  const context=await execution.context(principal.companyId,root)
  await pool.query(`INSERT INTO artifact_versions(id,artifact_id,company_id,task_id,producer_binding_id,media_type,content,content_hash,provenance)
    VALUES('wrong-evidence','wrong-evidence',$1,$2,$3,'text/plain',$4,$5,$6)`,[principal.companyId,task.id,task.accountable_binding_id,Buffer.from('Actual version'),hashContent('Different version'),context.provenance])
  await assert.rejects(execution.deliver(principal.companyId,root,{key:'wrong-evidence',summary:'Cannot claim verified',artifactIds:['wrong-evidence']}),/ARTIFACT_HASH_MISMATCH/)
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM task_deliveries`)).rows[0].n,0)
  const plans=new TaskPlanService(tasks)
  await plans.propose(principal.companyId,root,{parallelism:1,members:[{key:'work',bindingId:task.accountable_binding_id,objective:'Bounded child',dependsOn:[],grantIds:context.rootGrantIds,role:'WORK'}]})
  await tasks.confirmStopped(principal.companyId,root.id,root.generation,root.token)
  await plans.advance(principal.companyId,task.id)
  await runCloudTask(tasks,principal.companyId,'entry-agent',async()=>({text:'Child evidence before revoke',calls:[]}))
  const child=(await pool.query(`SELECT id FROM channel_tasks WHERE parent_task_id=$1`,[task.id])).rows[0].id
  await tasks.revokeGrant(principal,grant)
  await assert.rejects(plans.handoff(principal.companyId,child,task.id),/SOURCE_REVOKED/)
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM artifact_handoffs`)).rows[0].n,0)
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM messages`)).rows[0].n,0)
  assert.equal((await pool.query(`SELECT status FROM channel_tasks WHERE id=$1`,[task.id])).rows[0].status,'BLOCKED')
})

test('a private Task arriving during execution queues independently and never enters the active Task context',async()=>{
  await seed()
  const active=await tasks.create(principal,{channelId:'entry-channel',objective:'Active group work',ingressKey:'active-group',grantIds:[]})
  await tasks.drive(principal,active.id,'group')
  const claim=(await tasks.claim(principal.companyId,'entry-agent','group'))!
  const before=await new TaskExecutionService(tasks).context(principal.companyId,claim)
  await pool.query(`INSERT INTO conversations(id,company_id,kind,title,members) VALUES('entry-private',$1,'direct','Private','["entry-owner","entry-agent"]')`,[principal.companyId])
  const definition=await tasks.define(principal,'private-entry',{instructions:'Private approved task only'})
  await tasks.bind(principal,{channelId:'entry-private',agentId:'entry-agent',definitionVersionId:definition,alias:'Private',isDefault:true})
  const privateTask=await tasks.create(principal,{channelId:'entry-private',objective:'PRIVATE_TASK_ARRIVED_DURING_GROUP',ingressKey:'private-during-group',grantIds:[]})
  await tasks.drive(principal,privateTask.id,'private')
  assert.equal(await tasks.claim(principal.companyId,'entry-agent','private-while-group'),null)
  const after=await new TaskExecutionService(tasks).context(principal.companyId,claim)
  assert.deepEqual(after.inputs,before.inputs);assert.doesNotMatch(JSON.stringify(after),/PRIVATE_TASK_ARRIVED_DURING_GROUP/)
  await tasks.confirmStopped(principal.companyId,claim.id,claim.generation,claim.token)
  const next=(await tasks.claim(principal.companyId,'entry-agent','private-after-stop'))!
  const nextContext=await new TaskExecutionService(tasks).context(principal.companyId,next)
  assert.equal(nextContext.task.id,privateTask.id);assert.ok(nextContext.inputs.some(input=>input.content==='PRIVATE_TASK_ARRIVED_DURING_GROUP'))
  assert.ok(!nextContext.inputs.some(input=>input.content==='Active group work'))
  await tasks.confirmStopped(principal.companyId,next.id,next.generation,next.token)
  for(const [id,channelId,body,taskId] of [['retained-group-message','entry-channel','RETAINED_GROUP_TASK_INPUT',active.id],['retained-private-message','entry-private','RETAINED_PRIVATE_TASK_INPUT',privateTask.id]]){
    await pool.query(`INSERT INTO messages(id,company_id,conversation_id,author_id,kind,body,sequence) VALUES($1,$2,$3,$4,'text',$5,1)`,[id,principal.companyId,channelId,principal.id,body])
    await tasks.supplement(principal,taskId,{messageId:id})
  }
  await pool.query(`UPDATE task_workspace_settings SET mode='LEGACY' WHERE company_id=$1`,[principal.companyId])
  await pool.query(`INSERT INTO messages(id,company_id,conversation_id,author_id,kind,body,sequence,quoted_message_id) VALUES('new-legacy-input',$1,'entry-channel',$2,'text','NEW_LEGACY_INPUT',2,'retained-group-message')`,[principal.companyId,principal.id])
  const inbox=await inprocClient.loadInbox('entry-agent')
  assert.ok(inbox.some(row=>row.body==='NEW_LEGACY_INPUT'))
  assert.doesNotMatch(JSON.stringify(inbox),/RETAINED_GROUP_TASK_INPUT|RETAINED_PRIVATE_TASK_INPUT/)
  const legacyContext=await inprocClient.loadContext('entry-agent',principal.companyId,['entry-channel','entry-private'])
  assert.doesNotMatch(JSON.stringify(legacyContext),/RETAINED_GROUP_TASK_INPUT|RETAINED_PRIVATE_TASK_INPUT/)
  const cli=await runCli(['--as','entry-agent','messages','entry-channel','--json'])
  assert.equal(cli.ok,true);assert.match(cli.text,/NEW_LEGACY_INPUT/);assert.doesNotMatch(cli.text,/RETAINED_GROUP_TASK_INPUT/)
  const dispatches=(await pool.query(`SELECT COUNT(*)::int n FROM task_dispatches`)).rows[0].n
  await claimAndWake({type:'message.new',companyId:principal.companyId,conversationId:'entry-private',message:{id:'retained-private-message',conversationId:'entry-private',authorId:principal.id,kind:'text',body:'RETAINED_PRIVATE_TASK_INPUT',sequence:1,at:new Date().toISOString()}})
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM task_dispatches`)).rows[0].n,dispatches)
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM agent_runs`)).rows[0].n,0)
  await claimAndWake({type:'message.new',companyId:principal.companyId,conversationId:'entry-private',taskId:privateTask.id,message:{id:'deleted-task-message',conversationId:'entry-private',authorId:principal.id,kind:'text',body:'RETAINED_PRIVATE_TASK_INPUT',sequence:1,at:new Date().toISOString()}})
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM agent_runs`)).rows[0].n,0)
})
