import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const url = process.env.WORKBENCH_URL ?? 'http://192.168.28.113:5181'
const companyId = process.env.WORKBENCH_COMPANY ?? 'co-a09a2bc0-f'
const userId = process.env.WORKBENCH_USER ?? 'u-aafb44fb-e1d'
const container = process.env.WORKBENCH_CONTAINER ?? 'cumora-server-1'
const artifact = resolve('docs/verification/keyless-local-2026-10-06')
await mkdir(join(artifact, 'screenshots'), { recursive: true })
const runServer = script => execFileSync('docker', ['exec', '-i', container, 'node', '--import', 'tsx', '--input-type=module'], { input: script, encoding: 'utf8', timeout: 30000 }).trim().split('\n').at(-1)
const query = (sql, params = []) => JSON.parse(runServer(`import {pool} from './server/src/db/pool.ts';try{console.log(JSON.stringify((await pool.query(${JSON.stringify(sql)},${JSON.stringify(params)})).rows))}finally{await pool.end()}`))
const flags = JSON.parse(runServer(`import {env} from './server/src/env.ts'; console.log(JSON.stringify({localOnly:env.LOCAL_ONLY,credentials:Object.fromEntries(['OPENAI_API_KEY','ANTHROPIC_API_KEY','GOOGLE_API_KEY','NOVITA_API_KEY','ORCAROUTER_API_KEY','DEEPSEEK_API_KEY','SUB2API_ADMIN_KEY'].map(k=>[k,!!process.env[k]]))}));`))
assert.equal(flags.localOnly, true);assert.ok(Object.values(flags.credentials).every(v => !v))
assert.equal(query('SELECT max(version)::int AS version FROM schema_migrations')[0].version,22)
const session = JSON.parse(runServer(`import {createSession} from './server/src/auth.ts';import {pool} from './server/src/db/pool.ts';try{console.log(JSON.stringify(await createSession(${JSON.stringify(userId)},{ua:'keyless-local-e2e'})))}finally{await pool.end()}`))
const profile = await mkdtemp(join(tmpdir(), 'cumora-keyless-'))
const chrome = spawn('google-chrome', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,1000', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
let ws, originalPeer, peerId
const checks = [], errors = [], objects = {}, started = new Date().toISOString()
try {
  const endpoint = await new Promise((r,j) => { let output='';chrome.stderr.on('data',c=>{output+=c;const m=output.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m)r(m[1])});chrome.on('error',j);chrome.on('exit',c=>j(new Error('Chrome exited '+c))) })
  ws = new WebSocket(endpoint)
  await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})})
  let sequence=0;const pending=new Map()
  ws.addEventListener('message',event=>{const reply=JSON.parse(event.data);if(reply.id){const p=pending.get(reply.id);if(p){pending.delete(reply.id);reply.error?p.j(new Error(JSON.stringify(reply.error))):p.r(reply.result)}}else if(reply.method==='Runtime.exceptionThrown')errors.push(reply.params.exceptionDetails.exception?.description??reply.params.exceptionDetails.text)})
  const cdp=(method,params={},sessionId)=>new Promise((r,j)=>{const id=++sequence;pending.set(id,{r,j});ws.send(JSON.stringify({id,method,params,sessionId}))})
  const target=await cdp('Target.createTarget',{url:'about:blank'}),{sessionId}=await cdp('Target.attachToTarget',{targetId:target.targetId,flatten:true})
  for(const domain of ['Page','Runtime','Network'])await cdp(domain+'.enable',{},sessionId)
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false},sessionId)
  const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??'Evaluate failed');return r.result.value}
  const wait=async expression=>{for(let i=0;i<150;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100))}throw new Error('Timed out: '+expression)}
  const click=selector=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing '+${JSON.stringify(selector)});e.click()})()`)
  const fill=(selector,value)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing input');Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}))})()`)
  const field=(label,value)=>fill(`[aria-label=${JSON.stringify(label)}]`,value)
  const button=(label,scope='.cwb')=>evaluate(`(()=>{const root=document.querySelector(${JSON.stringify(scope)});const e=[...root.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!e)throw new Error('Missing button '+${JSON.stringify(label)});e.click()})()`)
  const shot=async name=>{const r=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},sessionId);await writeFile(join(artifact,'screenshots',name+'.png'),Buffer.from(r.data,'base64'))}
  const check=async(id,description,action)=>{await action();checks.push({id,description,passed:true});console.log('PASS '+id+' '+description)}
  const request=(path,method='GET',body)=>evaluate(`fetch(${JSON.stringify('/api'+path)},{method:${JSON.stringify(method)},headers:{Authorization:'Bearer '+localStorage.getItem('cumora.auth.token'),'x-company-id':${JSON.stringify(companyId)},'content-type':'application/json'},${body===undefined?'':`body:JSON.stringify(${JSON.stringify(body)}),`}}).then(async r=>({status:r.status,body:await r.json()}))`)
  const read=async()=>{const r=await request('/tasks/workbench');assert.equal(r.status,200);return r.body}
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`if(location.origin===${JSON.stringify(new URL(url).origin)}){localStorage.setItem('cumora.auth.token',${JSON.stringify(session.token)});localStorage.setItem('cumora.auth.company',${JSON.stringify(companyId)});localStorage.setItem('cumora.locale','zh-CN')}`},sessionId)
  await cdp('Page.navigate',{url},sessionId)
  await wait(`!!document.querySelector('button[aria-label="配置"]')`);await click('button[aria-label="配置"]');await wait(`!!document.querySelector('.cwb-runtime')`)
  await check('K01','无 Key 服务健康且配置页显示实际本地能力',async()=>{const d=await read();assert.equal(d.runtime.mode,'local-only');assert.equal(d.runtime.serverInference,false);assert.match(await evaluate('document.querySelector(".cwb-runtime").innerText'),/本地计算机.*登录态/);await shot('01-local-mode')})
  const state=await read(),aida=state.agents.find(a=>a.isAida),peer=state.agents.find(a=>a.id==='agent'&&a.engine==='codex')
  assert.ok(aida?.computerId&&peer?.computerId,'Expected paired Aida and verification Codex Agent')
  peerId=peer.id;objects.aidaId=aida.id;objects.peerId=peer.id
  originalPeer=query('SELECT model,fast_model FROM participants WHERE company_id=$1 AND id=$2',[companyId,peer.id])[0];objects.originalPeer=originalPeer
  assert.equal((await request('/agents/'+peer.id,'PUT',{model:'gpt-6-sol',fastModel:'gpt-6-luna'})).status,200)
  const names={solo:'无 Key · 仅 Aida '+Date.now(),multi:'无 Key · 多 Agent '+Date.now()}
  for(const key of ['solo','multi']){
    await button('群聊','.cwb-nav');await button('新建','.cwb-list');await field('群聊名称',names[key])
    if(key==='multi'){
      await button('Agent 成员','.cwb-tabs');await button('添加 Agent')
      await evaluate(`(()=>{const e=[...document.querySelectorAll('[role=dialog] label')].find(e=>e.textContent.includes(${JSON.stringify(peer.name)}));if(!e)throw new Error('Missing peer');e.querySelector('input').click()})()`)
      await button('确认成员','[role=dialog]')
    }
    await button('保存配置');await wait(`document.querySelector('.cwb-notice')?.innerText.includes('已保存') || document.querySelector('.cwb-footer')?.innerText.includes('已从服务端载入')`)
    const group=(await read()).channels.find(c=>c.title===names[key]);assert.ok(group);objects[key]=group.id;objects[key+'Name']=names[key]
    assert.ok(group.bindings.some(b=>b.agentId===aida.id&&b.isDefault))
    if(key==='solo')assert.deepEqual(group.members,[aida.id]);else assert.ok(group.members.includes(peer.id))
  }
  await check('K02','浏览器创建仅 Aida 与多个本地 Agent 群聊',async()=>{await button('Agent 成员','.cwb-tabs');await shot('02-multiple-local-agents')})
  await cdp('Page.reload',{},sessionId)
  const openChat=async(key)=>{
    await wait(`!!document.querySelector('button[aria-label="对话"]')`);await click('button[aria-label="对话"]')
    const row=`[...document.querySelectorAll('span')].find(e=>e.textContent===${JSON.stringify(names[key])})`
    await wait(`!!(${row})`);await evaluate(`(${row}).closest('div.grid.cursor-pointer').click()`)
    await wait(`!!document.querySelector('[contenteditable=true][role=textbox]')`)
  }
  const send=async(key,body)=>{
    await openChat(key);await evaluate(`document.querySelector('[contenteditable=true][role=textbox]').focus()`)
    await cdp('Input.insertText',{text:body},sessionId)
    await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},sessionId)
    await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},sessionId)
    await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},sessionId)
    await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},sessionId)
    for(let i=0;i<30;i++){const rows=query('SELECT id,body,sequence,work_recipient_ids,created_at FROM messages WHERE company_id=$1 AND conversation_id=$2 AND author_id=$3 AND body=$4 ORDER BY sequence DESC LIMIT 1',[companyId,objects[key],userId,body]);if(rows[0])return rows[0];await new Promise(r=>setTimeout(r,200))}
    throw new Error('Browser message was not persisted')
  }
  const answer=async(key,author,marker,after)=>{
    for(let i=0;i<150;i++){
      const rows=query('SELECT id,author_id,body,sequence,quoted_message_id,work_recipient_ids FROM messages WHERE company_id=$1 AND conversation_id=$2 AND author_id=$3 AND sequence>$4 AND body LIKE $5 ORDER BY sequence',[companyId,objects[key],author,after,'%'+marker+'%'])
      if(rows[0]){await wait(`document.body.innerText.includes(${JSON.stringify(marker)})`);return rows[0]}
      if(i%15===0)console.log('Waiting for local '+author+' '+marker)
      await new Promise(r=>setTimeout(r,2000))
    }
    throw new Error('Missing actual local reply '+marker)
  }
  objects.soloMessage=await send('solo','请计算 17 + 25，只回复 KEYLESS_SOLO_OK 42，仅使用群聊回复工具把结果发布到本群，不调用其他工具。')
  await check('K03','无 Key 的仅 Aida 群聊真实本地推理',async()=>{assert.deepEqual(objects.soloMessage.work_recipient_ids,[aida.id]);objects.soloAnswer=await answer('solo',aida.id,'KEYLESS_SOLO_OK 42',objects.soloMessage.sequence);await shot('03-solo-aida-reply')})
  objects.multiMessage=await send('multi','请计算 18 + 24，只回复 KEYLESS_MULTI_OK 42，不需要其他成员参与，仅使用群聊回复工具把结果发布到本群，不调用其他工具。')
  await check('K04','多人群聊普通消息只由默认 Aida 接单',async()=>{assert.deepEqual(objects.multiMessage.work_recipient_ids,[aida.id]);objects.multiAnswer=await answer('multi',aida.id,'KEYLESS_MULTI_OK 42',objects.multiMessage.sequence);assert.deepEqual(query('SELECT author_id FROM messages WHERE conversation_id=$1 AND sequence>$2 AND author_id<>$3',[objects.multi,objects.multiMessage.sequence,aida.id]),[]);await shot('04-default-aida-reply')})
  objects.directMessage=await send('multi',`@${peer.id} 请计算 19 + 23，只回复 KEYLESS_DIRECT_OK 42，仅使用群聊回复工具把结果发布到本群，不调用其他工具。`)
  await check('K05','明确点名本地 Agent 由它直接处理',async()=>{assert.deepEqual(objects.directMessage.work_recipient_ids,[peer.id]);objects.directAnswer=await answer('multi',peer.id,'KEYLESS_DIRECT_OK 42',objects.directMessage.sequence);await shot('05-direct-agent-reply')})
  objects.teamMessage=await send('multi',`请组织一次真实协作：让群聊成员「${peer.name}」负责计算 20 + 22。请你通过群聊工具明确点名该成员交办，并要求它在本群回复 KEYLESS_WORKER_OK 42，必须使用群聊回复工具发布结果，不调用其他工具。委派后先结束当前回合等待它回复，收到实际结果后你仅回复 KEYLESS_TEAM_OK 42。不要自己代替它计算，不要仅描述计划。`)
  await check('K06','Aida 决定并实际委派，本地成员完成后 Aida 汇总',async()=>{assert.deepEqual(objects.teamMessage.work_recipient_ids,[aida.id]);objects.workerAnswer=await answer('multi',peer.id,'KEYLESS_WORKER_OK 42',objects.teamMessage.sequence);objects.teamAnswer=await answer('multi',aida.id,'KEYLESS_TEAM_OK 42',objects.workerAnswer.sequence);assert.deepEqual(objects.teamAnswer.work_recipient_ids,[]);objects.delegation=query('SELECT id,author_id,body,sequence,quoted_message_id,work_recipient_ids FROM messages WHERE conversation_id=$1 AND sequence>$2 ORDER BY sequence',[objects.multi,objects.teamMessage.sequence]);assert.ok(objects.delegation.some(m=>m.author_id===aida.id&&m.work_recipient_ids.includes(peer.id)));await shot('06-aida-cooperation')})
  await check('K07','服务端头像能力明确返回 503',async()=>{const r=await request('/agents/'+aida.id+'/avatar/generate','POST');assert.equal(r.status,503);assert.equal(r.body.error,'SERVER_MODEL_UNAVAILABLE')})
  await check('K08','真实模型记录来自本地 Codex，服务端没有模型调用',async()=>{
    const calls=query('SELECT agent_id,run_id,purpose,source,model,status,input_tokens,output_tokens FROM llm_calls WHERE company_id=$1 AND created_at>=$2 ORDER BY created_at',[companyId,started]);objects.calls=calls
    assert.ok(calls.some(c=>c.agent_id===aida.id&&c.source==='byoa-codex'&&c.status==='ok'))
    assert.ok(calls.some(c=>c.agent_id===peer.id&&c.source==='byoa-codex'&&c.status==='ok'))
    assert.ok(calls.every(c=>c.source!=='cloud'&&c.purpose!=='message-routing'))
    assert.deepEqual(errors,[])
  })
  objects.runs=query('SELECT id,agent_id,status,model,error FROM agent_runs WHERE company_id=$1 AND started_at>=$2 ORDER BY started_at',[companyId,started])
  const files=['server/src/env.ts','server/src/model-availability.ts','server/src/llm.ts','server/src/agents/embeddings.ts','server/src/agents/scheduler.ts','server/src/agents/runtime/inproc-client.ts','server/src/tasks/ingress.ts','server/src/tasks/local-model.ts','server/src/tasks/runtime-endpoints.ts','server/src/tasks/service.ts','server/src/tasks/workspace.ts','server/src/tasks/configuration.ts','server/src/db/migrations/0021-aida-message-routing.ts','server/src/db/migrations/0022-agent-quote-context.ts','src/components/ConfigurationWorkbench.tsx','scripts/verify-keyless-local.mjs']
  const sourceHashes=Object.fromEntries(await Promise.all(files.map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')])))
  const imageId=execFileSync('docker',['inspect','--format={{.Image}}',container],{encoding:'utf8'}).trim()
  const schema=query('SELECT max(version)::int AS version FROM schema_migrations')[0].version
  await writeFile(join(artifact,'acceptance.json'),JSON.stringify({timestamp:new Date().toISOString(),url,companyId,flags,schema,imageId,sourceHashes,mode:'LEGACY',realModelInference:true,checks,objects,errors},null,2)+'\n')
  console.log(JSON.stringify({passed:checks.length,artifact:join(artifact,'acceptance.json')}))
} catch(error) {
  await writeFile(join(artifact,'failure.json'),JSON.stringify({timestamp:new Date().toISOString(),checks,objects,errors,error:String(error)},null,2)+'\n')
  throw error
} finally {
  ws?.close();chrome.kill('SIGTERM')
  runServer(`import {deleteSession} from './server/src/auth.ts';import {pool} from './server/src/db/pool.ts';try{await deleteSession(${JSON.stringify(session.token)})}finally{await pool.end()}`)
  if(originalPeer&&peerId)query('UPDATE participants SET model=$3,fast_model=$4 WHERE company_id=$1 AND id=$2',[companyId,peerId,originalPeer.model,originalPeer.fast_model])
  await rm(profile,{recursive:true,force:true})
}
