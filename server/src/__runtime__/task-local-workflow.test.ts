import { test,before,after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import express from 'express'
import type OpenAI from 'openai'
import { pool } from '../db/pool.js'
import { ensureSchemaOnce,resetAllTables,teardownAll } from '../__integration__/_helpers.js'
import { TaskService } from '../tasks/service.js'
import { TaskPlanService } from '../tasks/plans.js'
import { TaskWorkspaceService } from '../tasks/workspace.js'
import { runCloudTask } from '../tasks/runner.js'
import { runLocalTask,resolveLocalCodex } from '../tasks/local-client.js'
import { hashContent } from '../tasks/contracts.js'
import { signAgentToken } from '../agents/runtime/jwt.js'
import { __setLlmClientOverrideForTesting } from '../llm.js'

before(ensureSchemaOnce)
after(async()=>{__setLlmClientOverrideForTesting(null);await teardownAll()})

test('cloud Aida hands exact artifact versions to a real HTTP-authenticated isolated local Codex and cloud verifier',{timeout:150000},async()=>{
  await resetAllTables()
  const tasks=new TaskService(pool)
  const principal={companyId:'task-native-test',id:'native-owner'}
  await pool.query(`INSERT INTO companies(id,name,slug,owner_user_id) VALUES($1,'Native Test',$1,$2)`,[principal.companyId,principal.id])
  await pool.query(`INSERT INTO users(id,email,display_name) VALUES($1,'native@task.test','Native owner')`,[principal.id])
  await pool.query(`INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner')`,[principal.companyId,principal.id])
  for(const [id,kind] of [[principal.id,'human'],['aida','agent'],['local-worker','agent'],['cloud-verifier','agent']])
    await pool.query(`INSERT INTO participants(id,company_id,kind,name,initial,avatar_bg,status) VALUES($1,$2,$3,$1,'T','#fff','avail')`,[id,principal.companyId,kind])
  await pool.query(`INSERT INTO computers(id,company_id,name,kind,available_engines,status) VALUES('task-native-device',$1,'Native task device','local','["codex"]','online')`,[principal.companyId])
  await pool.query(`UPDATE participants SET computer_id='task-native-device',engine='codex' WHERE company_id=$1 AND id='local-worker'`,[principal.companyId])
  await pool.query(`INSERT INTO conversations(id,company_id,kind,title,members) VALUES('task-native-channel',$1,'group','Native workflow','["native-owner","aida","local-worker","cloud-verifier"]')`,[principal.companyId])
  await tasks.prepare(principal)
  const definition=await tasks.define(principal,'native-test-definition',{instructions:'Coordinate only this task and its approved inputs.',role:'COORDINATOR'})
  const workerDefinition=await tasks.define(principal,'native-worker-definition',{instructions:'Execute only this task and its approved inputs.',role:'WORK'})
  const bindings:Record<string,string>={}
  for(const agentId of ['aida','local-worker','cloud-verifier'])bindings[agentId]=await tasks.bind(principal,{channelId:'task-native-channel',agentId,definitionVersionId:agentId==='aida'?definition:workerDefinition,alias:agentId,isDefault:agentId==='aida'})
  const binary=await resolveLocalCodex()
  await new TaskWorkspaceService(tasks).admit(principal,{computerId:'task-native-device',engine:'codex',binaryHash:hashContent(await readFile(binary)),verificationRef:'task-local-boundary.test.ts: actual process boundary verification',checks:{filesystem:true,environment:true,process:true,network:true,freshSession:true,stoppedChildren:true}})
  await new TaskWorkspaceService(tasks).activate(principal)
  const task=await tasks.create(principal,{channelId:'task-native-channel',objective:'Repair and verify across environments',ingressKey:'native-workflow',grantIds:[]})
  await tasks.drive(principal,task.id,'plan')
  assert.equal(await runCloudTask(tasks,principal.companyId,'aida',async()=>({text:'',calls:[{id:'plan',name:'task_plan',arguments:JSON.stringify({parallelism:2,members:[
    {key:'repair',bindingId:bindings['local-worker'],objective:'Produce a repair.patch with exact content NATIVE_PATCH_V1',dependsOn:[],grantIds:[],role:'WORK'},
    {key:'verify',bindingId:bindings['cloud-verifier'],objective:'Verify the exact local repair version',dependsOn:['repair'],grantIds:[],role:'VERIFY'},
  ]})}]})),true)
  const plans=new TaskPlanService(tasks)
  await plans.advance(principal.companyId,task.id)
  const app=express()
  const {runtimeRouter}=await import('../agents/runtime/server.js')
  app.use('/runtime',runtimeRouter)
  const server=app.listen(0,'127.0.0.1')
  await new Promise<void>(resolve=>server.once('listening',resolve))
  const address=server.address()
  if(!address || typeof address==='string')throw new Error('runtime test server did not bind')
  const base=`http://127.0.0.1:${address.port}`
  const assignment=(await pool.query(`SELECT runtime_assignment_id FROM participants WHERE company_id=$1 AND id='local-worker'`,[principal.companyId])).rows[0].runtime_assignment_id
  const token=signAgentToken({companyId:principal.companyId,agentId:'local-worker',computerId:'task-native-device',assignmentId:assignment})
  let calls=0
  __setLlmClientOverrideForTesting(()=>({responses:{create:async(request:unknown)=>{
    const serialized=JSON.stringify(request)
    assert.doesNotMatch(serialized,/claim_token_hash|DATABASE_URL|REDIS_URL|credential_ref/)
    assert.equal(serialized.includes(token),false)
    const output=++calls===1?[{type:'function_call',id:'fc_native',call_id:'call_native',name:'exec_command',arguments:JSON.stringify({cmd:"printf NATIVE_PATCH_V1 > /workspace/repair.patch",yield_time_ms:1000,max_output_tokens:1000})}]:
      [{type:'message',id:'msg_native',role:'assistant',status:'completed',content:[{type:'output_text',text:'Local repair complete.',annotations:[]}]}]
    return {id:`resp_native_${calls}`,object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',error:null,incomplete_details:null,model:'gpt-5.5',output,usage:{input_tokens:100,output_tokens:30,total_tokens:130,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}
  }}} as unknown as OpenAI))
  try{
    const forbidden=await fetch(`${base}/runtime/inbox`,{headers:{Authorization:`Bearer ${token}`}})
    assert.equal(forbidden.status,403)
    assert.equal(await runLocalTask({serverUrl:base,token,engine:'codex',signal:AbortSignal.timeout(90000)}),true)
    assert.ok(calls>=2)
    const local=(await pool.query(`SELECT d.*,x.task_id FROM task_dispatches d JOIN task_execution_contexts x ON x.id=d.context_id WHERE d.company_id=$1 AND d.agent_id='local-worker'`,[principal.companyId])).rows[0]
    assert.equal(local.state,'COMPLETED');assert.ok(local.stopped_at)
    const spoof=await fetch(`${base}/runtime/tasks/context`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({claim:{id:local.id,contextId:local.context_id,generation:local.claim_generation,token:'copied-or-forged'}})})
    assert.equal(spoof.status,403)
    await plans.advance(principal.companyId,task.id)
    assert.equal(await runCloudTask(tasks,principal.companyId,'cloud-verifier',async context=>{
      assert.ok(context.inputs.some(input=>input.content==='NATIVE_PATCH_V1'))
      assert.ok(context.inputs.filter(input=>input.provenance.sources.some(source=>source.kind==='ARTIFACT')).length>=2)
      return {text:'VERIFIED_NATIVE_PATCH_V1',calls:[]}
    }),true)
    await plans.advance(principal.companyId,task.id)
    assert.equal(await runCloudTask(tasks,principal.companyId,'aida',async context=>{
      assert.ok(context.inputs.some(input=>input.content==='VERIFIED_NATIVE_PATCH_V1'))
      return {text:'Cross-environment repair and independent verification complete.',calls:[]}
    }),true)
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM messages WHERE company_id=$1`,[principal.companyId])).rows[0].n,1)
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM llm_calls WHERE company_id=$1 AND extras->>'executor'='local-codex-isolated'`,[principal.companyId])).rows[0].n,calls)
  }finally{__setLlmClientOverrideForTesting(null);await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

test('local Aida commits a bounded plan and aggregates exact local WORK and independent VERIFY evidence',{timeout:180000},async()=>{
  await resetAllTables()
  const tasks=new TaskService(pool)
  const principal={companyId:'task-all-local-test',id:'local-owner'}
  await pool.query(`INSERT INTO companies(id,name,slug,owner_user_id) VALUES($1,'All local test',$1,$2)`,[principal.companyId,principal.id])
  await pool.query(`INSERT INTO users(id,email,display_name) VALUES($1,'all-local@task.test','Local owner')`,[principal.id])
  await pool.query(`INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner')`,[principal.companyId,principal.id])
  await pool.query(`INSERT INTO computers(id,company_id,name,kind,available_engines,status) VALUES('all-local-device',$1,'All local device','local','["codex"]','online')`,[principal.companyId])
  for(const [id,kind] of [[principal.id,'human'],['local-aida','agent'],['local-work','agent'],['local-verify','agent']])
    await pool.query(`INSERT INTO participants(id,company_id,kind,name,initial,avatar_bg,status,computer_id,engine) VALUES($1,$2,$3,$1,'T','#fff','avail',$4,$5)`,[id,principal.companyId,kind,kind==='agent'?'all-local-device':null,kind==='agent'?'codex':null])
  await pool.query(`INSERT INTO conversations(id,company_id,kind,title,members) VALUES('all-local-channel',$1,'group','All local workflow','["local-owner","local-aida","local-work","local-verify"]')`,[principal.companyId])
  await tasks.prepare(principal)
  const bindings:Record<string,string>={}
  for(const [id,role] of [['local-aida','COORDINATOR'],['local-work','WORK'],['local-verify','VERIFY']]){
    const definition=await tasks.define(principal,id,{instructions:id.toUpperCase(),role})
    bindings[id]=await tasks.bind(principal,{channelId:'all-local-channel',agentId:id,definitionVersionId:definition,alias:id,isDefault:id==='local-aida'})
  }
  const binary=await resolveLocalCodex()
  await new TaskWorkspaceService(tasks).admit(principal,{computerId:'all-local-device',engine:'codex',binaryHash:hashContent(await readFile(binary)),verificationRef:'task-local-boundary.test.ts: actual qualification',checks:{filesystem:true,environment:true,process:true,network:true,freshSession:true,stoppedChildren:true}})
  await new TaskWorkspaceService(tasks).activate(principal)
  const task=await tasks.create(principal,{channelId:'all-local-channel',objective:'All-local repair and independent verification',ingressKey:'all-local',grantIds:[]})
  await tasks.drive(principal,task.id,'local-plan')
  const app=express();const {runtimeRouter}=await import('../agents/runtime/server.js');app.use('/runtime',runtimeRouter)
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve))
  const address=server.address();if(!address||typeof address==='string')throw new Error('runtime did not bind')
  const serverUrl=`http://127.0.0.1:${address.port}`
  const tokens:Record<string,string>={}
  for(const agentId of Object.keys(bindings)){
    const assignment=(await pool.query(`SELECT runtime_assignment_id FROM participants WHERE company_id=$1 AND id=$2`,[principal.companyId,agentId])).rows[0].runtime_assignment_id
    tokens[agentId]=signAgentToken({companyId:principal.companyId,agentId,computerId:'all-local-device',assignmentId:assignment})
  }
  const plan={parallelism:2,members:[{key:'work',bindingId:bindings['local-work'],objective:'Produce LOCAL_EXACT_PATCH',dependsOn:[],grantIds:[],role:'WORK'},{key:'verify',bindingId:bindings['local-verify'],objective:'Verify the exact patch',dependsOn:['work'],grantIds:[],role:'VERIFY'}]}
  const counts:Record<string,number>={};let aggregateSawReport=false
  const command=(cmd:string)=>[{type:'function_call',id:'fc_local',call_id:'call_local',name:'exec_command',arguments:JSON.stringify({cmd,yield_time_ms:1000,max_output_tokens:1000})}]
  const answer=(text:string)=>[{type:'message',id:'msg_local',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]}]
  __setLlmClientOverrideForTesting(()=>({responses:{create:async(request:any)=>{
    const agent=String(request.instructions).split('\n')[0];counts[agent]=(counts[agent]??0)+1
    const serialized=JSON.stringify(request)
    for(const token of Object.values(tokens))assert.equal(serialized.includes(token),false)
    let output:unknown[]
    if(agent==='LOCAL-AIDA'){
      if(counts[agent]===1)output=command(`cat > /workspace/task-plan.json <<'PLAN'\n${JSON.stringify(plan)}\nPLAN`)
      else if(counts[agent]===2)output=answer('Plan prepared; waiting for children.')
      else {aggregateSawReport=serialized.includes('LOCAL_VERIFY_PASS');assert.equal(aggregateSawReport,true);output=answer('All-local repair and independent verification complete.')}
    }else if(agent==='LOCAL-WORK')output=counts[agent]===1?command('printf LOCAL_EXACT_PATCH > /workspace/repair.patch'):answer('Local work complete.')
    else if(agent==='LOCAL-VERIFY')output=counts[agent]===1?command(`/engine/node -e 'const fs=require("fs");const task=JSON.parse(fs.readFileSync("/inputs/task.json","utf8"));if(!task.context.inputs.some(i=>i.content==="LOCAL_EXACT_PATCH"))process.exit(1);fs.writeFileSync("/workspace/report.md","LOCAL_VERIFY_PASS");'`):answer('LOCAL_VERIFY_PASS')
    else throw new Error('unexpected local agent')
    return {id:`resp_local_${agent}_${counts[agent]}`,object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',output,usage:{input_tokens:100,output_tokens:30,total_tokens:130,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}
  }}} as unknown as OpenAI))
  const run=(agentId:string)=>runLocalTask({serverUrl,token:tokens[agentId],engine:'codex',signal:AbortSignal.timeout(90000)})
  try{
    assert.equal(await run('local-aida'),true)
    const root=(await pool.query(`SELECT status,blocked_code FROM channel_tasks WHERE id=$1`,[task.id])).rows[0]
    assert.deepEqual(root,{status:'BLOCKED',blocked_code:'AWAITING_CHILDREN'})
    assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM messages WHERE company_id=$1`,[principal.companyId])).rows[0].n,0)
    assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM artifact_versions WHERE company_id=$1`,[principal.companyId])).rows[0].n,0,'plan file and provisional answer must not be published')
    const plans=new TaskPlanService(tasks);await plans.advance(principal.companyId,task.id)
    assert.equal(await run('local-work'),true);await plans.advance(principal.companyId,task.id)
    assert.equal(await run('local-verify'),true);await plans.advance(principal.companyId,task.id)
    assert.equal(await run('local-aida'),true);assert.equal(aggregateSawReport,true)
    const deliveries=(await pool.query(`SELECT d.*,t.parent_task_id FROM task_deliveries d JOIN channel_tasks t ON t.id=d.task_id WHERE d.company_id=$1`,[principal.companyId])).rows
    assert.equal(deliveries.length,3);assert.ok(deliveries.find(d=>!d.parent_task_id).evidence_ids.length>0)
    assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM messages WHERE company_id=$1`,[principal.companyId])).rows[0].n,1)
    const dispatches=(await pool.query(`SELECT d.state,d.stopped_at,x.computer_id FROM task_dispatches d JOIN task_execution_contexts x ON x.id=d.context_id WHERE d.company_id=$1`,[principal.companyId])).rows
    assert.equal(dispatches.length,4);assert.ok(dispatches.every(d=>d.stopped_at&&d.computer_id==='all-local-device'))
    assert.equal((await pool.query(`SELECT status FROM channel_tasks WHERE id=$1`,[task.id])).rows[0].status,'DELIVERED')
  }finally{__setLlmClientOverrideForTesting(null);await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
