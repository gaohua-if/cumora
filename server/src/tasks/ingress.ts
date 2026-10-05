import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { TaskError, canonicalJson, hashContent } from './contracts.js'
import { TaskService, type TaskPrincipal, type TaskRecord } from './service.js'

export class TaskIngressService {
  constructor(readonly tasks: TaskService) {}

  /** Called inside the durable message transaction by all authenticated human transports. */
  async message(client: PoolClient, principal: TaskPrincipal, messageId: string, taskRef?: string): Promise<string | null> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1))', [`task:${principal.companyId}`])
    const settings = await client.query(`SELECT mode,policy FROM task_workspace_settings WHERE company_id=$1 FOR SHARE`, [principal.companyId])
    if (settings.rows[0]?.mode !== 'TASK') {
      if (settings.rows[0]?.policy?.taskEstablished) throw new TaskError('TASK_WORKSPACE_PAUSED')
      return null
    }
    const result = await client.query(`SELECT * FROM messages WHERE id=$1 AND company_id=$2 AND author_id=$3 FOR SHARE`, [messageId, principal.companyId, principal.id])
    const message = result.rows[0]
    if(message?.attachment) throw new TaskError('TASK_ATTACHMENT_NOT_ADMITTED',400)
    if (!message || message.kind !== 'text' || !message.body?.trim()) throw new TaskError('TASK_INPUT_NOT_ADMITTED', 400)
    const already = await client.query<{ task_id: string }>(`SELECT task_id FROM task_message_links WHERE company_id=$1 AND message_id=$2`, [principal.companyId, messageId])
    if (already.rows[0]) {
      if(taskRef && taskRef!=='new' && taskRef!==already.rows[0].task_id)throw new TaskError('INGRESS_KEY_CONFLICT')
      if(taskRef==='new' && !(await client.query(`SELECT 1 FROM channel_tasks WHERE company_id=$1 AND id=$2 AND ingress_key=$3`,[principal.companyId,already.rows[0].task_id,`message:${messageId}`])).rowCount)throw new TaskError('INGRESS_KEY_CONFLICT')
      return already.rows[0].task_id
    }
    const channelId = message.conversation_id
    await this.tasks.member(client, principal, channelId)
    let taskId = taskRef && taskRef !== 'new' ? taskRef : undefined
    if (!taskRef && message.quoted_message_id) {
      const linked = await client.query<{ task_id: string }>(`SELECT l.task_id FROM task_message_links l JOIN channel_tasks t ON t.id=l.task_id AND t.company_id=l.company_id
        WHERE l.company_id=$1 AND l.message_id=$2 AND t.conversation_id=$3 AND t.status IN('OPEN','BLOCKED')`, [principal.companyId, message.quoted_message_id, channelId])
      taskId = linked.rows[0]?.task_id
    }
    if (!taskRef && !taskId) {
      const active = await client.query<TaskRecord>(`SELECT * FROM channel_tasks WHERE company_id=$1 AND conversation_id=$2 AND parent_task_id IS NULL AND status IN('OPEN','BLOCKED') ORDER BY created_at,id FOR UPDATE`, [principal.companyId, channelId])
      if (active.rows.length > 1) throw new TaskError('TASK_SELECTION_REQUIRED')
      taskId = active.rows[0]?.id
    }
    if (taskId) {
      const task = await this.tasks.task(client, principal, taskId)
      if (task.conversation_id !== channelId) throw new TaskError('TASK_CHANNEL_MISMATCH', 403)
      if (!['OPEN', 'BLOCKED'].includes(task.status) || task.parent_task_id) throw new TaskError('TASK_CLOSED')
      task.input_revision++
      await this.tasks.addInput(client, principal, task, { messageId })
      await client.query(`UPDATE channel_tasks SET input_revision=$3,version=version+1 WHERE company_id=$1 AND id=$2`, [principal.companyId, taskId, task.input_revision])
      return taskId
    }
    const named = await client.query<{ id: string; alias: string; agent_id: string }>(`SELECT id,alias,agent_id FROM channel_agent_bindings WHERE company_id=$1 AND conversation_id=$2 AND status='ACTIVE'`, [principal.companyId, channelId])
    const mentions = named.rows.filter((binding) => message.body.includes(`@${binding.alias}`) || message.body.includes(`@${binding.agent_id}`))
    if (mentions.length > 1) throw new TaskError('SINGLE_BINDING_REQUIRED')
    const task = await this.tasks.create(principal, { channelId, objective: message.body, ingressKey: `message:${message.id}`, bindingId: mentions[0]?.id,
      grantIds: [], messageId }, client)
    return task.id
  }

  async governed(principal:TaskPrincipal,channelId:string,attemptId:string,grantIds:string[]):Promise<TaskRecord> {
    const attempt=(await this.tasks.pool.query(`SELECT at.*,a.card_id,a.objective FROM governance_action_attempts at JOIN governance_actions a ON a.id=at.action_id AND a.company_id=at.company_id WHERE at.company_id=$1 AND at.id=$2 AND at.sponsor_user_id=$3`,[principal.companyId,attemptId,principal.id])).rows[0]
    if(!attempt) throw new TaskError('GOVERNANCE_AUTHORITY_REVOKED',403)
    const binding=(await this.tasks.pool.query(`SELECT id FROM channel_agent_bindings WHERE company_id=$1 AND conversation_id=$2 AND agent_id=$3 AND status='ACTIVE'`,[principal.companyId,channelId,attempt.agent_id])).rows[0]
    if(!binding) throw new TaskError('BINDING_INELIGIBLE',403)
    const task=await this.tasks.create(principal,{channelId,bindingId:binding.id,objective:attempt.objective,ingressKey:`governance:${attemptId}`,grantIds,boardCardId:attempt.card_id,governanceActionId:attempt.action_id,governanceAttemptId:attemptId})
    await this.tasks.drive(principal,task.id,'governance')
    return task
  }

  async board(principal:TaskPrincipal,channelId:string,cardId:string,grantIds:string[]):Promise<TaskRecord>{
    const task=await this.tasks.transaction(principal.companyId,async client=>{
      const channel=await this.tasks.member(client,principal,channelId)
      const card=(await client.query(`SELECT c.title,c.description,c.assignee_id,c.governance_mode FROM board_cards c JOIN boards b ON b.id=c.board_id WHERE b.company_id=$1 AND c.id=$2 FOR SHARE OF c,b`,[principal.companyId,cardId])).rows[0]
      if(!card)throw new TaskError('BOARD_ACCESS_DENIED',403)
      if(card.governance_mode!=='COLLABORATION')throw new TaskError('GOVERNANCE_MAPPING_REQUIRED',403)
      if(!card.assignee_id)throw new TaskError('BOARD_ASSIGNEE_REQUIRED')
      const binding=(await client.query(`SELECT id FROM channel_agent_bindings WHERE company_id=$1 AND conversation_id=$2 AND agent_id=$3 AND status='ACTIVE'`,[principal.companyId,channelId,card.assignee_id])).rows[0]
      if(!binding)throw new TaskError('BINDING_INELIGIBLE',403)
      const content=canonicalJson({title:card.title,description:card.description})
      const hash=hashContent(content)
      const record=await this.tasks.create(principal,{channelId,bindingId:binding.id,objective:card.title,ingressKey:`board:${cardId}:${hash}`,grantIds,boardCardId:cardId},client)
      const old=await client.query(`SELECT 1 FROM task_inputs WHERE company_id=$1 AND task_id=$2 AND reference_id=$3 AND kind='TEXT'`,[principal.companyId,record.id,cardId])
      if(!old.rowCount){
        const provenance={companyId:principal.companyId,conversationId:channelId,audience:channel.audience,sources:[{kind:'BOARD' as const,id:cardId,version:1,hash}],destinations:['task-model','artifact','channel']}
        await this.tasks.liveSources(client,provenance,record,'task-model')
        await client.query(`INSERT INTO task_inputs(id,company_id,task_id,kind,reference_id,content,content_hash,provenance,input_revision) VALUES($1,$2,$3,'TEXT',$4,$5,$6,$7,$8)`,[randomUUID(),principal.companyId,record.id,cardId,content,hash,provenance,record.input_revision])
      }
      return record
    })
    await this.tasks.drive(principal,task.id,'board')
    return task
  }

  /** Message input is accepted for any member; only the creator/controller may start a revision. */
  async scheduleMessage(companyId: string, messageId: string): Promise<void> {
    const linked = await this.tasks.pool.query<{ task_id: string; author_id: string }>(`SELECT l.task_id,m.author_id FROM task_message_links l JOIN messages m ON m.id=l.message_id
      WHERE l.company_id=$1 AND l.message_id=$2 AND l.purpose IN('TRIGGER','SUPPLEMENT')`, [companyId, messageId])
    if (!linked.rows[0]) return
    try { await this.tasks.drive({ companyId, id: linked.rows[0].author_id }, linked.rows[0].task_id, `message:${messageId}`) }
    catch (error) {
      if (!(error instanceof TaskError)) throw error
      await this.rejected(companyId,linked.rows[0].author_id,'ingress:message.new',error.code,{taskId:linked.rows[0].task_id,messageId})
      if(['TASK_DISPATCH_ALREADY_PENDING','EXECUTOR_NOT_STOPPED','TASK_CONTROL_DENIED'].includes(error.code))return
      await this.tasks.transaction(companyId,async client=>{
        let task:TaskRecord
        try{task=await this.tasks.task(client,{companyId,id:linked.rows[0].author_id},linked.rows[0].task_id,'drive')}
        catch(controlError){if(controlError instanceof TaskError)return;throw controlError}
        if(['OPEN','BLOCKED'].includes(task.status))await client.query(`UPDATE channel_tasks SET status='BLOCKED',blocked_code=$3,version=version+1 WHERE company_id=$1 AND id=$2`,[companyId,task.id,error.code])
      })
    }
  }

  async rejected(companyId:string,principalId:string,operation:string,code:string,references:Record<string,unknown>):Promise<false>{
    await this.tasks.pool.query(`INSERT INTO task_authorization_events(id,company_id,principal_id,operation,outcome,references_json) VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),companyId,principalId,operation,code,references])
    return false
  }

  async synthetic(companyId: string, agentId: string, reason: string, channelId: string | null, objective: string, eventKey?:string): Promise<boolean> {
    if (!channelId) return this.rejected(companyId,agentId,`ingress:${reason}`,'TASK_CHANNEL_REQUIRED',{agentId})
    const settings = await this.tasks.pool.query(`SELECT policy FROM task_workspace_settings WHERE company_id=$1 AND mode='TASK'`, [companyId])
    const policies = settings.rows[0]?.policy?.automations
    const policy = Array.isArray(policies) ? policies.find((item) => item && item.reason === reason && item.channelId === channelId && item.agentId === agentId) : null
    if (!policy || typeof policy.principalId !== 'string' || !Array.isArray(policy.grantIds) || !policy.key) return this.rejected(companyId,agentId,`ingress:${reason}`,'AUTOMATION_AUTHORITY_REQUIRED',{agentId,channelId})
    const principal = { companyId, id: policy.principalId }
    const grants = await this.tasks.pool.query(`SELECT rule FROM access_grants WHERE company_id=$1 AND id=ANY($2::text[]) AND revoked_at IS NULL AND expires_at>NOW()`, [companyId, policy.grantIds])
    if (!grants.rows.some((grant) => grant.rule.resource === `channel:${channelId}` && grant.rule.actions.includes(`automate:${reason}`))) return this.rejected(companyId,agentId,`ingress:${reason}`,'AUTOMATION_AUTHORITY_REVOKED',{agentId,channelId})
    const task = await this.tasks.create(principal, { channelId, objective, ingressKey: `automation:${policy.key}:${eventKey ?? Math.floor(Date.now()/60_000)}`, bindingId: policy.bindingId, grantIds: policy.grantIds })
    await this.tasks.drive(principal, task.id, 'automation')
    return true
  }
}
