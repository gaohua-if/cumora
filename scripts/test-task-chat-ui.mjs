import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp,readFile,rm,readdir} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createServer} from 'vite'
import {pool} from '../server/src/db/pool.ts'
import {ensureSchemaOnce,resetAllTables,buildApiTestApp,teardownAll} from '../server/src/__integration__/_helpers.ts'
import {TaskService} from '../server/src/tasks/service.ts'
import {TaskExecutionService} from '../server/src/tasks/execution.ts'
import {TaskWorkspaceService} from '../server/src/tasks/workspace.ts'

await ensureSchemaOnce();await resetAllTables()
const tasks=new TaskService(pool)
const principal={companyId:'task-ui-test',id:'task-ui-owner'}
const channelId='task-ui-channel'
await pool.query(`INSERT INTO companies(id,name,slug,owner_user_id) VALUES($1,'Task UI',$1,$2)`,[principal.companyId,principal.id])
await pool.query(`INSERT INTO users(id,email,display_name) VALUES($1,'task-ui@test.local','Task UI owner')`,[principal.id])
await pool.query(`INSERT INTO company_members(company_id,user_id,role) VALUES($1,$2,'owner')`,[principal.companyId,principal.id])
for(const [id,kind] of [[principal.id,'human'],['task-ui-agent','agent']])await pool.query(`INSERT INTO participants(id,company_id,kind,name,initial,avatar_bg,status) VALUES($1,$2,$3,$1,'T','#fff','avail')`,[id,principal.companyId,kind])
await pool.query(`INSERT INTO conversations(id,company_id,kind,title,members) VALUES($1,$2,'group','Task UI','["task-ui-owner","task-ui-agent"]')`,[channelId,principal.companyId])
await tasks.prepare(principal)
const definition=await tasks.define(principal,'ui-agent',{instructions:'UI test'})
await tasks.bind(principal,{channelId,agentId:'task-ui-agent',definitionVersionId:definition,alias:'Worker',isDefault:true})
await new TaskWorkspaceService(tasks).activate(principal)
const grant=await tasks.grantChannel(principal,channelId,{resource:`channel:${channelId}`,actions:['read','publish'],identity:`service:channel:${channelId}`,audience:{kind:'CHANNEL',id:channelId},destinations:['task-model','artifact','channel'],expiresAt:'2099-01-01T00:00:00Z'})
const completed=await tasks.create(principal,{channelId,objective:'UI delivered artifact',ingressKey:'ui-delivered',grantIds:[grant]})
await tasks.drive(principal,completed.id,'ui-delivery')
const claim=await tasks.claim(principal.companyId,'task-ui-agent','ui-fixture')
assert.ok(claim)
const execution=new TaskExecutionService(tasks)
const artifact=await execution.artifact(principal.companyId,claim,{content:'UI_VERIFIED_ARTIFACT',mediaType:'text/plain'})
await execution.deliver(principal.companyId,claim,{key:'ui-delivery',summary:'UI artifact ready',artifactIds:[artifact.id]})
await tasks.confirmStopped(principal.companyId,claim.id,claim.generation,claim.token)
const blocked=await tasks.create(principal,{channelId,objective:'UI blocked task',ingressKey:'ui-blocked',grantIds:[]})
await pool.query(`UPDATE channel_tasks SET status='BLOCKED',blocked_code='UI_WAITING_INPUT' WHERE id=$1`,[blocked.id])
await tasks.create(principal,{channelId,objective:'UI second active task',ingressKey:'ui-second',grantIds:[]})
const profile=await mkdtemp(join(tmpdir(),'cumora-task-ui-profile-'))
const downloads=join(profile,'downloads')
const app=await buildApiTestApp(principal.id)
const serverFailures=[]
const vite=await createServer({server:{middlewareMode:true},appType:'mpa'})
app.use(vite.middlewares)
const {createServer:createHttpServer}=await import('node:http')
const server=createHttpServer((req,res)=>{res.on('finish',()=>{if(res.statusCode>=500)serverFailures.push(`${req.method} ${req.url}: ${res.statusCode}`)});app(req,res)})
server.listen(0,'127.0.0.1')
await new Promise(resolve=>server.once('listening',resolve))
const base=`http://127.0.0.1:${server.address().port}`
const chrome=spawn('google-chrome',['--headless','--no-sandbox','--disable-gpu','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']})
let socket
try{
  const endpoint=await new Promise((resolve,reject)=>{let stderr='';chrome.stderr.on('data',chunk=>{stderr+=chunk;if(stderr.includes('DevTools listening on '))resolve(stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)[1])});chrome.once('error',reject);chrome.once('exit',code=>reject(new Error(`Chrome exited ${code}`)))})
  socket=new WebSocket(endpoint)
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})})
  let counter=0
  const pending=new Map()
  socket.addEventListener('message',event=>{const reply=JSON.parse(event.data);const handler=pending.get(reply.id);if(handler){pending.delete(reply.id);reply.error?handler.reject(new Error(JSON.stringify(reply.error))):handler.resolve(reply.result)}})
  const cdp=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++counter;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,sessionId}))})
  const target=await cdp('Target.createTarget',{url:'about:blank'})
  const {sessionId}=await cdp('Target.attachToTarget',{targetId:target.targetId,flatten:true})
  const evaluate=async expression=>{const reply=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(reply.exceptionDetails)throw new Error(JSON.stringify(reply.exceptionDetails));return reply.result.value}
  const until=async(expression,label)=>{const deadline=Date.now()+20000;while(Date.now()<deadline){if(await evaluate(expression))return;await new Promise(resolve=>setTimeout(resolve,100))}throw new Error(`UI timeout: ${label}`)}
  await cdp('Page.enable',{},sessionId)
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:"Object.defineProperty(crypto,'randomUUID',{value:undefined});Object.defineProperty(crypto,'subtle',{value:undefined});"},sessionId)
  await cdp('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads})
  await cdp('Page.navigate',{url:`${base}/tests/fixtures/task-chat.html`},sessionId)
  await until(`document.querySelectorAll('select').length===2 && document.querySelector('select').options.length===5`,'task lists')
  assert.match(await evaluate(`document.querySelector('#desktop').textContent`),/请选择任务|多个未完成/)
  await evaluate(`document.querySelector('#send').click()`)
  await until(`document.querySelector('#messages').textContent.includes('"failed":true')`,'ambiguous send refused')
  await evaluate(`document.querySelector('#desktop select').value=${JSON.stringify(blocked.id)};document.querySelector('#desktop select').dispatchEvent(new Event('change',{bubbles:true}))`)
  await until(`document.querySelector('#mobile select').value===${JSON.stringify(blocked.id)}`,'desktop/mobile share selection')
  assert.match(await evaluate(`document.querySelector('#desktop').textContent`),/UI_WAITING_INPUT/)
  await evaluate(`document.querySelector('#retry').click()`)
  await until(`!document.querySelector('#messages').textContent.includes('"failed":true') && !document.querySelector('#messages').textContent.includes('"pending":true')`,'retry with selected task')
  const linked=await pool.query(`SELECT l.task_id FROM task_message_links l JOIN messages m ON m.id=l.message_id WHERE m.company_id=$1 AND m.body='Task UI approved supplement'`,[principal.companyId])
  assert.equal(linked.rows[0].task_id,blocked.id)
  await evaluate(`Array.from(document.querySelectorAll('#desktop button')).find(button=>button.textContent==='继续执行').click()`)
  await until(`!document.querySelector('#desktop').textContent.includes('阻塞原因')`,'drive resumes task')
  await evaluate(`Array.from(document.querySelectorAll('#desktop button')).find(button=>button.textContent==='取消任务').click()`)
  await until(`document.querySelector('#desktop select').selectedOptions[0].textContent.includes('已取消')`,'task cancellation')
  assert.doesNotMatch(await evaluate(`document.querySelector('#desktop').textContent`),/阻塞原因/)
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},sessionId)
  await evaluate(`document.querySelector('#mobile select').value=${JSON.stringify(completed.id)};document.querySelector('#mobile select').dispatchEvent(new Event('change',{bubbles:true}))`)
  await until(`document.querySelector('#mobile').textContent.includes('下载产物')`,'mobile delivery link')
  await evaluate(`Array.from(document.querySelectorAll('#mobile button')).find(button=>button.textContent.includes('下载产物')).click()`)
  const deadline=Date.now()+10000
  let files=[]
  while(Date.now()<deadline){files=await readdir(downloads).catch(()=>[]);if(files.some(file=>file.endsWith('.txt')))break;await new Promise(resolve=>setTimeout(resolve,100))}
  assert.equal(await readFile(join(downloads,files.find(file=>file.endsWith('.txt'))),'utf8'),'UI_VERIFIED_ARTIFACT')
  await tasks.revokeGrant(principal,grant)
  await evaluate(`Array.from(document.querySelectorAll('#mobile button')).find(button=>button.textContent.includes('下载产物')).click()`)
  await until(`document.querySelector('#mobile [role=alert]')?.textContent.includes('SOURCE_REVOKED')`,'revoked artifact download refused')
  assert.deepEqual(serverFailures,[], 'UI must not hide API failures')
  console.log(JSON.stringify({passed:7,skipped:0,checks:['ambiguous send rollback','shared desktop/mobile selection','retry selected task','blocked state','drive/cancel','authenticated hash-checked download','revoked download denial']}))
}finally{
  socket?.close();chrome.kill('SIGKILL');await vite.close();await teardownAll(server);await rm(profile,{recursive:true,force:true})
}
