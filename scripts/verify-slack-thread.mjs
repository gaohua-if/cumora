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
const artifact = resolve('docs/verification/slack-thread-2026-10-07')
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
try {
  const endpoint = await new Promise((r,j) => { let output='';chrome.stderr.on('data',c=>{output+=c;const m=output.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m)r(m[1])});chrome.on('error',j);chrome.on('exit',c=>j(new Error('Chrome exited '+c))) })
  ws = new WebSocket(endpoint)
  await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})})
  let sequence=0;const pending=new Map();let pausedResponse=null;let nextPause=null
  ws.addEventListener('message',event=>{const reply=JSON.parse(event.data);if(reply.id){const p=pending.get(reply.id);if(p){pending.delete(reply.id);reply.error?p.j(new Error(JSON.stringify(reply.error))):p.r(reply.result)}}else if(reply.method==='Fetch.requestPaused'){const e=reply.params;if(nextPause&&e.request.method==='POST'&&/\/messages$/.test(e.request.url)){pausedResponse=e;nextPause(e);nextPause=null}else{void cdp('Fetch.continueRequest',{requestId:e.requestId},sessionId)}}else if(reply.method==='Runtime.exceptionThrown')errors.push(reply.params.exceptionDetails.exception?.description??reply.params.exceptionDetails.text)})
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
  const check=async(id,description,action)=>{if(checks.some(c=>c.id===id&&c.passed))return;await action();checks.push({id,description,passed:true});console.log('PASS '+id+' '+description)}
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
    objects.groupName='Slack thread 验收 '+Date.now()
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
  await check('S01','频道主流只显示根，thread 中显示真实 Aida 汇总',async()=>{
    objects.solo??=await send('请直接计算 17+25，通过最终汇总工具发布 SLACK_ROOT_OK 42，不需要成员。')
    objects.soloDetail=await settle(objects.solo.id)
    await openThread(objects.solo.id);await wait(`[...document.querySelectorAll('aside')].at(-1)?.innerText.includes('SLACK_ROOT_OK')`)
    const rows=await request(`/conversations/${objects.groupId}/messages?view=channel&limit=1`);assert.equal(rows.status,200);assert.deepEqual(rows.body.map(m=>m.id),[objects.solo.id])
    objects.soloReply=(await request(`/conversations/${objects.groupId}/messages/${objects.solo.id}/replies`)).body.find(m=>m.body.includes('SLACK_ROOT_OK'))
    assert.ok(objects.soloReply)
    assert.equal(await evaluate(`!!document.querySelector('[data-msg-id="${objects.soloReply.id}"]')`),false)
    await shot('02-channel-root-thread-summary')
  })
  await check('S02','引用子回复仍在同一 thread，发送者根计数一致',async()=>{
    await click(`aside [id="m-${objects.soloReply.id}"] button[aria-label="回复这条消息"]`)
    objects.nested??=await send('继续本 thread，只通过最终汇总发布 SLACK_NESTED_OK 42。',objects.solo.id)
    assert.equal(objects.nested.thread_id,objects.solo.id)
    const nested=query('SELECT quoted_message_id FROM messages WHERE id=$1',[objects.nested.id])[0];assert.equal(nested.quoted_message_id,objects.soloReply.id)
    objects.nestedDetail=await settle(objects.solo.id,'completed',2)
    assert.equal(objects.nestedDetail.members[0].sessionId,objects.soloDetail.members[0].sessionId)
    const count=query('SELECT count(*)::int AS n FROM messages WHERE thread_id=$1 AND id<>$1',[objects.solo.id])[0].n
    await wait(`document.querySelector('[data-msg-id="${objects.solo.id}"]')?.innerText.includes('${count} replies')`)
    assert.equal(await evaluate(`!!document.querySelector('[data-msg-id="${objects.nested.id}"]')`),false)
    assert.equal(await evaluate(`!![...document.querySelectorAll('aside [id="m-${objects.soloReply.id}"] button')].find(b=>/replies|reply$/.test(b.textContent))`),false)
    await shot('03-nested-root-count')
  })
  await check('S03','真实纯附件上传续接待补充任务，Aida 读取文件并保留 session',async()=>{
    objects.fileRoot??=await send('需要你读取我下一条上传的 source.txt 文件。现在没有文件，请通过 thread summary --blocked 发布 SLACK_WAIT_FILE。收到纯附件后，使用 scoped inbox/messages 的附件 URL 实际下载读取文本，计算文件中的两个数，最终汇总发布 SLACK_FILE_READ 42 和文件里的口令；不要推测内容。')
    objects.fileBefore??=await settle(objects.fileRoot.id,'awaiting_input')
    const current=await threadDetails(objects.fileRoot.id);objects.filePrevious=current;const nextRound=current.round+1
    await openThread(objects.fileRoot.id)
    const file=join(artifact,'source.txt');await writeFile(file,'Verification input: add 19 and 23. File-only secret: HARBOR_FILE_782\n')
    const {root}=await cdp('DOM.getDocument',{},sessionId),{nodeId}=await cdp('DOM.querySelector',{nodeId:root.nodeId,selector:'aside input[type=file]'},sessionId)
    assert.ok(nodeId);await cdp('DOM.setFileInputFiles',{nodeId,files:[file]},sessionId)
    await wait(`[...document.querySelectorAll('aside')].at(-1)?.innerText.includes('source.txt') && !![...document.querySelectorAll('aside button')].find(b=>b.textContent.includes('发送')&&!b.disabled)`)
    await evaluate(`[...document.querySelectorAll('aside button')].find(b=>b.textContent.includes('发送')&&!b.disabled).click()`)
    for(let n=0;n<50;n++){const d=await threadDetails(objects.fileRoot.id);if(d.round===nextRound)break;await new Promise(r=>setTimeout(r,200))}
    objects.fileAfter=await settle(objects.fileRoot.id,'completed',nextRound)
    assert.equal(objects.fileAfter.members[0].sessionId,objects.fileBefore.members[0].sessionId)
    assert.match(objects.fileAfter.members[0].result,/HARBOR_FILE_782/);assert.match(objects.fileAfter.members[0].result,/SLACK_FILE_READ 42/)
    objects.fileMessage=query('SELECT id,body,attachment,thread_id FROM messages WHERE thread_id=$1 AND attachment IS NOT NULL ORDER BY sequence DESC LIMIT 1',[objects.fileRoot.id])[0]
    assert.equal(objects.fileMessage.body,'');assert.equal(objects.fileMessage.attachment.name,'source.txt')
    await wait(`document.querySelector('section[aria-label="任务进度"]')?.innerText.includes('已完成')`)
    await shot('04-file-only-continuation')
  })
  const selectChat=async name=>{
    const row=`[...document.querySelectorAll('span')].find(e=>e.textContent===${JSON.stringify(name)})`
    await wait(`!!(${row})`);await evaluate(`(${row}).closest('div.grid.cursor-pointer').click()`)
    await new Promise(r=>setTimeout(r,300))
  }
  const delayNext=async()=>{
    const paused=new Promise(r=>{nextPause=r})
    await cdp('Fetch.enable',{patterns:[{urlPattern:'*/api/conversations/*/messages',requestStage:'Response'}]},sessionId)
    return {paused}
  }
  const release=async()=>{
    await cdp('Fetch.continueRequest',{requestId:pausedResponse.requestId},sessionId);pausedResponse=null
    await cdp('Fetch.disable',{},sessionId);await new Promise(r=>setTimeout(r,800))
  }
  await check('S04','延迟 HTTP 确认后不抢回已切换的频道',async()=>{
    const {paused}=await delayNext()
    objects.navigationTask=await send('请直接通过最终汇总发布 SLACK_NAVIGATION_OK 42，无需成员。');await paused
    const previous=JSON.parse(await readFile(resolve('docs/verification/thread-coordination-2026-10-07/acceptance.json'),'utf8'))
    await selectChat(previous.objects.groupName);await release()
    assert.equal(await evaluate(`!!document.querySelector('section[aria-label="任务进度"]')`),false)
    assert.ok(await evaluate(`document.body.innerText.includes(${JSON.stringify(previous.objects.groupName)})`))
    await shot('05-delayed-send-channel')
    await selectChat(objects.groupName)
  })
  await check('S05','延迟 HTTP 确认不覆盖用户打开的成员面板',async()=>{
    const {paused}=await delayNext()
    objects.profileTask=await send('请直接通过最终汇总发布 SLACK_PROFILE_OK 42，无需成员。');await paused
    await openThread(objects.solo.id)
    await click(`aside [id="m-${objects.soloReply.id}"] button[title*="Aida"]`)
    await wait(`!document.querySelector('section[aria-label="任务进度"]')`)
    const pane=await evaluate(`[...document.querySelectorAll('aside')].at(-1)?.innerText`);assert.ok(pane?.includes('Aida'))
    await release();assert.ok(await evaluate(`[...document.querySelectorAll('aside')].at(-1)?.innerText.includes('Aida')`));assert.equal(await evaluate(`!!document.querySelector('section[aria-label="任务进度"]')`),false)
    await shot('06-delayed-send-profile')
  })
  await cdp('Page.reload',{},sessionId);await openChat()
  await check('S06','刷新后按根分页，线程回复仍可查看',async()=>{
    objects.navigationDetail=await settle(objects.navigationTask.id);objects.profileDetail=await settle(objects.profileTask.id)
    const rows=(await request(`/conversations/${objects.groupId}/messages?view=channel&limit=500`)).body
    assert.ok(rows.every(m=>!m.threadId||m.threadId===m.id))
    assert.equal(rows.length,4)
    await openThread(objects.fileRoot.id);await wait(`[...document.querySelectorAll('aside')].at(-1)?.innerText.includes('SLACK_FILE_READ')`)
    for(const child of query('SELECT id FROM messages WHERE conversation_id=$1 AND thread_id IS NOT NULL AND id<>thread_id',[objects.groupId]))assert.equal(await evaluate(`!!document.querySelector('[data-msg-id="${child.id}"]')`),false)
    await evaluate(`(()=>{const e=[...document.querySelectorAll('aside *')].find(e=>e.textContent.includes('SLACK_FILE_READ')&&![...e.children].some(c=>c.textContent.includes('SLACK_FILE_READ')));e?.scrollIntoView({block:'center'})})()`)
    await shot('07-refreshed-channel-and-file-thread')
  })
  // Refresh final evidence without rerunning already accepted model work.
  await openThread(objects.fileRoot.id)
  await wait(`[...document.querySelectorAll('aside')].at(-1)?.innerText.includes('HARBOR_FILE_782')`)
  await wait(`document.querySelector('section[aria-label="任务进度"]')?.innerText.includes('已完成')`)
  await evaluate(`(()=>{const root=document.querySelector('section[aria-label="任务进度"]').closest('aside');const e=[...root.querySelectorAll('*')].find(e=>e.textContent.includes('HARBOR_FILE_782')&&![...e.children].some(c=>c.textContent.includes('HARBOR_FILE_782')));e?.scrollIntoView({block:'center'})})()`)
  await new Promise(r=>setTimeout(r,500))
  await shot('07-refreshed-channel-and-file-thread')
  for(let n=0;n<60;n++){
    const live=query('SELECT r.id FROM agent_runs r JOIN task_execution_contexts c ON c.id=r.task_context_id JOIN channel_tasks t ON t.id=c.task_id WHERE t.conversation_id=$1 AND r.status=\'running\'',[objects.groupId])
    if(!live.length)break
    if(n===59)throw new Error('Model run not settled')
    await new Promise(r=>setTimeout(r,1000))
  }
  objects.runs=query('SELECT r.id,r.agent_id,r.status,r.model,r.error,r.task_context_id,r.trigger FROM agent_runs r JOIN task_execution_contexts c ON c.id=r.task_context_id JOIN channel_tasks t ON t.id=c.task_id WHERE t.conversation_id=$1 ORDER BY r.started_at',[objects.groupId])
  assert.ok(objects.runs.every(r=>r.status==='completed'&&!r.error));assert.deepEqual(errors,[])
  objects.calls=query('SELECT run_id,source,model,status FROM llm_calls WHERE company_id=$1 AND run_id=ANY($2::text[])',[companyId,objects.runs.map(r=>r.id)])
  assert.ok(objects.calls.length && objects.calls.every(c=>c.source==='byoa-codex'&&c.status==='ok'))
  objects.deliveries=query('SELECT d.id,d.task_id,d.artifact_ids,d.summary,d.message_id FROM task_deliveries d JOIN channel_tasks t ON t.id=d.task_id WHERE t.conversation_id=$1',[objects.groupId])
  objects.inputs=query('SELECT i.task_id,i.reference_id,i.content,i.provenance FROM task_inputs i JOIN channel_tasks t ON t.id=i.task_id WHERE t.conversation_id=$1',[objects.groupId])
  const files=['server/src/tasks/threads.ts','server/src/tasks/message-input.ts','server/src/tasks/service.ts','server/src/api/router.ts','src/stores/messages.ts','src/desktop/ThreadDrawer.tsx','src/desktop/ChatPane.tsx','src/components/Message.tsx','src/lib/replyCount.ts','scripts/verify-slack-thread.mjs']
  const sourceHashes=Object.fromEntries(await Promise.all(files.map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')])))
  await writeFile(join(artifact,'acceptance.json'),JSON.stringify({timestamp:new Date().toISOString(),url,companyId,flags,schema:23,imageId:execFileSync('docker',['inspect','--format={{.Image}}',container],{encoding:'utf8'}).trim(),sourceHashes,realModelInference:true,checks,objects,errors},null,2)+'\n')
  console.log(JSON.stringify({passed:checks.length,artifact}))
} catch(error) {
  await writeFile(join(artifact,'failure.json'),JSON.stringify({timestamp:new Date().toISOString(),checks,objects,errors,error:String(error)},null,2)+'\n');throw error
} finally {
  ws?.close();chrome.kill('SIGTERM')
  runServer(`import {deleteSession} from './server/src/auth.ts';import {pool} from './server/src/db/pool.ts';try{await deleteSession(${JSON.stringify(session.token)})}finally{await pool.end()}`)
  await rm(profile,{recursive:true,force:true})
}
