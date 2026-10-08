import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool } from '../db/pool.js'
import { CH_MESSAGE_NEW } from '../redis.js'
import { enqueueBroadcast, nudgeRealtimeOutbox } from '../realtime-outbox.js'
import { TaskError, hashContent, canonicalJson } from './contracts.js'
import { TaskService, type TaskPrincipal } from './service.js'
import { freshenAttachmentUrl, messageAttachmentStorageKey, storage, UPLOAD_DIR, type StoredAttachment } from '../storage.js'
import { messageInputText } from './message-input.js'
import type { ThreadScope } from './thread-scope.js'

const terminal = ['completed', 'blocked', 'failed', 'timed_out']
const tasks = new TaskService(pool)
type Thread = { id: string; company_id: string; conversation_id: string; coordinator_id: string; root_task_id: string; round: number; status: string }
type Work = { agent_id: string; task_id: string; context_id: string; role: string; state: string; result: string | null; artifact_id: string | null }

/** Native local chat adapter. Never claims sandbox-qualified TASK execution. */
export class ThreadService {
  async ingress(client: PoolClient, actor: TaskPrincipal, messageId: string): Promise<string | null> {
    const message = (await client.query(`SELECT * FROM messages WHERE id=$1 AND company_id=$2`, [messageId, actor.companyId])).rows[0]
    if (!message || message.kind !== 'text' || (!message.body.trim() && !message.attachment)) return null
    const objective = messageInputText(message.body, message.attachment).slice(0, 12000)
    let thread: Thread | undefined
    if (message.thread_id) thread = (await client.query<Thread>(`SELECT * FROM conversation_threads WHERE id=$1 FOR UPDATE`, [message.thread_id])).rows[0]
    if (!thread) {
      const binding = (await client.query(`SELECT b.id,b.agent_id FROM channel_agent_bindings b JOIN participants p ON p.id=b.agent_id AND p.company_id=b.company_id
        WHERE b.company_id=$1 AND b.conversation_id=$2 AND b.status='ACTIVE' AND (b.is_default OR lower(p.name)='aida')
          AND b.agent_id=ANY($3::text[]) ORDER BY b.is_default DESC,b.id LIMIT 1`, [actor.companyId, message.conversation_id, message.work_recipient_ids ?? []])).rows[0]
      if (!binding) return null
      const task = await tasks.create(actor, { channelId: message.conversation_id, bindingId: binding.id, objective, messageId, ingressKey: `thread:${messageId}:1`, grantIds: [] }, client)
      await client.query(`UPDATE channel_tasks SET execution_kind='CHAT' WHERE id=$1`, [task.id])
      thread = (await client.query<Thread>(`INSERT INTO conversation_threads(id,company_id,conversation_id,coordinator_id,root_task_id)
        VALUES($1,$2,$3,$4,$5) RETURNING *`, [messageId, actor.companyId, message.conversation_id, binding.agent_id, task.id])).rows[0]
      await this.work(client, thread, task.id, binding.agent_id, 'coordinator')
    } else if (['completed', 'awaiting_input'].includes(thread.status)) {
      const binding = (await client.query(`SELECT id FROM channel_agent_bindings WHERE company_id=$1 AND conversation_id=$2 AND agent_id=$3 AND status='ACTIVE'`, [actor.companyId, thread.conversation_id, thread.coordinator_id])).rows[0]
      if (!binding) throw new TaskError('BINDING_INELIGIBLE', 409)
      const round = thread.round + 1
      const task = await tasks.create(actor, { channelId: thread.conversation_id, bindingId: binding.id, objective, messageId, ingressKey: `thread:${thread.id}:${round}`, grantIds: [] }, client)
      await client.query(`UPDATE channel_tasks SET execution_kind='CHAT' WHERE id=$1`, [task.id])
      thread = (await client.query<Thread>(`UPDATE conversation_threads SET root_task_id=$2,round=$3,status='working',updated_at=NOW() WHERE id=$1 RETURNING *`, [thread.id, task.id, round])).rows[0]
      await this.work(client, thread, task.id, thread.coordinator_id, 'coordinator')
    } else {
      // Supplements belong to this explicit thread, never the newest channel task.
      const task = (await client.query(`SELECT * FROM channel_tasks WHERE id=$1`, [thread.root_task_id])).rows[0]
      await client.query(`UPDATE channel_tasks SET input_revision=input_revision+1 WHERE id=$1`, [task.id])
      task.input_revision += 1
      await tasks.addInput(client, actor, task, { messageId })
      if (thread.status === 'working') await client.query(`UPDATE thread_work SET deadline=NOW()+INTERVAL '15 minutes' WHERE thread_id=$1 AND round=$2 AND role='coordinator'`, [thread.id, thread.round])
    }
    await client.query(`UPDATE messages SET thread_id=$2,work_recipient_ids=ARRAY[$3]::text[] WHERE id=$1`, [messageId, thread.id, thread.coordinator_id])
    return thread.id
  }

  private async work(client: PoolClient, thread: Thread, taskId: string, agentId: string, role: string): Promise<void> {
    const record = (await client.query(`SELECT t.*,b.eligibility_version,b.version AS binding_version,p.runtime_assignment_id,p.computer_id,p.engine
      FROM channel_tasks t JOIN channel_agent_bindings b ON b.id=t.accountable_binding_id AND b.company_id=t.company_id
      JOIN participants p ON p.id=b.agent_id AND p.company_id=b.company_id WHERE t.id=$1`, [taskId])).rows[0]
    const inputIds = (await client.query(`SELECT id FROM task_inputs WHERE task_id=$1`, [taskId])).rows.map(row => row.id)
    const contextId = randomUUID()
    await client.query(`INSERT INTO task_execution_contexts(id,company_id,task_id,binding_id,scope_revision,input_revision,workspace_generation,binding_version,assignment_id,computer_id,runtime,configuration,input_ids,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,NOW()+INTERVAL '15 minutes')`,
    [contextId, thread.company_id, taskId, record.accountable_binding_id, record.scope_revision, record.input_revision, record.eligibility_version ?? record.binding_version,
      record.runtime_assignment_id, record.computer_id, { kind: 'native-chat', engine: record.engine, threadId: thread.id, round: thread.round }, record.configuration, JSON.stringify(inputIds)])
    await client.query(`INSERT INTO thread_work(thread_id,round,agent_id,task_id,context_id,role) VALUES($1,$2,$3,$4,$5,$6)`, [thread.id, thread.round, agentId, taskId, contextId, role])
  }

  async authorize(scope: ThreadScope, client: PoolClient | typeof pool = pool): Promise<boolean> {
    return Boolean((await client.query(`SELECT 1 FROM conversation_threads t JOIN thread_work w ON w.thread_id=t.id AND w.round=t.round
      JOIN conversation_members m ON m.conversation_id=t.conversation_id AND m.company_id=t.company_id AND m.participant_id=w.agent_id
      JOIN channel_tasks task ON task.id=w.task_id JOIN channel_agent_bindings b ON b.id=task.accountable_binding_id AND b.status='ACTIVE'
      JOIN participants p ON p.id=w.agent_id AND p.company_id=t.company_id AND p.departed_at IS NULL
      WHERE t.id=$1 AND t.round=$2 AND t.company_id=$3 AND w.agent_id=$4`, [scope.threadId, scope.round, scope.companyId, scope.agentId])).rowCount)
  }

  private async locked(client: PoolClient, scope: ThreadScope): Promise<{ thread: Thread; work: Work }> {
    const thread = (await client.query<Thread>(`SELECT * FROM conversation_threads WHERE id=$1 AND company_id=$2 FOR UPDATE`, [scope.threadId, scope.companyId])).rows[0]
    if (!thread || thread.round !== scope.round || !await this.authorize(scope, client)) throw new TaskError('STALE_THREAD_CONTEXT', 409)
    const work = (await client.query<Work>(`SELECT * FROM thread_work WHERE thread_id=$1 AND round=$2 AND agent_id=$3`, [thread.id, thread.round, scope.agentId])).rows[0]
    return { thread, work }
  }

  async detail(companyId: string, id: string) {
    const thread = (await pool.query<Thread>(`SELECT * FROM conversation_threads WHERE id=$1 AND company_id=$2`, [id, companyId])).rows[0]
    if (!thread) return null
    const members = (await pool.query(`SELECT w.agent_id AS "agentId",p.name,w.role,w.state,w.result,w.task_id AS "taskId",w.context_id AS "contextId",w.engine_session_id AS "sessionId",w.artifact_id AS "artifactId"
      FROM thread_work w JOIN participants p ON p.id=w.agent_id AND p.company_id=$3 WHERE w.thread_id=$1 AND w.round=$2 ORDER BY w.role,w.agent_id`, [id, thread.round, companyId])).rows
    return { id: thread.id, conversationId: thread.conversation_id, round: thread.round, status: thread.status, taskId: thread.root_task_id, members }
  }

  async next(companyId: string, agentId: string) {
    await this.expire(companyId)
    const row = (await pool.query(`SELECT t.id AS "threadId",t.company_id AS "companyId",t.round,t.conversation_id AS "conversationId",w.context_id AS "contextId"
      FROM thread_work w JOIN conversation_threads t ON t.id=w.thread_id AND t.round=w.round
      WHERE t.company_id=$1 AND w.agent_id=$2 AND w.state IN ('pending','running','aggregating')
      AND NOT EXISTS(SELECT 1 FROM agent_runs r WHERE r.task_context_id=w.context_id AND r.status='running' AND r.updated_at>NOW()-INTERVAL '90 seconds')
      AND EXISTS(SELECT 1 FROM conversation_members m WHERE m.company_id=t.company_id AND m.conversation_id=t.conversation_id AND m.participant_id=w.agent_id)
      ORDER BY w.updated_at,t.id LIMIT 1`, [companyId, agentId])).rows[0]
    return row ?? null
  }

  async start(scope: ThreadScope, runId: string): Promise<void> {
    await tasks.transaction(scope.companyId, async client => {
      const { work } = await this.locked(client, scope)
      if (terminal.includes(work.state) || work.state === 'waiting') throw new TaskError('THREAD_WORK_CLOSED', 409)
      if ((await client.query(`SELECT 1 FROM agent_runs WHERE task_context_id=$1 AND id<>$2 AND status='running' AND updated_at>NOW()-INTERVAL '90 seconds'`, [work.context_id, runId])).rowCount) throw new TaskError('THREAD_WORK_BUSY', 409)
      await client.query(`UPDATE thread_work SET state=CASE WHEN state='pending' THEN 'running' ELSE state END WHERE thread_id=$1 AND round=$2 AND agent_id=$3`, [scope.threadId, scope.round, scope.agentId])
      await client.query(`UPDATE agent_runs SET task_context_id=$2,trigger=trigger || $4::jsonb WHERE id=$1 AND agent_id=$3`, [runId, work.context_id, scope.agentId, JSON.stringify({ threadId: scope.threadId, threadRound: scope.round, threadState: work.state })])
    })
  }

  private async post(client: PoolClient, thread: Thread, author: string, text: string, recipients: string[] = [], kind = 'text', quotedId = thread.id): Promise<string> {
    const id = 'm-' + randomUUID()
    const seq = (await client.query(`INSERT INTO conversation_counters(conversation_id,next_sequence) VALUES($1,2)
      ON CONFLICT(conversation_id) DO UPDATE SET next_sequence=conversation_counters.next_sequence+1 RETURNING next_sequence-1 AS seq`, [thread.conversation_id])).rows[0].seq
    await client.query(`INSERT INTO messages(id,company_id,conversation_id,author_id,body,kind,sequence,thread_id,quoted_message_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, thread.company_id, thread.conversation_id, author, text, kind, seq, thread.id, quotedId])
    await client.query(`UPDATE messages SET work_recipient_ids=$2::text[] WHERE id=$1`, [id, recipients])
    const quoted = (await client.query(`SELECT m.id,m.author_id AS "authorId",p.name AS "authorName",m.kind,LEFT(m.body,240) AS body,m.sequence
      FROM messages m LEFT JOIN participants p ON p.id=m.author_id AND p.company_id=m.company_id WHERE m.id=$1 AND m.company_id=$2 AND m.thread_id=$3`, [quotedId, thread.company_id, thread.id])).rows[0]
    await enqueueBroadcast(client, CH_MESSAGE_NEW, { type: 'message.new', companyId: thread.company_id, conversationId: thread.conversation_id,
      message: { id, conversationId: thread.conversation_id, authorId: author, kind, body: text, sequence: seq, threadId: thread.id, quotedMessageId: quotedId, quoted, at: new Date().toISOString() } })
    nudgeRealtimeOutbox()
    return id
  }

  async delegate(scope: ThreadScope, members: Array<{ agentId: string; objective: string }>): Promise<void> {
    if (!Array.isArray(members) || !members.length || members.length > 8 || new Set(members.map(m => m.agentId)).size !== members.length || members.some(m => typeof m.agentId !== 'string' || typeof m.objective !== 'string' || !m.objective.trim() || m.objective.length > 12000)) throw new TaskError('INVALID_THREAD_PLAN', 400)
    await tasks.transaction(scope.companyId, async client => {
      const { thread, work } = await this.locked(client, scope)
      if (work.role !== 'coordinator') throw new TaskError('RECURSIVE_DELEGATION_DENIED', 409)
      const old = (await client.query(`SELECT plan FROM task_plan_versions WHERE task_id=$1 ORDER BY revision DESC LIMIT 1`, [work.task_id])).rows[0]
      if (old) {
        if (canonicalJson(old.plan.members) === canonicalJson(members)) return
        throw new TaskError('THREAD_PLAN_ALREADY_SUBMITTED', 409)
      }
      if (thread.status !== 'working' || terminal.includes(work.state)) throw new TaskError('THREAD_WORK_CLOSED', 409)
      const root = (await client.query(`SELECT * FROM channel_tasks WHERE id=$1`, [work.task_id])).rows[0]
      for (const member of members) {
        if (member.agentId === scope.agentId) throw new TaskError('INVALID_THREAD_MEMBER', 409)
        const binding = (await client.query(`SELECT b.id FROM channel_agent_bindings b JOIN participants p ON p.id=b.agent_id AND p.company_id=b.company_id
          JOIN conversation_members m ON m.company_id=b.company_id AND m.conversation_id=b.conversation_id AND m.participant_id=b.agent_id
          WHERE b.company_id=$1 AND b.conversation_id=$2 AND b.agent_id=$3 AND b.status='ACTIVE' AND p.departed_at IS NULL`, [scope.companyId, thread.conversation_id, member.agentId])).rows[0]
        if (!binding) throw new TaskError('INVALID_THREAD_MEMBER', 409)
        const child = await tasks.create({ companyId: scope.companyId, id: root.creator_principal_id }, { channelId: thread.conversation_id, objective: member.objective, bindingId: binding.id, ingressKey: `thread:${thread.id}:${thread.round}:${member.agentId}`, grantIds: [] }, client)
        await client.query(`UPDATE channel_tasks SET parent_task_id=$2,root_task_id=$2,execution_kind='CHAT' WHERE id=$1`, [child.id, root.id])
        await this.work(client, thread, child.id, member.agentId, 'member')
        await this.post(client, thread, scope.agentId, `@${member.agentId} ${member.objective}`, [member.agentId])
      }
      await client.query(`INSERT INTO task_plan_versions(id,company_id,task_id,revision,plan,created_by) VALUES($1,$2,$3,1,$4,$5)`, [randomUUID(), scope.companyId, root.id, { kind: 'native-chat', members }, scope.agentId])
      await client.query(`UPDATE thread_work SET state='waiting',deadline=NOW()+INTERVAL '20 minutes' WHERE thread_id=$1 AND round=$2 AND role='coordinator'`, [thread.id, thread.round])
      await client.query(`UPDATE conversation_threads SET status='waiting',updated_at=NOW() WHERE id=$1`, [thread.id])
    })
  }

  private async artifact(client: PoolClient, thread: Thread, work: Work, text: string, messageId: string, state: string, inputVersions: string[] = []): Promise<string> {
    const task = (await client.query(`SELECT * FROM channel_tasks WHERE id=$1`, [work.task_id])).rows[0]
    const inputs = (await client.query(`SELECT provenance FROM task_inputs WHERE task_id=$1 ORDER BY created_at`, [task.id])).rows
    const provenance = inputs[0]?.provenance ?? { companyId: thread.company_id, conversationId: thread.conversation_id, audience: { kind: 'CHANNEL', id: thread.conversation_id }, sources: [{ kind: 'TASK_SCOPE', id: task.id, version: 1 }], destinations: ['task-model', 'artifact', 'channel'] }
    const id = randomUUID()
    await client.query(`INSERT INTO artifact_versions(id,artifact_id,company_id,task_id,producer_binding_id,media_type,content,content_hash,provenance,input_version_ids)
      VALUES($1,$1,$2,$3,$4,'text/plain',$5,$6,$7,$8)`, [id, thread.company_id, task.id, task.accountable_binding_id, Buffer.from(text), hashContent(text), provenance, JSON.stringify(inputVersions)])
    await client.query(`INSERT INTO task_deliveries(id,company_id,task_id,scope_revision,artifact_ids,summary,limitations,message_id,delivery_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(), thread.company_id, task.id, task.scope_revision, JSON.stringify([id]), text, JSON.stringify(state === 'completed' ? [] : [state]), messageId, `thread:${thread.id}:${thread.round}:${work.agent_id}`])
    await client.query(`INSERT INTO task_message_links(company_id,task_id,message_id,purpose) VALUES($1,$2,$3,'DELIVERY') ON CONFLICT DO NOTHING`, [thread.company_id, task.id, messageId])
    await client.query(`UPDATE channel_tasks SET status=$2,blocked_code=$3,updated_at=NOW() WHERE id=$1`, [task.id, state === 'completed' ? 'DELIVERED' : 'BLOCKED', state === 'completed' ? null : state])
    return id
  }

  async result(scope: ThreadScope, state: string, text: string): Promise<void> {
    if (!['completed', 'blocked', 'failed'].includes(state) || !text.trim() || text.length > 50000) throw new TaskError('INVALID_THREAD_RESULT', 400)
    await tasks.transaction(scope.companyId, async client => {
      const { thread, work } = await this.locked(client, scope)
      if (work.role !== 'member') throw new TaskError('COORDINATOR_SUMMARY_REQUIRED', 409)
      if (terminal.includes(work.state)) {
        if (work.state === state && work.result === text) return
        throw new TaskError('THREAD_RESULT_CONFLICT', 409)
      }
      await this.completeMember(client, thread, work, state, text)
      await this.aggregate(client, thread)
    })
  }

  private async completeMember(client: PoolClient, thread: Thread, work: Work, state: string, text: string): Promise<void> {
    const messageId = await this.post(client, thread, work.agent_id, text)
    const artifactId = await this.artifact(client, thread, work, text, messageId, state)
    await client.query(`UPDATE thread_work SET state=$4,result=$5,result_message_id=$6,artifact_id=$7,updated_at=NOW() WHERE thread_id=$1 AND round=$2 AND agent_id=$3`, [thread.id, thread.round, work.agent_id, state, text, messageId, artifactId])
  }

  private async aggregate(client: PoolClient, thread: Thread): Promise<void> {
    const members = (await client.query<Work>(`SELECT * FROM thread_work WHERE thread_id=$1 AND round=$2 AND role='member' ORDER BY agent_id`, [thread.id, thread.round])).rows
    if (!members.length || members.some(m => !terminal.includes(m.state)) || thread.status !== 'waiting') return
    await client.query(`UPDATE conversation_threads SET status='aggregating',updated_at=NOW() WHERE id=$1`, [thread.id])
    const root = (await client.query(`SELECT accountable_binding_id FROM channel_tasks WHERE id=$1`, [thread.root_task_id])).rows[0]
    for (const member of members) if (member.artifact_id) await client.query(`INSERT INTO artifact_handoffs(company_id,version_id,consumer_task_id,consumer_binding_id,content_hash)
      SELECT company_id,id,$2,$3,content_hash FROM artifact_versions WHERE id=$1 AND company_id=$4 ON CONFLICT DO NOTHING`, [member.artifact_id, thread.root_task_id, root.accountable_binding_id, thread.company_id])
    await client.query(`UPDATE thread_work SET state='aggregating',deadline=NOW()+INTERVAL '15 minutes',updated_at=NOW() WHERE thread_id=$1 AND round=$2 AND role='coordinator'`, [thread.id, thread.round])
    await this.post(client, thread, thread.coordinator_id, '成员结果已归集，正在汇总。\n' + members.map(m => `${m.agent_id}: ${m.state}\n${m.result ?? ''}`).join('\n\n'), [thread.coordinator_id], 'system')
  }

  async summary(scope: ThreadScope, text: string, forceBlocked = false): Promise<void> {
    if (!text.trim() || text.length > 50000) throw new TaskError('INVALID_THREAD_SUMMARY', 400)
    await tasks.transaction(scope.companyId, async client => {
      const { thread, work } = await this.locked(client, scope)
      if (work.role !== 'coordinator') throw new TaskError('COORDINATOR_REQUIRED', 409)
      if (terminal.includes(work.state)) {
        if (work.result === text) return
        throw new TaskError('THREAD_RESULT_CONFLICT', 409)
      }
      if (thread.status === 'waiting') throw new TaskError('THREAD_MEMBERS_PENDING', 409)
      const members = (await client.query<Work>(`SELECT * FROM thread_work WHERE thread_id=$1 AND round=$2 AND role='member'`, [thread.id, thread.round])).rows
      const blocked = forceBlocked || members.some(m => m.state !== 'completed')
      const body = blocked ? `${text}\n\n待补充：${members.filter(m => m.state !== 'completed').map(m => `${m.agent_id}（${m.state}）：${m.result ?? '缺少结果'}`).join('\n')}` : text
      const messageId = await this.post(client, thread, scope.agentId, body)
      const artifactId = await this.artifact(client, thread, work, body, messageId, blocked ? 'blocked' : 'completed', members.flatMap(m => m.artifact_id ? [m.artifact_id] : []))
      await client.query(`UPDATE thread_work SET state=$4,result=$5,result_message_id=$6,artifact_id=$7,updated_at=NOW() WHERE thread_id=$1 AND round=$2 AND agent_id=$3`, [thread.id, thread.round, scope.agentId, blocked ? 'blocked' : 'completed', text, messageId, artifactId])
      await client.query(`UPDATE conversation_threads SET status=$2,updated_at=NOW() WHERE id=$1`, [thread.id, blocked ? 'awaiting_input' : 'completed'])
      // A follow-up arriving after the model's snapshot is queued as another
      // Task round. It must not disappear when the older turn summarizes.
      const consumed = (await client.query(`SELECT sequence FROM thread_reads WHERE thread_id=$1 AND agent_id=$2`, [thread.id, scope.agentId])).rows[0]?.sequence
      if (consumed != null) {
        const pending = (await client.query(`SELECT m.id,m.author_id FROM messages m JOIN participants p ON p.id=m.author_id AND p.company_id=m.company_id
          WHERE m.thread_id=$1 AND m.sequence>$2 AND p.kind='human'
          AND NOT EXISTS(SELECT 1 FROM task_message_links l WHERE l.task_id=$3 AND l.message_id=m.id AND l.purpose='TRIGGER')
          ORDER BY m.sequence`, [thread.id, Number(consumed), work.task_id])).rows
        await client.query(`INSERT INTO thread_reads(thread_id,agent_id,sequence) VALUES($1,$2,$3) ON CONFLICT(thread_id,agent_id) DO UPDATE SET sequence=GREATEST(thread_reads.sequence,excluded.sequence)`, [thread.id, scope.agentId, Number(consumed)])
        for (const message of pending) await this.ingress(client, { companyId: scope.companyId, id: message.author_id }, message.id)
      }
    })
  }

  async finish(scope: ThreadScope, error?: string | null, runId?: string): Promise<void> {
    const current = (await pool.query<Work>(`SELECT w.* FROM thread_work w JOIN conversation_threads t ON t.id=w.thread_id AND t.round=w.round WHERE t.id=$1 AND t.company_id=$2 AND t.round=$3 AND w.agent_id=$4`, [scope.threadId, scope.companyId, scope.round, scope.agentId])).rows[0]
    if (!current || terminal.includes(current.state) || current.state === 'waiting') return
    if (current.role === 'coordinator' && runId) {
      const started = (await pool.query(`SELECT trigger->>'threadState' AS state FROM agent_runs WHERE id=$1 AND agent_id=$2`, [runId, scope.agentId])).rows[0]
      if (started?.state !== 'aggregating' && (await pool.query(`SELECT 1 FROM task_plan_versions WHERE task_id=$1`, [current.task_id])).rowCount) return
    }
    if (current.role === 'member') await this.result(scope, error ? 'failed' : 'blocked', error || '成员执行已结束，但未提交可验收结果；请补充资料或重试。')
    else await this.summary(scope, `Aida 执行未能提交汇总：${error || '缺少最终结果'}。请补充说明后继续。`, true)
  }

  async expire(companyId: string): Promise<void> {
    const threads = (await pool.query<Thread>(`SELECT DISTINCT t.* FROM conversation_threads t JOIN thread_work w ON w.thread_id=t.id AND w.round=t.round
      WHERE t.company_id=$1 AND w.deadline<NOW() AND w.state IN ('pending','running','aggregating','waiting') LIMIT 20`, [companyId])).rows
    for (const candidate of threads) {
      await tasks.transaction(companyId, async client => {
        const thread = (await client.query<Thread>(`SELECT * FROM conversation_threads WHERE id=$1 FOR UPDATE`, [candidate.id])).rows[0]
        const expired = (await client.query<Work>(`SELECT * FROM thread_work WHERE thread_id=$1 AND round=$2 AND role='member' AND deadline<NOW() AND state IN ('pending','running')`, [thread.id, thread.round])).rows
        for (const work of expired) await this.completeMember(client, thread, work, 'timed_out', '成员执行超时，未取得可验收结果。请重试或补充资料。')
        await this.aggregate(client, thread)
      })
      const current = (await pool.query(`SELECT w.agent_id,t.round FROM thread_work w JOIN conversation_threads t ON t.id=w.thread_id AND t.round=w.round WHERE t.id=$1 AND w.role='coordinator' AND w.deadline<NOW() AND w.state IN ('pending','running','aggregating')`, [candidate.id])).rows[0]
      if (current) await this.finish({ companyId, threadId: candidate.id, round: current.round, agentId: current.agent_id }, '协调者执行超时')
    }
  }

  async cli(scope: ThreadScope, argv: string[]) {
    const detail = await this.detail(scope.companyId, scope.threadId)
    if (!detail || !await this.authorize(scope)) throw new TaskError('STALE_THREAD_CONTEXT', 409)
    const me = detail.members.find(m => m.agentId === scope.agentId)!
    const instructions = `THREAD ${scope.threadId} ROUND ${scope.round}; role=${me.role}; state=${me.state}.\n` +
      `工具：cumora thread status；协调者可 cumora thread delegate '[{"agentId":"成员ID","objective":"目标"}]' 一次提交全部成员并结束本轮等待；` +
      `成员必须 cumora thread result completed|blocked|failed "结果正文"；协调者必须 cumora thread summary "面向用户的最终汇总"。\n` +
      `如有本地 UTF-8 文本附件，用 cumora thread attachment <消息ID> 读取正文（最大1MiB，输出超过50000字符会标记truncated）；图片/PDF等不支持文本读取时应明确blocked，不得假装已读。\n普通 reply 只是进度，不能结束任务。所有工具自动使用当前 thread；正文 @ 不会新增工作。缺资料应明确 blocked，不要杜撰。\n`
    if (argv[0] === 'thread' && argv[1] === 'attachment') {
      const row = (await pool.query(`SELECT attachment FROM messages WHERE id=$1 AND company_id=$2 AND thread_id=$3`, [argv[2], scope.companyId, scope.threadId])).rows[0]
      if (!row?.attachment) throw new TaskError('THREAD_ATTACHMENT_NOT_FOUND', 404)
      const attachment = await freshenAttachmentUrl(row.attachment as StoredAttachment)
      const key = messageAttachmentStorageKey(attachment)
      if (!key || storage.mode !== 'local') throw new TaskError('ATTACHMENT_TEXT_READ_UNAVAILABLE', 409)
      if (!/^(text\/|application\/(json|xml|yaml)$)/.test(attachment.mime ?? '')) throw new TaskError('ATTACHMENT_TEXT_FORMAT_UNSUPPORTED', 409)
      const root = await realpath(UPLOAD_DIR)
      const path = await realpath(resolve(root, key)).catch(() => null)
      if (!path || !path.startsWith(root + sep)) throw new TaskError('THREAD_ATTACHMENT_NOT_FOUND', 404)
      const info = await stat(path)
      if (!info.isFile() || info.size > 1024 * 1024) throw new TaskError('ATTACHMENT_TEXT_TOO_LARGE', 413)
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path)) }
      catch { throw new TaskError('ATTACHMENT_TEXT_ENCODING_UNSUPPORTED', 409) }
      if (text.includes('\0')) throw new TaskError('ATTACHMENT_TEXT_ENCODING_UNSUPPORTED', 409)
      return { text: JSON.stringify({ messageId: argv[2], attachment, content: text.slice(0, 50000), truncated: text.length > 50000 }), exitCode: 0, ok: true }
    }
    if (argv[0] === 'thread') {
      if (argv[1] === 'delegate') await this.delegate(scope, JSON.parse(argv[2] ?? 'null'))
      else if (argv[1] === 'result') await this.result(scope, argv[2] ?? '', argv.slice(3).join(' '))
      else if (argv[1] === 'summary') await this.summary(scope, argv.slice(argv[2] === '--blocked' ? 3 : 2).join(' '), argv[2] === '--blocked')
      else if (argv[1] !== 'status') throw new TaskError('UNKNOWN_THREAD_COMMAND', 400)
      const roster = (await pool.query(`SELECT b.agent_id AS "agentId",p.name,b.alias FROM channel_agent_bindings b JOIN participants p ON p.id=b.agent_id AND p.company_id=b.company_id
        JOIN conversation_members m ON m.company_id=b.company_id AND m.conversation_id=b.conversation_id AND m.participant_id=b.agent_id
        WHERE b.company_id=$1 AND b.conversation_id=$2 AND b.status='ACTIVE' AND p.departed_at IS NULL`, [scope.companyId, detail.conversationId])).rows
      return { text: instructions + JSON.stringify({ ...await this.detail(scope.companyId, scope.threadId), roster }), exitCode: 0, ok: true }
    }
    if (argv[0] === 'reply') {
      const target = argv[1]
      if (target !== detail.conversationId) throw new TaskError('THREAD_CHANNEL_MISMATCH', 409)
      const quoteIndex = argv.indexOf('--quote')
      const body = argv.slice(2, quoteIndex < 0 ? undefined : quoteIndex).join(' ')
      if (!body.trim()) throw new TaskError('INVALID_REPLY', 400)
      await tasks.transaction(scope.companyId, async client => {
        const { thread, work } = await this.locked(client, scope)
        if (terminal.includes(work.state) || work.state === 'waiting') throw new TaskError('THREAD_WORK_CLOSED', 409)
        const quoteId = quoteIndex < 0 ? thread.id : argv[quoteIndex + 1]
        if (!quoteId || !(await client.query(`SELECT 1 FROM messages WHERE id=$1 AND thread_id=$2 AND company_id=$3`, [quoteId, thread.id, scope.companyId])).rowCount) throw new TaskError('THREAD_MESSAGE_MISMATCH', 409)
        await this.post(client, thread, scope.agentId, body, [], 'text', quoteId)
      })
      return { text: 'Posted progress in current thread. Use thread result/summary to finish.', exitCode: 0, ok: true }
    }
    if (argv[0] === 'inbox' || argv[0] === 'messages') {
      if (argv[0] === 'messages' && argv[1] && argv[1] !== detail.conversationId) throw new TaskError('THREAD_CHANNEL_MISMATCH', 409)
      const rows = (await pool.query(`SELECT id,author_id,body,kind,sequence,thread_id,attachment FROM messages WHERE company_id=$1 AND thread_id=$2 ORDER BY sequence DESC LIMIT 100`, [scope.companyId, scope.threadId])).rows.reverse()
      await Promise.all(rows.map(async row => {
        if (!row.attachment) return
        try { row.attachment = await freshenAttachmentUrl(row.attachment as StoredAttachment) }
        catch { /* Keep metadata and the stored URL, matching other inbox reads. */ }
      }))
      if (rows.length) await pool.query(`INSERT INTO thread_reads(thread_id,agent_id,sequence) VALUES($1,$2,$3)
        ON CONFLICT(thread_id,agent_id) DO UPDATE SET sequence=GREATEST(thread_reads.sequence,excluded.sequence)`, [scope.threadId, scope.agentId, rows.at(-1)!.sequence])
      return { text: instructions + JSON.stringify(detail) + '\n' + JSON.stringify(rows), exitCode: 0, ok: true }
    }
    return null
  }
}

export const threadService = new ThreadService()

/** Restart-safe sweep also runs when every local computer is offline. */
export function startThreadRecovery(): void {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const companies = (await pool.query(`SELECT DISTINCT t.company_id FROM conversation_threads t JOIN thread_work w ON w.thread_id=t.id AND w.round=t.round
        WHERE w.deadline<NOW() AND w.state IN ('pending','running','waiting','aggregating') LIMIT 50`)).rows
      for (const company of companies) await threadService.expire(company.company_id)
    } catch (error) { console.warn('[thread-recovery]', error instanceof Error ? error.message : String(error)) }
    finally { running = false }
  }
  const timer = setInterval(() => { void tick() }, 30_000)
  timer.unref()
  void tick()
}
