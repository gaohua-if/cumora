import { randomUUID } from 'node:crypto'
import { checkTaskGovernance } from './governance.js'
import type { PoolClient } from 'pg'
import { TaskError, hashContent, parseProvenance, requireLiveGrant, canonicalJson,type Provenance } from './contracts.js'
import { TaskService, type TaskPrincipal, type TaskRecord } from './service.js'

export interface Claim { id: string; contextId: string; generation: number; token: string }
interface MessageView { id:string;body?:string;attachment?:unknown;quoted?:unknown;quotedMessageId?:string }
export interface ResolvedTask {
  task: TaskRecord
  agentId: string
  bindingId: string
  instructions: string
  inputs: { id: string; content: string; provenance: Provenance }[]
  provenance: Provenance
  inputRevision: number
  eligibleBindings: { id: string; alias: string }[]
  rootGrantIds: string[]
}

/** Shared cloud/local action boundary. Claim credentials never enter model input. */
export class TaskExecutionService {
  constructor(readonly tasks: TaskService) {}

  async redactMessage(companyId:string,message:MessageView):Promise<void> {
    if(!await this.deliveryVisible(companyId,message.id)){
      message.body='该交付的来源授权已失效';message.attachment=null;message.quoted=null
    }
    if(message.quotedMessageId && !await this.deliveryVisible(companyId,message.quotedMessageId))message.quoted=null
  }

  async resolve(client: PoolClient, companyId: string, claim: Claim, destination = 'task-model'): Promise<ResolvedTask> {
    const result = await client.query(`SELECT d.*,c.task_id,c.binding_id,c.scope_revision,c.input_revision,c.workspace_generation,c.binding_version,c.assignment_id,
      c.configuration,c.runtime,c.input_ids,c.expires_at,c.revoked_at,s.mode,s.generation AS current_generation
      FROM task_dispatches d JOIN task_execution_contexts c ON c.id=d.context_id AND c.company_id=d.company_id
      JOIN task_workspace_settings s ON s.company_id=d.company_id
      WHERE d.company_id=$1 AND d.id=$2 AND d.context_id=$3 AND d.claim_generation=$4 AND d.claim_token_hash=$5 FOR UPDATE OF d FOR SHARE OF c,s`,
      [companyId, claim.id, claim.contextId, claim.generation, hashContent(claim.token)])
    const context = result.rows[0]
    if (!context || context.state !== 'CLAIMED' || context.revoked_at || new Date(context.expires_at).getTime() <= Date.now() ||
      new Date(context.lease_expires_at).getTime() <= Date.now() || context.mode !== 'TASK' || context.workspace_generation !== context.current_generation) {
      throw new TaskError('TASK_CONTEXT_REVOKED', 403)
    }
    const record = await client.query<TaskRecord>(`SELECT * FROM channel_tasks WHERE company_id=$1 AND id=$2 FOR UPDATE`, [companyId, context.task_id])
    const task = record.rows[0]
    if (!task || task.status !== 'OPEN' || task.scope_revision !== context.scope_revision || task.input_revision !== context.input_revision) throw new TaskError('TASK_CONTEXT_REVOKED', 403)
    await this.tasks.member(client, { companyId, id: task.creator_principal_id }, task.conversation_id)
    const binding = await this.tasks.binding(client, companyId, task.conversation_id, context.binding_id)
    if (binding.agent_id !== context.agent_id || binding.version !== context.binding_version || binding.runtime_assignment_id !== context.assignment_id || binding.engine !== context.runtime.engine) throw new TaskError('TASK_CONTEXT_REVOKED', 403)
    await checkTaskGovernance(client, task, binding)
    if (binding.computer_id && binding.computer_kind !== 'cloud') {
      const admitted = await client.query(`SELECT 1 FROM task_runtime_admissions WHERE company_id=$1 AND computer_id=$2 AND engine=$3 AND revoked_at IS NULL FOR SHARE`, [companyId, binding.computer_id, binding.engine])
      if (!admitted.rowCount) throw new TaskError('RUNTIME_CAPABILITY_UNQUALIFIED', 403)
    }
    const grants = await client.query(`SELECT v.id,v.source_grant_id,v.source_version,v.rule,g.version,g.revoked_at,g.expires_at FROM task_grant_versions v
      JOIN access_grants g ON g.id=v.source_grant_id AND g.company_id=v.company_id
      WHERE v.company_id=$1 AND v.task_id=$2 AND v.scope_revision=$3 AND v.revoked_at IS NULL FOR SHARE OF v,g`, [companyId, task.id, task.scope_revision])
    for (const grant of grants.rows) requireLiveGrant(grant, grant.source_version)
    const inputs = await client.query<{ id: string; content: string; provenance: Provenance; content_hash: string }>(`SELECT * FROM task_inputs
      WHERE company_id=$1 AND task_id=$2 AND id=ANY($3::text[]) AND retired_at IS NULL ORDER BY created_at,id`, [companyId, task.id, context.input_ids])
    if (inputs.rows.length !== context.input_ids.length || !inputs.rows.length) throw new TaskError('TASK_INPUT_MISSING', 403)
    for (const input of inputs.rows) {
      if (hashContent(input.content) !== input.content_hash) throw new TaskError('INPUT_HASH_MISMATCH', 403)
      await this.tasks.liveSources(client, parseProvenance(input.provenance), task, destination)
    }
    const provenance: Provenance = { ...parseProvenance(inputs.rows[0].provenance),
      sources: [...inputs.rows.flatMap((input) => input.provenance.sources), ...grants.rows.map((grant) => ({ kind: 'GRANT' as const, id: grant.source_grant_id, version: grant.source_version }))],
      destinations: inputs.rows.reduce((destinations, input) => destinations.filter((d) => input.provenance.destinations.includes(d)), inputs.rows[0].provenance.destinations) }
    const eligible = await client.query<{ id: string; alias: string }>(`SELECT b.id,b.alias FROM channel_agent_bindings b JOIN conversation_members m ON m.company_id=b.company_id AND m.conversation_id=b.conversation_id AND m.participant_id=b.agent_id
      JOIN participants p ON p.company_id=b.company_id AND p.id=b.agent_id WHERE b.company_id=$1 AND b.conversation_id=$2 AND b.status='ACTIVE' AND p.departed_at IS NULL`, [companyId, task.conversation_id])
    return { task, agentId: binding.agent_id, bindingId: binding.id, instructions: String(context.configuration.instructions ?? ''), inputs: inputs.rows, provenance,
      inputRevision: context.input_revision, eligibleBindings: eligible.rows, rootGrantIds: grants.rows.map((grant) => grant.id) }
  }

  async context(companyId: string, claim: Claim): Promise<ResolvedTask> {
    return this.tasks.transaction(companyId, (client) => this.resolve(client, companyId, claim))
  }

  async heartbeat(companyId: string, claim: Claim): Promise<void> {
    await this.tasks.transaction(companyId, async (client) => {
      await this.resolve(client, companyId, claim)
      const governed=(await client.query(`SELECT governance_attempt_id FROM channel_tasks WHERE company_id=$1 AND id=(SELECT task_id FROM task_dispatches WHERE id=$2)`,[companyId,claim.id])).rows[0]
      if(governed?.governance_attempt_id)await client.query(`UPDATE governance_action_attempts SET lease_expires_at=NOW()+INTERVAL '5 minutes',last_heartbeat_at=NOW() WHERE company_id=$1 AND id=$2 AND state IN('RUNNING','WAITING_HUMAN') AND lease_expires_at>NOW()`,[companyId,governed.governance_attempt_id])
      await client.query(`UPDATE task_dispatches SET lease_expires_at=NOW()+INTERVAL '60 seconds' WHERE company_id=$1 AND id=$2`, [companyId, claim.id])
    })
  }

  async deliveryVisible(companyId:string,messageId:string):Promise<boolean> {
    try {
      return await this.tasks.transaction(companyId,client=>this.deliveryVisibleInTransaction(client,companyId,messageId))
    }catch(error){
      if((error as {code?:string}).code==='42P01') return true
      throw error
    }
  }

  async deliveryVisibleInTransaction(client:PoolClient,companyId:string,messageId:string):Promise<boolean> {
    try {
        const delivered=(await client.query(`SELECT t.*,d.artifact_ids,d.evidence_ids FROM task_deliveries d JOIN channel_tasks t ON t.id=d.task_id AND t.company_id=d.company_id WHERE d.company_id=$1 AND d.message_id=$2`,[companyId,messageId])).rows[0]
        if(!delivered) return true
        await this.tasks.member(client,{companyId,id:delivered.creator_principal_id},delivered.conversation_id)
        const ids=[...new Set([...delivered.artifact_ids,...delivered.evidence_ids])]
        const artifacts=await client.query(`SELECT * FROM artifact_versions WHERE company_id=$1 AND id=ANY($2::text[])`,[companyId,ids])
        if(artifacts.rows.length!==ids.length || !ids.length) return false
        for(const artifact of artifacts.rows){
          if(hashContent(artifact.content)!==artifact.content_hash) return false
          await this.tasks.liveSources(client,parseProvenance(artifact.provenance),delivered,'channel')
        }
        return true
    }catch(error){
      if(error instanceof TaskError) return false
      throw error
    }
  }

  async artifact(companyId: string, claim: Claim, input: { content: string; mediaType: string; artifactId?: string }): Promise<{ id: string; hash: string }> {
    if (!input.content?.trim() || Buffer.byteLength(input.content) > 2_000_000 || !['text/plain', 'text/markdown', 'text/x-diff', 'application/json'].includes(input.mediaType)) {
      throw new TaskError('INVALID_ARTIFACT', 400)
    }
    return this.tasks.transaction(companyId, async (client) => {
      const resolved = await this.resolve(client, companyId, claim, 'artifact')
      const id = randomUUID()
      const artifactId = input.artifactId ?? randomUUID()
      const hash = hashContent(input.content)
      // Only the accountable producer may append another version of its logical artifact.
      const existing = await client.query(`SELECT task_id,producer_binding_id FROM artifact_versions WHERE company_id=$1 AND artifact_id=$2 LIMIT 1`, [companyId, artifactId])
      if (existing.rows[0] && (existing.rows[0].task_id !== resolved.task.id || existing.rows[0].producer_binding_id !== resolved.bindingId)) throw new TaskError('ARTIFACT_PRODUCER_DENIED', 403)
      let governanceVersionId: string | null = null
      if (resolved.task.governance_attempt_id) {
        governanceVersionId = `task-gov:${artifactId}:${hash}`
        await client.query(`INSERT INTO governance_artifact_versions(version_id,artifact_id,company_id,card_id,content_hash,media_type,byte_size,external_source_ref,producer_principal_ids,source_action_id,source_attempt_id,input_version_refs,sensitivity,allowed_reader_scope,retention_until,kind)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'RESTRICTED',$13,NOW()+INTERVAL '365 days','DELIVERABLE') ON CONFLICT(artifact_id,content_hash) DO NOTHING`,
          [governanceVersionId,`task:${artifactId}`,companyId,resolved.task.board_card_id,hash,input.mediaType,Buffer.byteLength(input.content),{adapter:'task-artifact',artifactId,contentHash:hash},JSON.stringify([resolved.agentId]),resolved.task.governance_action_id,resolved.task.governance_attempt_id,JSON.stringify(resolved.inputs.map(row=>row.id)),JSON.stringify([{channelId:resolved.task.conversation_id}])])
      }
      const result = await client.query<{ id: string }>(`INSERT INTO artifact_versions(id,artifact_id,company_id,task_id,producer_binding_id,media_type,content,content_hash,provenance,input_version_ids,governance_version_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(company_id,artifact_id,content_hash) DO NOTHING RETURNING id`,
        [id, artifactId, companyId, resolved.task.id, resolved.bindingId, input.mediaType, Buffer.from(input.content), hash, resolved.provenance, JSON.stringify(resolved.inputs.filter((row) => row.provenance.sources.some((s) => s.kind === 'ARTIFACT')).flatMap((row) => row.provenance.sources.filter((s) => s.kind === 'ARTIFACT').map((s) => s.id))), governanceVersionId])
      const actual = result.rows[0]?.id ?? (await client.query<{ id: string }>('SELECT id FROM artifact_versions WHERE company_id=$1 AND artifact_id=$2 AND content_hash=$3', [companyId, artifactId, hash])).rows[0].id
      return { id: actual, hash }
    })
  }

  async readArtifact(principal: TaskPrincipal, versionId: string): Promise<{ content: Buffer; mediaType: string; hash: string }> {
    return this.tasks.transaction(principal.companyId, async (client) => {
      const version = await client.query(`SELECT * FROM artifact_versions WHERE company_id=$1 AND id=$2`, [principal.companyId, versionId])
      const row = version.rows[0]
      if (!row) throw new TaskError('ARTIFACT_NOT_FOUND', 404)
      const task = await this.tasks.task(client, principal, row.task_id)
      // Prepublication versions stay private to the creator and explicit task controllers.
      if (principal.id !== task.creator_principal_id) {
        const published = await client.query(`SELECT 1 FROM task_deliveries WHERE company_id=$1 AND task_id=$2 AND artifact_ids @> $3::jsonb`, [principal.companyId, task.id, JSON.stringify([versionId])])
        if (!published.rowCount) throw new TaskError('ARTIFACT_PRIVATE', 403)
      }
      await this.tasks.liveSources(client, parseProvenance(row.provenance), task, 'channel')
      if (hashContent(row.content) !== row.content_hash) throw new TaskError('ARTIFACT_HASH_MISMATCH', 403)
      return { content: row.content, mediaType: row.media_type, hash: row.content_hash }
    })
  }

  async importGovernance(principal:TaskPrincipal,taskId:string,versionId:string,content:string):Promise<string> {
    if(typeof content!=='string' || Buffer.byteLength(content)>2_000_000)throw new TaskError('INVALID_ARTIFACT',400)
    return this.tasks.transaction(principal.companyId,async client=>{
      const task=await this.tasks.task(client,principal,taskId,'scope')
      if(!['OPEN','BLOCKED'].includes(task.status))throw new TaskError('TASK_CLOSED')
      const binding=await this.tasks.binding(client,principal.companyId,task.conversation_id,task.accountable_binding_id)
      await checkTaskGovernance(client,task,binding)
      const source=(await client.query(`SELECT * FROM governance_artifact_versions WHERE company_id=$1 AND version_id=$2`,[principal.companyId,versionId])).rows[0]
      if(!source || source.card_id!==task.board_card_id || !Array.isArray(source.allowed_reader_scope) || !source.allowed_reader_scope.some((scope:{channelId?:string})=>scope.channelId===task.conversation_id))throw new TaskError('GOVERNANCE_ARTIFACT_AUDIENCE_DENIED',403)
      if(hashContent(content)!==source.content_hash || Buffer.byteLength(content)!==Number(source.byte_size))throw new TaskError('ARTIFACT_HASH_MISMATCH',403)
      if(!['text/plain','text/markdown','text/x-diff','application/json'].includes(source.media_type))throw new TaskError('INVALID_ARTIFACT',400)
      const channel=await this.tasks.member(client,principal,task.conversation_id)
      const provenance:Provenance={companyId:principal.companyId,conversationId:task.conversation_id,audience:channel.audience,sources:[{kind:'GOVERNANCE',id:versionId,version:1}],destinations:['task-model','artifact','channel']}
      const prior=(await client.query(`SELECT * FROM artifact_versions WHERE company_id=$1 AND governance_version_id=$2`,[principal.companyId,versionId])).rows[0]
      let id=prior?.id??randomUUID()
      if(prior){if(prior.content_hash!==source.content_hash)throw new TaskError('ARTIFACT_HASH_MISMATCH',403);await this.tasks.liveSources(client,parseProvenance(prior.provenance),task,'task-model')}
      else await client.query(`INSERT INTO artifact_versions(id,artifact_id,company_id,task_id,producer_binding_id,media_type,content,content_hash,provenance,governance_version_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,`governance:${source.artifact_id}`,principal.companyId,task.id,binding.id,source.media_type,Buffer.from(content),source.content_hash,provenance,source.version_id])
      const already=await client.query(`SELECT 1 FROM task_inputs WHERE company_id=$1 AND task_id=$2 AND reference_id=$3 AND retired_at IS NULL`,[principal.companyId,taskId,id])
      if(!already.rowCount){
        await client.query(`INSERT INTO task_inputs(id,company_id,task_id,kind,reference_id,content,content_hash,provenance,input_revision) VALUES($1,$2,$3,'ARTIFACT',$4,$5,$6,$7,$8)`,[randomUUID(),principal.companyId,taskId,id,content,source.content_hash,{...provenance,sources:[{kind:'ARTIFACT',id,version:1}]},task.input_revision+1])
        await client.query(`UPDATE channel_tasks SET input_revision=input_revision+1,version=version+1 WHERE company_id=$1 AND id=$2`,[principal.companyId,taskId])
      }
      return id
    })
  }

  async deliver(companyId: string, claim: Claim, input: { key: string; summary: string; artifactIds: string[]; evidenceIds?: string[]; limitations?: string[] }): Promise<string> {
    if (!input.key || input.key.length > 200 || !input.summary?.trim() || input.summary.length > 12000 ||
      !Array.isArray(input.artifactIds) || input.artifactIds.length < 1 || input.artifactIds.length > 32 || !Array.isArray(input.limitations ?? []) ||
      (input.limitations ?? []).some((text) => typeof text !== 'string' || text.length > 1000)) throw new TaskError('INVALID_DELIVERY', 400)
    return this.tasks.transaction(companyId, async (client) => {
      // Idempotency allows only the same credential-bound dispatch to observe its prior delivery.
      const bound = await client.query(`SELECT task_id FROM task_dispatches WHERE company_id=$1 AND id=$2 AND context_id=$3 AND claim_generation=$4 AND claim_token_hash=$5 FOR UPDATE`,
        [companyId, claim.id, claim.contextId, claim.generation, hashContent(claim.token)])
      if (!bound.rows[0]) throw new TaskError('STALE_CLAIM', 403)
      const old = await client.query(`SELECT id,summary,artifact_ids,evidence_ids,limitations FROM task_deliveries WHERE company_id=$1 AND task_id=$2 AND delivery_key=$3`, [companyId, bound.rows[0].task_id, input.key])
      if (old.rows[0]) {
        if (old.rows[0].summary !== input.summary || canonicalJson(old.rows[0].artifact_ids) !== canonicalJson(input.artifactIds) || canonicalJson(old.rows[0].evidence_ids)!==canonicalJson(input.evidenceIds??[]) || canonicalJson(old.rows[0].limitations)!==canonicalJson(input.limitations??[])) throw new TaskError('DELIVERY_KEY_CONFLICT')
        return old.rows[0].id
      }
      const resolved = await this.resolve(client, companyId, claim, 'channel')
      if (resolved.inputRevision !== resolved.task.input_revision) throw new TaskError('TASK_INPUT_CHANGED')
      const plan = await client.query(`SELECT plan FROM task_plan_versions WHERE company_id=$1 AND task_id=$2 ORDER BY revision DESC LIMIT 1`, [companyId, resolved.task.id])
      if (plan.rows[0] && plan.rows[0].plan.scopeRevision === resolved.task.scope_revision) {
        const members = plan.rows[0].plan.members as { taskId: string; role: string; dependsOn: string[]; key: string; bindingId: string }[]
        for (const member of members) {
          const child = await client.query(`SELECT status FROM channel_tasks WHERE company_id=$1 AND id=$2 FOR SHARE`, [companyId, member.taskId])
          if (child.rows[0]?.status !== 'DELIVERED') throw new TaskError('PLAN_CHILD_NOT_DELIVERED')
          if (member.role === 'VERIFY') {
            const reports = await client.query(`SELECT a.id,a.input_version_ids FROM task_deliveries d JOIN artifact_versions a ON a.id IN(SELECT jsonb_array_elements_text(d.artifact_ids))
              WHERE d.company_id=$1 AND d.task_id=$2`, [companyId, member.taskId])
            const expected = await client.query(`SELECT jsonb_array_elements_text(d.artifact_ids) AS id FROM task_deliveries d WHERE d.company_id=$1 AND d.task_id=ANY($2::text[])`, [companyId, members.filter((work) => member.dependsOn.includes(work.key)).map((work) => work.taskId)])
            const accepted = reports.rows.filter((report) => expected.rows.every((version) => report.input_version_ids.includes(version.id)))
            if (!accepted.length || !accepted.some((report) => (input.evidenceIds ?? []).includes(report.id))) throw new TaskError('VERIFICATION_EVIDENCE_REQUIRED')
          }
        }
      }
      const versions = [...new Set([...input.artifactIds, ...(input.evidenceIds ?? [])])]
      const rows = await client.query(`SELECT * FROM artifact_versions WHERE company_id=$1 AND id=ANY($2::text[])`, [companyId, versions])
      if (rows.rows.length !== versions.length) throw new TaskError('ARTIFACT_NOT_FOUND', 403)
      for (const row of rows.rows) {
        const sourceTask = await client.query(`SELECT root_task_id FROM channel_tasks WHERE company_id=$1 AND id=$2`, [companyId, row.task_id])
        if (sourceTask.rows[0]?.root_task_id !== resolved.task.root_task_id) throw new TaskError('ARTIFACT_TASK_DENIED', 403)
        await this.tasks.liveSources(client, parseProvenance(row.provenance), resolved.task, 'channel')
        if (hashContent(row.content) !== row.content_hash) throw new TaskError('ARTIFACT_HASH_MISMATCH', 403)
      }
      // Children return immutable versions to the plan; only root delivery emits a channel message.
      const id = randomUUID()
      let messageId: string | null = null
      if (!resolved.task.parent_task_id) {
        messageId = randomUUID()
        const counter = await client.query<{ seq: number }>(`INSERT INTO conversation_counters(conversation_id,next_sequence) VALUES($1,2)
          ON CONFLICT(conversation_id) DO UPDATE SET next_sequence=conversation_counters.next_sequence+1 RETURNING next_sequence-1 AS seq`, [resolved.task.conversation_id])
        const attachment = { taskId: resolved.task.id, deliveryId: id, artifactVersionIds: input.artifactIds, evidenceVersionIds: input.evidenceIds ?? [], limitations: input.limitations ?? [] }
        await client.query(`INSERT INTO messages(id,company_id,conversation_id,author_id,kind,body,sequence,attachment,quoted_message_id) VALUES($1,$2,$3,$4,'text',$5,$6,$7,$8)`,
          [messageId, companyId, resolved.task.conversation_id, resolved.agentId, input.summary, counter.rows[0].seq, attachment, (resolved.task as TaskRecord & { reply_message_id?: string }).reply_message_id ?? null])
        await client.query(`INSERT INTO task_message_links(company_id,task_id,message_id,purpose) VALUES($1,$2,$3,'DELIVERY')`, [companyId, resolved.task.id, messageId])
        const outboxId = randomUUID()
        const { CH_MESSAGE_NEW } = await import('../redis.js')
        await client.query(`INSERT INTO realtime_outbox(id,channel,payload) VALUES($1,$2,$3)`, [outboxId, CH_MESSAGE_NEW,
          { type: 'message.new', companyId, conversationId: resolved.task.conversation_id, deliveryId: outboxId, taskDelivery: true,
            message: { id: messageId, conversationId: resolved.task.conversation_id, authorId: resolved.agentId, kind: 'text', body: input.summary, sequence: counter.rows[0].seq, attachment, at: new Date().toISOString() } }])
      }
      await client.query(`INSERT INTO task_deliveries(id,company_id,task_id,scope_revision,artifact_ids,evidence_ids,summary,limitations,message_id,delivery_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, companyId, resolved.task.id, resolved.task.scope_revision, JSON.stringify(input.artifactIds), JSON.stringify(input.evidenceIds ?? []), input.summary, JSON.stringify(input.limitations ?? []), messageId, input.key])
      await client.query(`UPDATE channel_tasks SET status='DELIVERED',version=version+1,updated_at=NOW() WHERE company_id=$1 AND id=$2`, [companyId, resolved.task.id])
      await client.query(`UPDATE task_dispatches SET state='COMPLETED',result_ref=$3 WHERE company_id=$1 AND id=$2`, [companyId, claim.id, id])
      return id
    })
  }

  async block(companyId: string, claim: Claim, code: string): Promise<void> {
    await this.tasks.transaction(companyId, async (client) => {
      const dispatch = await client.query(`UPDATE task_dispatches SET state='UNKNOWN' WHERE company_id=$1 AND id=$2 AND claim_generation=$3 AND claim_token_hash=$4 AND state='CLAIMED' RETURNING task_id`,
        [companyId, claim.id, claim.generation, hashContent(claim.token)])
      if (!dispatch.rows[0]) throw new TaskError('STALE_CLAIM', 403)
      await client.query(`UPDATE channel_tasks SET status='BLOCKED',blocked_code=$3,version=version+1 WHERE company_id=$1 AND id=$2 AND status='OPEN'`, [companyId, dispatch.rows[0].task_id, code])
    })
  }
}
