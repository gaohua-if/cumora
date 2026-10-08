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
const artifact = resolve('docs/verification/thread-coordination-2026-10-07')
await mkdir(join(artifact, 'screenshots'), { recursive: true })
const runServer = script => execFileSync('docker', ['exec', '-i', container, 'node', '--import', 'tsx', '--input-type=module'], { input: script, encoding: 'utf8', timeout: 30000 }).trim().split('\n').at(-1)
const query = (sql, params = []) => JSON.parse(runServer(`import {pool} from './server/src/db/pool.ts';try{console.log(JSON.stringify((await pool.query(${JSON.stringify(sql)},${JSON.stringify(params)})).rows))}finally{await pool.end()}`))
const flags = JSON.parse(runServer(`import {env} from './server/src/env.ts'; console.log(JSON.stringify({localOnly:env.LOCAL_ONLY,credentials:Object.fromEntries(['OPENAI_API_KEY','ANTHROPIC_API_KEY','GOOGLE_API_KEY','NOVITA_API_KEY','ORCAROUTER_API_KEY','DEEPSEEK_API_KEY','SUB2API_ADMIN_KEY'].map(k=>[k,!!process.env[k]]))}));`))
assert.equal(flags.localOnly, true);assert.ok(Object.values(flags.credentials).every(v => !v))
assert.equal(query('SELECT max(version)::int AS version FROM schema_migrations')[0].version,23)
const session = JSON.parse(runServer(`import {createSession} from './server/src/auth.ts';import {pool} from './server/src/db/pool.ts';try{console.log(JSON.stringify(await createSession(${JSON.stringify(userId)},{ua:'keyless-local-e2e'})))}finally{await pool.end()}`))
const profile = await mkdtemp(join(tmpdir(), 'cumora-keyless-'))
const chrome = spawn('google-chrome', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,1000', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
let ws
const saved = process.argv.includes('--resume') ? JSON.parse(await readFile(join(artifact, 'acceptance.json'), 'utf8').catch(() => readFile(join(artifact, 'failure.json'), 'utf8'))) : null
const checks = saved?.checks ?? [], errors = [], objects = saved?.objects ?? {}
const started = saved ? query('SELECT min(created_at) AS at FROM messages WHERE conversation_id=$1', [objects.groupId])[0].at : new Date().toISOString()
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
  if (!saved) {
  await check('T01','配置页可创建默认 Aida 与两个本地 Claude 成员的群聊',async()=>{
    const d=await read();assert.equal(d.runtime.mode,'local-only')
    const aida=d.agents.find(a=>a.isAida),atlas=d.agents.find(a=>a.name==='Atlas'),bram=d.agents.find(a=>a.name==='Bram')
    assert.ok(aida&&atlas&&bram);objects.agents={aida:aida.id,atlas:atlas.id,bram:bram.id}
    objects.groupName='Thread 协作验收 '+Date.now()
    await button('群聊','.cwb-nav');await button('新建','.cwb-list');await field('群聊名称',objects.groupName)
    await button('Agent 成员','.cwb-tabs');await button('添加 Agent')
    for(const member of [atlas,bram])await evaluate(`(()=>{const e=[...document.querySelectorAll('[role=dialog] label')].find(e=>e.textContent.includes(${JSON.stringify(member.name)}));if(!e)throw new Error('Missing member');e.querySelector('input').click()})()`)
    await button('确认成员','[role=dialog]');await button('保存配置')
    await wait(`document.querySelector('.cwb-notice')?.innerText.includes('已保存') || document.querySelector('.cwb-footer')?.innerText.includes('已从服务端载入')`)
    const group=(await read()).channels.find(c=>c.title===objects.groupName);assert.ok(group);objects.groupId=group.id
    assert.equal(group.members.length,3);assert.ok(group.bindings.some(b=>b.agentId===aida.id&&b.isDefault));await shot('01-group-configuration')
  })
  }
  await cdp('Page.reload',{},sessionId)
  const openChat=async()=>{
    await wait(`!!document.querySelector('button[aria-label="对话"]')`);await click('button[aria-label="对话"]')
    const row=`[...document.querySelectorAll('span')].find(e=>e.textContent===${JSON.stringify(objects.groupName)})`
    await wait(`!!(${row})`);await evaluate(`(${row}).closest('div.grid.cursor-pointer').click()`)
    await wait(`!!document.querySelector('[contenteditable=true][role=textbox]')`)
  }
  await openChat()
  const threadDetails=async id=>{const r=await request(`/conversations/${objects.groupId}/threads/${id}`);assert.equal(r.status,200);return r.body}
  const openThread=async id=>{
    for(let attempt=0;attempt<100;attempt++){
      if(await evaluate(`!!document.getElementById(${JSON.stringify('m-'+id)})`))break
      await evaluate(`(()=>{const e=[...document.querySelectorAll('[data-virtuoso-scroller]')].find(e=>e.querySelector('[data-msg-id]'));if(e)e.scrollTop=${attempt}%15===0?0:Math.min(e.scrollHeight-e.clientHeight,e.scrollTop+e.clientHeight*0.7)})()`)
      await new Promise(r=>setTimeout(r,300))
    }
    if(!await evaluate(`!!document.getElementById(${JSON.stringify('m-'+id)})`)){console.log(await evaluate(`JSON.stringify({scrolls:[...document.querySelectorAll('[data-virtuoso-scroller]')].map(e=>({top:e.scrollTop,height:e.scrollHeight,client:e.clientHeight})),ids:[...document.querySelectorAll('[id^=m-m-]')].map(e=>e.id),main:document.querySelector('main')?.innerText?.slice(0,1000)})`));await shot('debug-thread-root')}
    await evaluate(`(()=>{const root=document.getElementById(${JSON.stringify('m-'+id)});if(!root)throw new Error('Missing root');const b=[...root.querySelectorAll('button')].find(b=>/repl|thread/.test(b.textContent));if(!b)throw new Error('Missing thread entry');b.click()})()`)
    await wait(`!!document.querySelector('section[aria-label="任务进度"]')`)
  }
  const send=async(body,threadId)=>{
    if(threadId)await openThread(threadId)
    else await evaluate(`document.querySelector('section[aria-label="任务进度"]')?.closest('aside').querySelector('header button').click()`)
    const selector=threadId?'aside [contenteditable=true][role=textbox]':'[contenteditable=true][role=textbox]'
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)
    await cdp('Input.insertText',{text:body},sessionId)
    for(const key of ['Escape','Enter'])for(const type of ['keyDown','keyUp'])await cdp('Input.dispatchKeyEvent',{type,key,code:key,windowsVirtualKeyCode:key==='Escape'?27:13},sessionId)
    for(let i=0;i<40;i++){
      const rows=query('SELECT id,body,sequence,thread_id,work_recipient_ids FROM messages WHERE company_id=$1 AND conversation_id=$2 AND author_id=$3 AND body=$4 ORDER BY sequence DESC LIMIT 1',[companyId,objects.groupId,userId,body])
      if(rows[0])return rows[0]
      await new Promise(r=>setTimeout(r,200))
    }
    throw new Error('Browser message not persisted')
  }
  const settle=async(id,status='completed',round=1)=>{
    for(let i=0;i<180;i++){
      const d=await threadDetails(id)
      if(d.status===status&&d.round===round)return d
      if(['completed','awaiting_input'].includes(d.status))throw new Error('Unexpected terminal state '+JSON.stringify(d))
      if(i%15===0)console.log('Waiting '+id+' '+JSON.stringify(d.members.map(m=>[m.name,m.state])))
      await new Promise(r=>setTimeout(r,2000))
    }
    throw new Error('Thread timed out '+id)
  }
  const {aida,atlas,bram}=objects.agents
  if (!saved) {
  objects.solo=await send('请直接完成 17+25，通过当前 thread 的最终汇总工具发布 THREAD_SOLO_OK 42。不需要其他成员。')
  await check('T02','新任务自动建立 thread，Aida 独自完成并在右侧展示状态',async()=>{
    assert.equal(objects.solo.thread_id,objects.solo.id);objects.soloDetail=await settle(objects.solo.id)
    await openThread(objects.solo.id);await wait(`document.querySelector('section[aria-label="任务进度"]')?.innerText.includes('已完成')`)
    assert.match(await evaluate('document.querySelector("section[aria-label=任务进度]").closest("aside").innerText'),/THREAD_SOLO_OK 42/);await shot('02-solo-thread')
  })
  objects.multi=await send(`@${aida} 请通过 thread 委派工具组织 Atlas 和 Bram 完成同一任务：Atlas（${atlas}）计算 20+22，结果包含 THREAD_ATLAS_OK 42；Bram（${bram}）计算 6*7，并在结果正文中提到 @${atlas}，结果包含 THREAD_BRAM_OK 42。两个成员都必须提交结构化 completed 结果。你等待实际结果后最终汇总，包含 THREAD_MULTI_DONE 42。不要自己替成员计算。`)
  await check('T03','两个真实成员结果归集，正文 @ 同事仍由 Aida 汇总且没有循环',async()=>{
    objects.multiDetail=await settle(objects.multi.id);assert.equal(objects.multiDetail.members.length,3)
    assert.ok(objects.multiDetail.members.every(m=>m.state==='completed'))
    const bm=objects.multiDetail.members.find(m=>m.agentId===bram);assert.ok(bm.result.includes('@'+atlas))
    const rows=query('SELECT author_id,body,work_recipient_ids FROM messages WHERE thread_id=$1 ORDER BY sequence',[objects.multi.id]);objects.multiMessages=rows
    assert.ok(rows.some(m=>m.author_id===aida&&m.body.includes('THREAD_MULTI_DONE')))
    assert.ok(rows.filter(m=>m.author_id===bram&&m.body.includes('THREAD_BRAM_OK')).every(m=>m.work_recipient_ids.length===0))
    await openThread(objects.multi.id);await wait(`document.body.innerText.includes('THREAD_MULTI_DONE')`);await shot('03-multi-member-summary')
  })
  objects.blocked=await send(`@${aida} 请委派两个成员：Atlas（${atlas}）核对一个必须有官方来源的性能结论，但本轮没有提供该来源，也不允许网络访问。请让 Atlas 通过结构化结果工具提交 blocked，说明需要官方文档，标记 THREAD_SOURCE_BLOCKED，不得编造。Bram（${bram}）基于已给数据计算 21+21 并提交 completed，标记 THREAD_PARTIAL_OK 42。全部成员结束后，请你汇总已有结果和缺口，包含 THREAD_BLOCKED_SUMMARY，并明确待补充。`)
  await check('T04','完成与缺资料混合仍能汇总，并明确待补充',async()=>{
    objects.blockedDetail=await settle(objects.blocked.id,'awaiting_input')
    assert.equal(objects.blockedDetail.members.find(m=>m.agentId===atlas).state,'blocked')
    assert.equal(objects.blockedDetail.members.find(m=>m.agentId===bram).state,'completed')
    assert.ok(objects.blockedDetail.members.find(m=>m.agentId===aida).result.includes('THREAD_BLOCKED_SUMMARY'))
    await openThread(objects.blocked.id);await wait(`document.querySelector('section[aria-label="任务进度"]')?.innerText.includes('待补充')`);await shot('04-blocked-summary')
  })
  objects.alpha=await send('这是独立任务 ALPHA。本 thread 的口令是 ALPHA_83_HARBOR。请记住，计算 30+12，仅通过最终汇总工具发布 THREAD_ALPHA_OK 42。无需委派。')
  objects.beta=await send('这是另一条独立任务 BETA。本 thread 的口令是 BETA_91_FOREST。请记住，计算 31+11，仅通过最终汇总工具发布 THREAD_BETA_OK 42。无需委派。')
  await check('T05','同一 Aida 两条交错 thread 使用独立 session 与 context',async()=>{
    objects.alphaDetail=await settle(objects.alpha.id);objects.betaDetail=await settle(objects.beta.id)
    const x=objects.alphaDetail.members[0],y=objects.betaDetail.members[0]
    assert.ok(x.sessionId&&y.sessionId);assert.notEqual(x.sessionId,y.sessionId);assert.notEqual(x.contextId,y.contextId)
    await openThread(objects.beta.id);await shot('05-independent-threads')
  })
  objects.followup=await send('请继续 ALPHA 任务：只使用本 thread 先前的口令，发布 THREAD_ALPHA_FOLLOWUP 和该口令。不要使用其他任务口令，不需要委派。',objects.alpha.id)
  await check('T06','同 thread 追问创建新 Task 轮次并恢复原 session',async()=>{
    assert.equal(objects.followup.thread_id,objects.alpha.id);objects.followupDetail=await settle(objects.alpha.id,'completed',2)
    const member=objects.followupDetail.members[0];assert.equal(member.sessionId,objects.alphaDetail.members[0].sessionId)
    assert.notEqual(member.taskId,objects.alphaDetail.members[0].taskId);assert.match(member.result,/ALPHA_83_HARBOR/);assert.ok(!member.result.includes('BETA_91_FOREST'))
    await shot('06-followup-session')
  })
  }
  if (!checks.some(c=>c.id==='T07'&&c.passed)) await check('T07','刷新可恢复 thread 回复、成员状态与最终汇总',async()=>{
    await cdp('Page.reload',{},sessionId);await openChat();await openThread(objects.multi.id)
    await wait(`document.body.innerText.includes('THREAD_MULTI_DONE')`)
    const replies=await request(`/conversations/${objects.groupId}/messages/${objects.multi.id}/replies`);assert.equal(replies.status,200)
    assert.ok(replies.body.every(m=>m.threadId===objects.multi.id));await shot('07-refresh-thread')
  })
  if (!checks.some(c=>c.id==='T08'&&c.passed)) await check('T08','systemd 重启后真实恢复同 thread 的 Codex session',async()=>{
    objects.daemonPidBefore=execFileSync('systemctl',['--user','show','cumora','-p','MainPID','--value'],{encoding:'utf8'}).trim()
    execFileSync('systemctl',['--user','restart','cumora'],{timeout:45000})
    objects.daemonPidAfter=execFileSync('systemctl',['--user','show','cumora','-p','MainPID','--value'],{encoding:'utf8'}).trim()
    assert.notEqual(objects.daemonPidBefore,objects.daemonPidAfter)
    objects.restartMessage=await send('继续 ALPHA：确认本 thread 原来的口令，发布 THREAD_RESTART_OK 和口令，不需要委派。',objects.alpha.id)
    objects.restartDetail=await settle(objects.alpha.id,'completed',3)
    assert.equal(objects.restartDetail.members[0].sessionId,objects.alphaDetail.members[0].sessionId)
    assert.match(objects.restartDetail.members[0].result,/ALPHA_83_HARBOR/);assert.match(objects.restartDetail.members[0].result,/THREAD_RESTART_OK/)
    await shot('08-restart-session')
  })
  // Wait for the displayed terminal status and capture the actual final message.
  for (const [id, marker, name] of [[objects.multi.id, 'THREAD_MULTI_DONE', '07-refresh-thread'], [objects.alpha.id, 'THREAD_RESTART_OK', '08-restart-session']]) {
    await openThread(id)
    await wait(`document.querySelector('section[aria-label="任务进度"]')?.innerText.includes('已完成')`)
    await evaluate(`(()=>{const e=document.querySelector('aside [data-virtuoso-scroller]')??document.querySelector('aside .overflow-y-auto');if(e)e.scrollTop=e.scrollHeight})()`)
    await wait(`document.querySelector('section[aria-label="任务进度"]')?.closest('aside').innerText.includes(${JSON.stringify(marker)})`)
    await evaluate(`(()=>{const root=document.querySelector('section[aria-label="任务进度"]').closest('aside');const e=[...root.querySelectorAll('*')].find(e=>e.textContent.includes(${JSON.stringify(marker)})&&![...e.children].some(c=>c.textContent.includes(${JSON.stringify(marker)})));e?.scrollIntoView({block:'center'})})()`)
    await new Promise(r=>setTimeout(r,500))
    await shot(name)
  }
  for(let attempt=0;attempt<60;attempt++){
    const live=query('SELECT r.id FROM agent_runs r JOIN task_execution_contexts c ON c.id=r.task_context_id JOIN channel_tasks t ON t.id=c.task_id WHERE t.conversation_id=$1 AND r.status=\'running\'', [objects.groupId])
    if(!live.length)break
    if(attempt===59)throw new Error('Model runs did not finish')
    await new Promise(r=>setTimeout(r,1000))
  }
  objects.runs=query('SELECT r.id,r.agent_id,r.status,r.model,r.error,r.task_context_id,r.trigger FROM agent_runs r WHERE r.company_id=$1 AND r.started_at>=$2 ORDER BY r.started_at',[companyId,started])
  objects.artifacts=query('SELECT a.id,a.task_id,a.producer_binding_id,a.content_hash,a.input_version_ids FROM artifact_versions a JOIN channel_tasks t ON t.id=a.task_id WHERE t.conversation_id=$1 ORDER BY a.created_at',[objects.groupId])
  objects.deliveries=query('SELECT d.id,d.task_id,d.artifact_ids,d.limitations,d.message_id,d.delivery_key FROM task_deliveries d JOIN channel_tasks t ON t.id=d.task_id WHERE t.conversation_id=$1 ORDER BY d.created_at',[objects.groupId])
  objects.calls=query('SELECT agent_id,run_id,purpose,source,model,status FROM llm_calls WHERE company_id=$1 AND created_at>=$2 ORDER BY created_at',[companyId,started])
  assert.ok(objects.calls.some(c=>c.source==='byoa-codex'));assert.ok(objects.calls.some(c=>c.source==='byoa-claude'));assert.ok(objects.calls.every(c=>['byoa-codex','byoa-claude'].includes(c.source)))
  const verifiedThreads=new Set([objects.solo.id,objects.multi.id,objects.blocked.id,objects.alpha.id,objects.beta.id])
  assert.ok(objects.runs.filter(r=>verifiedThreads.has(r.trigger?.threadId)).every(r=>r.status==='completed'&&!r.error))
  assert.deepEqual(errors,[])
  const files=['server/src/tasks/threads.ts','server/src/tasks/thread-scope.ts','server/src/agents/computer/daemon.ts','server/src/agents/runtime/server.ts','server/src/db/migrations/0023-thread-agent-coordination.ts','src/desktop/ThreadDrawer.tsx','scripts/verify-thread-coordination.mjs']
  const sourceHashes=Object.fromEntries(await Promise.all(files.map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')])))
  await writeFile(join(artifact,'acceptance.json'),JSON.stringify({timestamp:new Date().toISOString(),url,companyId,flags,schema:23,imageId:execFileSync('docker',['inspect','--format={{.Image}}',container],{encoding:'utf8'}).trim(),sourceHashes,realModelInference:true,checks,objects,errors},null,2)+'\n')
  console.log(JSON.stringify({passed:checks.length,artifact:join(artifact,'acceptance.json')}))
} catch(error) {
  await writeFile(join(artifact,'failure.json'),JSON.stringify({timestamp:new Date().toISOString(),checks,objects,errors,error:String(error)},null,2)+'\n')
  throw error
} finally {
  ws?.close();chrome.kill('SIGTERM')
  runServer(`import {deleteSession} from './server/src/auth.ts';import {pool} from './server/src/db/pool.ts';try{await deleteSession(${JSON.stringify(session.token)})}finally{await pool.end()}`)
  await rm(profile,{recursive:true,force:true})
}
