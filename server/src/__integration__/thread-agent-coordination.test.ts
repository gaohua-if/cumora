import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { pool } from '../db/pool.js'
import { ensureSchemaOnce, resetAllTables, seedUserMembership, buildApiTestApp, teardownAll } from './_helpers.js'
import { TaskService } from '../tasks/service.js'
import { threadService } from '../tasks/threads.js'
import { threadScope, type ThreadScope } from '../tasks/thread-scope.js'
import { inprocClient } from '../agents/runtime/inproc-client.js'
import { storage, UPLOAD_DIR } from '../storage.js'
import { signAgentToken } from '../agents/runtime/jwt.js'

before(ensureSchemaOnce); beforeEach(resetAllTables); after(async () => { await teardownAll() })
const actor = { companyId: 'thread-test', id: 'thread-owner' }
const tasks = new TaskService(pool)
let serial = 0
async function fixture() {
  await pool.query(`INSERT INTO companies(id,name,slug,owner_user_id) VALUES($1,'Thread',$1,$2)`, [actor.companyId, actor.id])
  await seedUserMembership(actor.id, actor.companyId)
  await pool.query(`UPDATE company_members SET role='owner' WHERE company_id=$1 AND user_id=$2`, [actor.companyId, actor.id])
  await pool.query(`INSERT INTO computers(id,company_id,name,kind,status,available_engines) VALUES('thread-local',$1,'Local','local','online','["codex","claude"]')`, [actor.companyId])
  for (const [id, name] of [['thread-aida', 'Aida'], ['thread-atlas', 'Atlas'], ['thread-bram', 'Bram']]) await pool.query(`INSERT INTO participants(id,company_id,kind,name,initial,avatar_bg,status,computer_id,engine)
    VALUES($1,$2,'agent',$3,'A','#fff','avail','thread-local','codex')`, [id, actor.companyId, name])
  await pool.query(`INSERT INTO conversations(id,company_id,kind,title,members) VALUES('thread-group',$1,'group','Threads',$2)`, [actor.companyId, JSON.stringify([actor.id, 'thread-aida', 'thread-atlas', 'thread-bram'])])
  const definition = await tasks.define(actor, 'thread-definition', { name: 'Agent', role: 'WORK', instructions: 'Do this task' })
  for (const id of ['thread-aida', 'thread-atlas', 'thread-bram']) await tasks.bind(actor, { channelId: 'thread-group', agentId: id, definitionVersionId: definition, alias: id, isDefault: id === 'thread-aida' })
}
async function human(body: string, quoted?: string, attachment?: unknown) {
  return tasks.transaction(actor.companyId, async client => {
    const id = `thread-message-${++serial}`
    const sequence = (await client.query(`INSERT INTO conversation_counters(conversation_id,next_sequence) VALUES('thread-group',2) ON CONFLICT(conversation_id) DO UPDATE SET next_sequence=conversation_counters.next_sequence+1 RETURNING next_sequence-1 AS n`)).rows[0].n
    await client.query(`INSERT INTO messages(id,company_id,conversation_id,author_id,body,kind,sequence,quoted_message_id,attachment) VALUES($1,$2,'thread-group',$3,$4,'text',$5,$6,$7)`, [id, actor.companyId, actor.id, body, sequence, quoted ?? null, attachment ? JSON.stringify(attachment) : null])
    await threadService.ingress(client, actor, id)
    return id
  })
}
function scope(threadId: string, agentId = 'thread-aida', round = 1): ThreadScope { return { threadId, agentId, round, companyId: actor.companyId } }

test('two task threads isolate reads, nested quotes and multiple task rounds', async () => {
  await fixture()
  const first = await human('first task'), second = await human('second task')
  assert.notEqual(first, second)
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM channel_tasks WHERE execution_kind='CHAT'`)).rows[0].n, 2)
  assert.deepEqual((await inprocClient.loadInbox('thread-aida')).map(m => m.id), [])
  const rows = await threadScope.run(scope(first), () => inprocClient.loadInbox('thread-aida'))
  assert.deepEqual(rows.map(m => m.id), [first])
  await pool.query(`INSERT INTO thread_reads(thread_id,agent_id,sequence) VALUES($1,'thread-aida',$2)`, [second, serial])
  assert.deepEqual((await threadScope.run(scope(first), () => inprocClient.loadInbox('thread-aida'))).map(m => m.id), [first])
  await threadService.summary(scope(first), 'first done')
  const summary = (await pool.query(`SELECT result_message_id FROM thread_work WHERE thread_id=$1 AND role='coordinator'`, [first])).rows[0].result_message_id
  const followup = await human('continue first', summary)
  assert.equal((await pool.query(`SELECT thread_id FROM messages WHERE id=$1`, [followup])).rows[0].thread_id, first)
  assert.equal((await threadService.detail(actor.companyId, first))!.round, 2)
  assert.equal((await threadService.detail(actor.companyId, second))!.round, 1)
  await assert.rejects(threadService.summary(scope(first), 'late first round'), /STALE_THREAD_CONTEXT/)
  await threadService.cli(scope(first, 'thread-aida', 2), ['inbox'])
  await human('queued while first is executing', first)
  await threadService.summary(scope(first, 'thread-aida', 2), 'round two finished')
  assert.equal((await threadService.detail(actor.companyId, first))!.round, 3)
  await threadService.finish(scope(first, 'thread-aida', 3), 'account unavailable')
  assert.equal((await threadService.detail(actor.companyId, first))!.status, 'awaiting_input')
})

test('multi-member plan aggregates peer mentions, blockers, artifacts and idempotent delivery', async () => {
  await fixture(); const id = await human('compare using two members')
  const plan = [{ agentId: 'thread-atlas', objective: 'provide source' }, { agentId: 'thread-bram', objective: 'compare sources' }]
  await threadService.delegate(scope(id), plan)
  await threadService.delegate(scope(id), plan)
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM thread_work WHERE thread_id=$1`, [id])).rows[0].n, 3)
  await assert.rejects(threadService.delegate(scope(id, 'thread-atlas'), [{ agentId: 'thread-bram', objective: 'recursive' }]), /RECURSIVE/)
  await assert.rejects(threadService.summary(scope(id), 'premature'), /MEMBERS_PENDING/)
  await threadService.result(scope(id, 'thread-atlas'), 'blocked', 'Need official source @thread-bram')
  assert.equal((await threadService.detail(actor.companyId, id))!.status, 'waiting')
  await threadService.result(scope(id, 'thread-bram'), 'completed', 'Partial matrix @thread-atlas RESULT_OK')
  await threadService.result(scope(id, 'thread-bram'), 'completed', 'Partial matrix @thread-atlas RESULT_OK')
  await assert.rejects(threadService.result(scope(id, 'thread-bram'), 'completed', 'different'), /RESULT_CONFLICT/)
  const detail = (await threadService.detail(actor.companyId, id))!
  assert.equal(detail.status, 'aggregating')
  const results = (await pool.query(`SELECT m.work_recipient_ids FROM messages m JOIN thread_work w ON w.result_message_id=m.id WHERE w.thread_id=$1`, [id])).rows
  assert.ok(results.every(r => r.work_recipient_ids.length === 0))
  const aggregation = (await pool.query(`SELECT * FROM messages WHERE thread_id=$1 AND kind='system'`, [id])).rows
  assert.equal(aggregation.length, 1); assert.deepEqual(aggregation[0].work_recipient_ids, ['thread-aida'])
  await threadService.summary(scope(id), 'Here are both results and blockers')
  await threadService.summary(scope(id), 'Here are both results and blockers')
  assert.equal((await threadService.detail(actor.companyId, id))!.status, 'awaiting_input')
  const deliveries = (await pool.query(`SELECT d.* FROM task_deliveries d JOIN channel_tasks t ON t.id=d.task_id WHERE t.root_task_id=$1`, [detail.taskId])).rows
  assert.equal(deliveries.length, 3)
  assert.ok(deliveries.find(d => d.task_id === detail.taskId).summary.includes('待补充'))
  const rootArtifact = (await pool.query(`SELECT input_version_ids FROM artifact_versions WHERE task_id=$1`, [detail.taskId])).rows[0]
  assert.equal(rootArtifact.input_version_ids.length, 2)
})

test('invalid plans roll back, finish and persisted timeout recover without duplicate aggregation', async () => {
  await fixture(); const id = await human('timeout test')
  await assert.rejects(threadService.delegate(scope(id), [{ agentId: 'thread-atlas', objective: 'valid' }, { agentId: 'outside', objective: 'invalid' }]), /INVALID_THREAD_MEMBER/)
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM thread_work WHERE thread_id=$1`, [id])).rows[0].n, 1)
  await threadService.delegate(scope(id), [{ agentId: 'thread-atlas', objective: 'never responds' }, { agentId: 'thread-bram', objective: 'crashes' }])
  await threadService.finish(scope(id, 'thread-bram'), 'engine crashed')
  await pool.query(`UPDATE thread_work SET deadline=NOW()-INTERVAL '1 minute' WHERE thread_id=$1 AND agent_id='thread-atlas'`, [id])
  await threadService.expire(actor.companyId); await threadService.expire(actor.companyId)
  assert.equal((await threadService.detail(actor.companyId, id))!.status, 'aggregating')
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM messages WHERE thread_id=$1 AND kind='system'`, [id])).rows[0].n, 1)
  await assert.rejects(threadService.result(scope(id, 'thread-atlas'), 'completed', 'late'), /RESULT_CONFLICT/)
  await threadService.summary(scope(id), 'Failed and timed out; please retry')
  assert.equal((await threadService.detail(actor.companyId, id))!.status, 'awaiting_input')
})

test('HTTP auto ingress, scoped runtime tools, reads, session evidence and protected mode remain consistent', async () => {
  await fixture()
  const apiApp = await buildApiTestApp(actor.id)
  const { runtimeRouter } = await import('../agents/runtime/server.js')
  apiApp.use('/runtime', runtimeRouter)
  const server = apiApp.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`
  const request = (path: string, body?: unknown, token?: string) => fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-company-id': actor.companyId, ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  try {
    const created = await request('/api/conversations/thread-group/messages', { body: 'HTTP native task', clientId: 'http-thread' })
    assert.equal(created.status, 202); const message = await created.json() as any; assert.equal(message.threadId, message.id)
    const repeated = await request('/api/conversations/thread-group/messages', { body: 'HTTP native task', clientId: 'http-thread' })
    assert.equal((await repeated.json() as any).threadId, message.id)
    const placement = (await pool.query(`SELECT runtime_assignment_id FROM participants WHERE id='thread-aida'`)).rows[0].runtime_assignment_id
    const token = signAgentToken({ agentId: 'thread-aida', companyId: actor.companyId, computerId: 'thread-local', assignmentId: placement, threadId: message.id, threadRound: 1 })
    const inbox = await request('/runtime/inbox', undefined, token); assert.equal(inbox.status, 200); assert.equal((await inbox.json() as any).rows.length, 1)
    const run = await request('/runtime/runs', { trigger: { source: 'test' } }, token); assert.equal(run.status, 200); const runId = (await run.json() as any).runId
    const beforeContext = (await pool.query(`SELECT runtime FROM task_execution_contexts WHERE id=(SELECT task_context_id FROM agent_runs WHERE id=$1)`, [runId])).rows[0].runtime
    const brief = await request('/runtime/threads/brief', undefined, token); assert.equal(brief.status, 200)
    assert.match((await brief.json() as any).text, /HTTP native task/)
    assert.deepEqual((await pool.query(`SELECT runtime FROM task_execution_contexts WHERE id=(SELECT task_context_id FROM agent_runs WHERE id=$1)`, [runId])).rows[0].runtime, beforeContext)
    assert.equal((await pool.query(`SELECT task_context_id FROM agent_runs WHERE id=$1`, [runId])).rows[0].task_context_id != null, true)
    assert.equal((await request('/runtime/threads/session', { sessionId: 'session-one', engine: 'codex', sessionScope: 'scope-one' }, token)).status, 200)
    const escaped = await request('/runtime/cli', { argv: ['messages', 'outside-channel'] }, token); assert.equal(escaped.status, 409)
    const posted = await request('/runtime/cli', { argv: ['thread', 'summary', 'HTTP_DONE'] }, token); assert.equal(posted.status, 200)
    assert.equal((await request(`/runtime/runs/${runId}/finish`, { status: 'completed' }, token)).status, 200)
    const replies = await request(`/api/conversations/thread-group/messages/${message.id}/replies`); assert.equal(replies.status, 200); assert.equal((await replies.json() as any[])[0].threadId, message.id)
    const detail = await request(`/api/conversations/thread-group/threads/${message.id}`); assert.equal((await detail.json() as any).status, 'completed')
    await pool.query(`INSERT INTO task_workspace_settings(company_id,mode) VALUES($1,'TASK')`, [actor.companyId])
    assert.equal((await request('/runtime/inbox', undefined, token)).status, 403)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})


test('attachment-only input resumes blocked/completed threads and scoped tools refresh metadata', async () => {
  await fixture()
  const att = { name: 'source.pdf', kind: 'pdf', mime: 'application/pdf', size: 321, key: 'attachments/thread-source.pdf', url: 'http://expired.invalid/source.pdf' }
  const first = await human('', undefined, att)
  const original = (await threadService.detail(actor.companyId, first))!
  assert.match((await pool.query('SELECT objective FROM channel_tasks WHERE id=$1', [original.taskId])).rows[0].objective, /source.pdf/)
  await threadService.summary(scope(first), 'Need more source', true)
  const supplement = await human('', first, att)
  const resumed = (await threadService.detail(actor.companyId, first))!
  assert.equal(resumed.round, 2); assert.equal(resumed.status, 'working'); assert.notEqual(resumed.taskId, original.taskId)
  const input = (await pool.query('SELECT content,reference_id,provenance FROM task_inputs WHERE task_id=$1', [resumed.taskId])).rows[0]
  assert.match(input.content, /source.pdf/); assert.equal(input.reference_id, supplement)
  assert.equal(input.provenance.sources[0].id, supplement)
  const previous = storage.publicUrl
  const refreshedKeys: string[] = []
  storage.publicUrl = async key => { refreshedKeys.push(key); return `http://fresh.test/${key}` }
  try {
    for (const argv of [['inbox'], ['messages', 'thread-group']]) {
      const output = await threadService.cli(scope(first, 'thread-aida', 2), argv)
      assert.match(output!.text, /http:\/\/fresh.test\/attachments\/thread-source.pdf/)
      assert.match(output!.text, /application\/pdf/); assert.match(output!.text, /"size":321/)
    }
    assert.equal(refreshedKeys.length, 4)
    assert.equal((await pool.query('SELECT attachment FROM messages WHERE id=$1', [supplement])).rows[0].attachment.url, att.url)
    await threadService.summary(scope(first, 'thread-aida', 2), 'File accepted')
    await human('', first, att)
    assert.equal((await threadService.detail(actor.companyId, first))!.round, 3)
  } finally { storage.publicUrl = previous }
})

test('HTTP channel pages contain roots before LIMIT and attachment-only follow-up reaches brief', async () => {
  await fixture()
  const first = await human('First root'), second = await human('Second root')
  for (let n=0;n<3;n++) await threadService.cli(scope(second), ['reply', 'thread-group', `child-${n}`])
  await threadService.summary(scope(first), 'Please attach source', true)
  const app = await buildApiTestApp(actor.id)
  const { runtimeRouter } = await import('../agents/runtime/server.js'); app.use('/runtime', runtimeRouter)
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r))
  const address=server.address(); assert.ok(address && typeof address!=='string')
  const base=`http://127.0.0.1:${address.port}`
  const request=(path: string, body?: unknown, token?: string)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-company-id':actor.companyId,...(token?{authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})})
  try {
    const page=await request('/api/conversations/thread-group/messages?view=channel&limit=1')
    assert.equal(page.status,200); const rows=await page.json() as any[]; assert.deepEqual(rows.map(m=>m.id),[second]);assert.equal(rows[0].replyCount,3)
    const older=await request(`/api/conversations/thread-group/messages?view=channel&limit=1&before=${rows[0].sequence}`)
    assert.deepEqual((await older.json() as any[]).map(m=>m.id),[first])
    const defaultPage=await request('/api/conversations/thread-group/messages?limit=1')
    const latest=(await defaultPage.json() as any[])[0]; assert.notEqual(latest.id,first);assert.equal(latest.threadId,first)
    const exact=await request(`/api/conversations/thread-group/messages?messageId=${first}&limit=1`)
    assert.deepEqual((await exact.json() as any[]).map(m=>m.id),[first])
    const attachment={url:'/uploads/attachments/http-source.pdf',key:'attachments/http-source.pdf',name:'provided.pdf',kind:'pdf',mime:'application/pdf',size:42}
    const sent=await request('/api/conversations/thread-group/messages',{body:'',attachment,quotedMessageId:first,clientId:'http-only-file'})
    assert.equal(sent.status,202);assert.equal((await sent.json() as any).threadId,first)
    const detail=(await threadService.detail(actor.companyId,first))!;assert.equal(detail.round,2);assert.equal(detail.status,'working')
    const placement=(await pool.query(`SELECT runtime_assignment_id FROM participants WHERE id='thread-aida'`)).rows[0].runtime_assignment_id
    const token=signAgentToken({agentId:'thread-aida',companyId:actor.companyId,computerId:'thread-local',assignmentId:placement,threadId:first,threadRound:2})
    const brief=await request('/runtime/threads/brief',undefined,token);assert.equal(brief.status,200)
    const text=(await brief.json() as any).text;assert.match(text,/provided.pdf/);assert.match(text,/application\/pdf/);assert.match(text,/attachments\/http-source.pdf/)
  } finally {await new Promise<void>(r=>server.close(()=>r()))}
})


test('scoped local attachment reader returns actual text and rejects unrelated or binary files', async () => {
  await fixture()
  const key='attachments/thread-read-test.txt'
  await storage.put(key,Buffer.from('actual hidden value: 42'), 'text/plain')
  const att={name:'source.txt',kind:'file',mime:'text/plain',key,url:'/uploads/'+key}
  try {
    const first=await human('',undefined,att),second=await human('different thread')
    const output=await threadService.cli(scope(first),['thread','attachment',first])
    assert.equal(JSON.parse(output!.text).content,'actual hidden value: 42')
    await assert.rejects(threadService.cli(scope(second),['thread','attachment',first]),/THREAD_ATTACHMENT_NOT_FOUND/)
    const pdf=await human('',first,{...att,mime:'application/pdf',kind:'pdf'})
    await assert.rejects(threadService.cli(scope(first),['thread','attachment',pdf]),/ATTACHMENT_TEXT_FORMAT_UNSUPPORTED/)
  } finally { await rm(resolve(UPLOAD_DIR,key),{force:true}) }
})
