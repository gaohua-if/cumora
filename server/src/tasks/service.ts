import { messageInputText } from './message-input.js'
import type { StoredAttachment } from '../storage.js'
import { randomUUID, randomBytes } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { checkTaskGovernance } from './governance.js'
import { TaskKnowledgeService } from './knowledge.js'
import { ConfigurationService } from './configuration.js'
import { env } from '../env.js'
import { TaskError, hashContent, parseRule, requireLiveGrant, parseProvenance, checkDestination, canonicalJson,
  type AccessRule, type Provenance } from './contracts.js'

export interface TaskPrincipal { companyId: string; id: string }
export interface TaskRecord {
  id: string; company_id: string; conversation_id: string; creator_principal_id: string
  accountable_binding_id: string; parent_task_id: string | null; root_task_id: string
  objective: string; scope_revision: number; input_revision: number; status: 'OPEN' | 'BLOCKED' | 'DELIVERED' | 'CANCELLED'
  version: number; blocked_code: string | null
  board_card_id: string | null; governance_action_id: string | null; governance_attempt_id: string | null
  definition_version_id:string; configuration:Record<string,unknown>
}
export interface BindingRecord {
  id: string; company_id: string; conversation_id: string; agent_id: string; version: number
  configuration: Record<string, unknown>; definition: Record<string, unknown>
  runtime_assignment_id: string; computer_id: string | null; computer_kind: string | null; engine: string
  definition_version_id:string
  eligibility_version?:number
}

export class TaskService {
  constructor(readonly pool: Pool) {}

  async transaction<T>(companyId: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // Serialize task authorization mutations. Row locks also protect against legacy membership/placement writers.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1))', [`task:${companyId}`])
      const result = await run(client)
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  async member(client: PoolClient, principal: TaskPrincipal, channelId: string): Promise<{ kind: string; audience: AccessRule['audience'] }> {
    const result = await client.query<{ kind: string }>(
      `SELECT c.kind FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id AND m.company_id=c.company_id
       JOIN participants p ON p.id=m.participant_id AND p.company_id=m.company_id
       JOIN company_members cm ON cm.company_id=p.company_id AND cm.user_id=p.id
       WHERE c.id=$1 AND c.company_id=$2 AND m.participant_id=$3 AND p.departed_at IS NULL AND p.kind='human'
       FOR SHARE OF c,m,p,cm`, [channelId, principal.companyId, principal.id])
    const channel = result.rows[0]
    if (!channel) throw new TaskError('CHANNEL_ACCESS_DENIED', 403)
    return { kind: channel.kind, audience: channel.kind === 'direct' ? { kind: 'PERSONAL', id: principal.id } : { kind: 'CHANNEL', id: channelId } }
  }

  async administrator(client: PoolClient, principal: TaskPrincipal): Promise<void> {
    const result = await client.query(`SELECT 1 FROM company_members WHERE company_id=$1 AND user_id=$2 AND role IN ('owner','admin') FOR SHARE`,
      [principal.companyId, principal.id])
    if (!result.rowCount) throw new TaskError('ADMIN_REQUIRED', 403)
  }

  async mode(companyId: string): Promise<'LEGACY' | 'PREPARING' | 'TASK'> {
    // Preparation binaries remain runnable on version 14; undefined table is the only tolerated error.
    try {
      const result = await this.pool.query<{ mode: 'LEGACY' | 'PREPARING' | 'TASK' }>('SELECT mode FROM task_workspace_settings WHERE company_id=$1', [companyId])
      return result.rows[0]?.mode ?? 'LEGACY'
    } catch (error) {
      if ((error as { code?: string }).code === '42P01') return 'LEGACY'
      throw error
    }
  }

  async protectsLegacy(companyId: string): Promise<boolean> {
    return await this.mode(companyId)!=='LEGACY'
  }

  async requireSchema(): Promise<void> {
    const result=await this.pool.query(`SELECT MAX(version) AS version FROM schema_migrations`)
    if(Number(result.rows[0].version)<19) throw new TaskError('TASK_SCHEMA_MIGRATION_REQUIRED')
  }

  async prepare(principal: TaskPrincipal): Promise<void> {
    await this.requireSchema()
    await this.transaction(principal.companyId, async (client) => {
      await this.administrator(client, principal)
      await client.query(`INSERT INTO task_workspace_settings(company_id,mode) VALUES($1,'PREPARING')
        ON CONFLICT(company_id) DO UPDATE SET mode='PREPARING',generation=task_workspace_settings.generation+1,updated_at=NOW()
        WHERE task_workspace_settings.mode='LEGACY'`, [principal.companyId])
    })
  }

  async define(principal: TaskPrincipal, definitionId: string, body: Record<string, unknown>): Promise<string> {
    if (typeof body.instructions !== 'string' || body.instructions.length > 12000 ||
      Object.keys(body).some((key) => !['instructions', 'name', 'role'].includes(key))) throw new TaskError('INVALID_DEFINITION', 400)
    return this.transaction(principal.companyId, async (client) => {
      await this.administrator(client, principal)
      const version = await client.query<{ next: number }>(`SELECT COALESCE(MAX(version),0)+1 AS next FROM agent_definition_versions WHERE company_id=$1 AND definition_id=$2`,
        [principal.companyId, definitionId])
      const id = randomUUID()
      await client.query(`INSERT INTO agent_definition_versions(id,company_id,definition_id,version,body,content_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [id, principal.companyId, definitionId, version.rows[0].next, body, hashContent(JSON.stringify(body)), principal.id])
      return id
    })
  }

  async configuration(principal: TaskPrincipal): Promise<unknown> {
    await this.requireSchema()
    return this.transaction(principal.companyId, async client => {
      await this.administrator(client, principal)
      const channels = await client.query(`SELECT c.id,c.title,c.kind FROM conversations c JOIN conversation_members m
        ON m.company_id=c.company_id AND m.conversation_id=c.id WHERE c.company_id=$1 AND m.participant_id=$2 ORDER BY c.title,c.id`, [principal.companyId, principal.id])
      const channelIds = channels.rows.map(row => row.id)
      const members = await client.query(`SELECT m.conversation_id AS channel_id,p.id,p.name,p.computer_id,p.engine,c.name AS computer_name,c.kind AS computer_kind,c.status AS computer_status
        FROM conversation_members m JOIN participants p ON p.id=m.participant_id AND p.company_id=m.company_id
        LEFT JOIN computers c ON c.id=p.computer_id AND c.company_id=p.company_id AND c.revoked_at IS NULL
        WHERE m.company_id=$1 AND m.conversation_id=ANY($2::text[]) AND p.kind='agent' AND p.departed_at IS NULL ORDER BY p.name,p.id`, [principal.companyId, channelIds])
      const bindings = await client.query(`SELECT b.id,b.conversation_id AS channel_id,b.agent_id,b.definition_version_id,b.alias,b.is_default,b.configuration,b.version
        FROM channel_agent_bindings b JOIN conversation_members m ON m.company_id=b.company_id AND m.conversation_id=b.conversation_id AND m.participant_id=b.agent_id
        JOIN participants p ON p.company_id=b.company_id AND p.id=b.agent_id
        WHERE b.company_id=$1 AND b.conversation_id=ANY($2::text[]) AND b.status='ACTIVE' AND p.departed_at IS NULL ORDER BY b.alias,b.id`, [principal.companyId, channelIds])
      const definitions = await client.query(`SELECT id,definition_id,version,body,content_hash FROM agent_definition_versions WHERE company_id=$1 ORDER BY definition_id,version DESC`, [principal.companyId])
      const computers = await client.query(`SELECT c.id,c.name,c.kind,c.status,a.engine,a.capabilities,a.verification_ref
        FROM computers c LEFT JOIN task_runtime_admissions a ON a.company_id=c.company_id AND a.computer_id=c.id AND a.revoked_at IS NULL
        WHERE c.company_id=$1 AND c.revoked_at IS NULL ORDER BY c.name,c.id`, [principal.companyId])
      return { channels: channels.rows, agents: members.rows, bindings: bindings.rows, definitions: definitions.rows, computers: computers.rows }
    })
  }

  async bind(principal: TaskPrincipal, input: { channelId: string; agentId: string; definitionVersionId: string; alias: string; isDefault: boolean }): Promise<string> {
    return this.transaction(principal.companyId, async (client) => {
      await this.administrator(client, principal)
      await this.member(client, principal, input.channelId)
      const eligible = await client.query(`SELECT 1 FROM participants p JOIN conversation_members m ON m.participant_id=p.id AND m.company_id=p.company_id
        WHERE p.company_id=$1 AND p.id=$2 AND p.kind='agent' AND p.departed_at IS NULL AND m.conversation_id=$3 FOR SHARE OF p,m`,
        [principal.companyId, input.agentId, input.channelId])
      if (!eligible.rowCount) throw new TaskError('BINDING_INELIGIBLE', 403)
      if (input.isDefault) await client.query(`UPDATE channel_agent_bindings SET is_default=FALSE WHERE company_id=$1 AND conversation_id=$2 AND status='ACTIVE' AND is_default`, [principal.companyId, input.channelId])
      const id = randomUUID()
      await client.query(`INSERT INTO channel_agent_bindings(id,company_id,conversation_id,agent_id,definition_version_id,alias,is_default) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [id, principal.companyId, input.channelId, input.agentId, input.definitionVersionId, input.alias, input.isDefault])
      return id
    })
  }

  async binding(client: PoolClient, companyId: string, channelId: string, bindingId?: string): Promise<BindingRecord> {
    const result = await client.query<BindingRecord>(`SELECT b.*, d.body AS definition,p.runtime_assignment_id,p.computer_id,p.engine,c.kind AS computer_kind
      FROM channel_agent_bindings b JOIN agent_definition_versions d ON d.id=b.definition_version_id AND d.company_id=b.company_id
      JOIN participants p ON p.id=b.agent_id AND p.company_id=b.company_id
      JOIN conversation_members m ON m.company_id=b.company_id AND m.conversation_id=b.conversation_id AND m.participant_id=b.agent_id
      LEFT JOIN computers c ON c.id=p.computer_id AND c.company_id=p.company_id AND c.revoked_at IS NULL
      WHERE b.company_id=$1 AND b.conversation_id=$2 AND b.status='ACTIVE' AND p.kind='agent' AND p.departed_at IS NULL AND (p.computer_id IS NULL OR c.id IS NOT NULL)
      AND (($3::text IS NOT NULL AND b.id=$3) OR ($3 IS NULL AND b.is_default)) FOR SHARE OF b,p,m`, [companyId, channelId, bindingId ?? null])
    if (result.rows.length !== 1) throw new TaskError(bindingId ? 'BINDING_INELIGIBLE' : 'DEFAULT_BINDING_REQUIRED', 403)
    return result.rows[0]
  }

  async editBinding(principal:TaskPrincipal,id:string,input:{definitionVersionId:string;alias:string;isDefault:boolean;instructions?:string}):Promise<void> {
    if(!input.alias?.trim() || input.alias.length>120 || (input.instructions!==undefined && (typeof input.instructions!=='string' || input.instructions.length>12000))) throw new TaskError('INVALID_BINDING',400)
    await this.transaction(principal.companyId,async client=>{
      await this.administrator(client,principal)
      const record=(await client.query(`SELECT conversation_id FROM channel_agent_bindings WHERE company_id=$1 AND id=$2 AND status='ACTIVE' FOR UPDATE`,[principal.companyId,id])).rows[0]
      if(!record)throw new TaskError('BINDING_INELIGIBLE',403)
      await this.member(client,principal,record.conversation_id)
      const liveBinding = await this.binding(client,principal.companyId,record.conversation_id,id)
      if (input.isDefault) await client.query(`UPDATE channel_agent_bindings SET is_default=FALSE WHERE company_id=$1 AND conversation_id=$2 AND id<>$3 AND status='ACTIVE' AND is_default`, [principal.companyId, record.conversation_id, id])
      const eligibilityFence = liveBinding.eligibility_version === undefined ? '' : ',eligibility_version=eligibility_version+1'
      await client.query(`UPDATE channel_agent_bindings SET definition_version_id=$3,alias=$4,is_default=$5,configuration=$6,version=version+1${eligibilityFence} WHERE company_id=$1 AND id=$2`,[principal.companyId,id,input.definitionVersionId,input.alias,input.isDefault,input.instructions===undefined?{}:{instructions:input.instructions}])
      await client.query(`UPDATE task_execution_contexts SET revoked_at=NOW() WHERE company_id=$1 AND binding_id=$2`,[principal.companyId,id])
      await client.query(`UPDATE task_dispatches SET state=CASE WHEN state='PENDING' THEN 'CANCELLED' ELSE 'UNKNOWN' END WHERE company_id=$1 AND state IN('PENDING','CLAIMED') AND context_id IN(SELECT id FROM task_execution_contexts WHERE company_id=$1 AND binding_id=$2)`,[principal.companyId,id])
    })
  }

  async bundle(principal:TaskPrincipal,bundleId:string,grantIds:string[]):Promise<string> {
    if(!bundleId?.trim() || bundleId.length>120 || grantIds.length>64 || !grantIds.length)throw new TaskError('INVALID_BUNDLE',400)
    return this.transaction(principal.companyId,async client=>{
      const grants=await client.query(`SELECT * FROM access_grants WHERE company_id=$1 AND id=ANY($2::text[]) FOR SHARE`,[principal.companyId,grantIds])
      if(grants.rows.length!==new Set(grantIds).size)throw new TaskError('GRANT_NOT_FOUND',403)
      for(const grant of grants.rows){requireLiveGrant(grant,grant.version);if(grant.caller_principal_id!==principal.id)throw new TaskError('GRANT_CALLER_DENIED',403);await this.member(client,principal,grant.conversation_id)}
      const prior=await client.query(`SELECT created_by,version FROM access_bundle_versions WHERE company_id=$1 AND bundle_id=$2 ORDER BY version DESC LIMIT 1`,[principal.companyId,bundleId])
      if(prior.rows[0] && prior.rows[0].created_by!==principal.id)throw new TaskError('BUNDLE_OWNER_REQUIRED',403)
      const id=randomUUID()
      await client.query(`INSERT INTO access_bundle_versions(id,company_id,bundle_id,version,grant_ids,created_by) VALUES($1,$2,$3,$4,$5,$6)`,[id,principal.companyId,bundleId,(prior.rows[0]?.version??0)+1,JSON.stringify([...new Set(grantIds)]),principal.id])
      return id
    })
  }

  async referenceBundle(principal:TaskPrincipal,channelId:string,bundleVersionId:string):Promise<void> {
    await this.transaction(principal.companyId,async client=>{
      await this.administrator(client,principal)
      const channel=await this.member(client,principal,channelId)
      const bundle=(await client.query(`SELECT * FROM access_bundle_versions WHERE company_id=$1 AND id=$2 FOR SHARE`,[principal.companyId,bundleVersionId])).rows[0]
      if(!bundle)throw new TaskError('BUNDLE_NOT_FOUND',404)
      const grants=await client.query(`SELECT * FROM access_grants WHERE company_id=$1 AND id=ANY($2::text[]) FOR SHARE`,[principal.companyId,bundle.grant_ids])
      if(grants.rows.length!==bundle.grant_ids.length)throw new TaskError('GRANT_NOT_FOUND',403)
      for(const grant of grants.rows){const rule=requireLiveGrant(grant,grant.version);if(grant.caller_principal_id!==principal.id || grant.conversation_id!==channelId || rule.audience.kind!==channel.audience.kind || rule.audience.id!==channel.audience.id)throw new TaskError('BUNDLE_NOT_APPLICABLE',403)}
      await client.query(`INSERT INTO channel_access_refs(company_id,conversation_id,bundle_version_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[principal.companyId,channelId,bundleVersionId])
    })
  }

  async retireInput(principal:TaskPrincipal,taskId:string,inputId:string):Promise<void> {
    await this.transaction(principal.companyId,async client=>{
      const task=await this.task(client,principal,taskId,'scope')
      if(!['OPEN','BLOCKED'].includes(task.status))throw new TaskError('TASK_CLOSED')
      const result=await client.query(`UPDATE task_inputs SET retired_at=NOW() WHERE company_id=$1 AND task_id=$2 AND id=$3 AND retired_at IS NULL RETURNING id`,[principal.companyId,taskId,inputId])
      if(!result.rowCount)throw new TaskError('INPUT_NOT_FOUND',404)
      await client.query(`UPDATE channel_tasks SET input_revision=input_revision+1,version=version+1 WHERE company_id=$1 AND id=$2`,[principal.companyId,taskId])
    })
  }

  async grantChannel(principal: TaskPrincipal, channelId: string, value: unknown): Promise<string> {
    const rule = parseRule(value)
    return this.transaction(principal.companyId, async (client) => {
      await this.administrator(client, principal)
      const channel = await this.member(client, principal, channelId)
      if (rule.resource !== `channel:${channelId}` || rule.actions.some((action) => !['read', 'publish', 'automate:manual', 'automate:idle', 'automate:background_scan', 'automate:poll.updated'].includes(action)) ||
        rule.audience.kind !== channel.audience.kind || rule.audience.id !== channel.audience.id ||
        rule.identity !== (channel.kind === 'direct' ? `personal:${principal.id}` : `service:channel:${channelId}`) || Date.parse(rule.expiresAt) <= Date.now()) {
        throw new TaskError('RESOURCE_AUTHORITY_UNVERIFIED', 403)
      }
      const id = randomUUID()
      const connectionId = randomUUID()
      await client.query(`INSERT INTO access_connections(id,company_id,owner_principal_id,identity_kind,access_identity,adapter,configuration)
        VALUES($1,$2,$3,$4,$5,'channel',$6)`, [connectionId, principal.companyId, principal.id, channel.kind === 'direct' ? 'PERSONAL' : 'SERVICE', rule.identity, { channelId }])
      await client.query(`INSERT INTO access_grants(id,company_id,conversation_id,issuer_principal_id,caller_principal_id,rule,authority_ref,expires_at,connection_id)
        VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8)`, [id, principal.companyId, channelId, principal.id, rule, `channel-admin:${principal.id}`, rule.expiresAt, connectionId])
      return id
    })
  }

  async revokeGrant(principal: TaskPrincipal, id: string): Promise<void> {
    await this.transaction(principal.companyId, async (client) => {
      const grant = await client.query<{ issuer_principal_id: string }>('SELECT issuer_principal_id FROM access_grants WHERE company_id=$1 AND id=$2 FOR UPDATE', [principal.companyId, id])
      if (grant.rows[0]?.issuer_principal_id !== principal.id) throw new TaskError('RESOURCE_AUTHORITY_UNVERIFIED', 403)
      await client.query('UPDATE access_grants SET revoked_at=NOW(),version=version+1 WHERE company_id=$1 AND id=$2', [principal.companyId, id])
    })
  }

  async revokeConnection(principal: TaskPrincipal, id: string): Promise<void> {
    await this.transaction(principal.companyId, async (client) => {
      const connection = await client.query(`SELECT owner_principal_id FROM access_connections WHERE company_id=$1 AND id=$2 FOR UPDATE`, [principal.companyId, id])
      if (connection.rows[0]?.owner_principal_id !== principal.id) throw new TaskError('CONNECTION_OWNER_REQUIRED', 403)
      await client.query(`UPDATE access_connections SET status='REVOKED' WHERE company_id=$1 AND id=$2`, [principal.companyId, id])
      await client.query(`UPDATE access_grants SET revoked_at=NOW(),version=version+1 WHERE company_id=$1 AND connection_id=$2 AND revoked_at IS NULL`, [principal.companyId, id])
    })
  }

  async task(client: PoolClient, principal: TaskPrincipal, id: string, action?: string): Promise<TaskRecord> {
    const result = await client.query<TaskRecord>('SELECT * FROM channel_tasks WHERE company_id=$1 AND id=$2 FOR UPDATE', [principal.companyId, id])
    const task = result.rows[0]
    if (!task) throw new TaskError('TASK_NOT_FOUND', 404)
    await this.member(client, principal, task.conversation_id)
    if (action && task.creator_principal_id !== principal.id) {
      const controller = await client.query<{ actions: string[] }>(`SELECT actions FROM task_controller_grants WHERE company_id=$1 AND task_id=$2 AND principal_id=$3 AND revoked_at IS NULL FOR SHARE`,
        [principal.companyId, id, principal.id])
      if (!controller.rows[0]?.actions.includes(action)) throw new TaskError('TASK_CONTROL_DENIED', 403)
    }
    return task
  }

  async create(principal: TaskPrincipal, input: { channelId: string; objective: string; ingressKey: string; bindingId?: string; grantIds: string[]; messageId?: string; boardCardId?: string; governanceActionId?: string; governanceAttemptId?: string }, existingClient?: PoolClient): Promise<TaskRecord> {
    if (!input.objective?.trim() || input.objective.length > 12000 || !input.ingressKey || input.ingressKey.length > 200 ||
      !Array.isArray(input.grantIds) || input.grantIds.length > 64) throw new TaskError('INVALID_TASK', 400)
    const run = async (client: PoolClient): Promise<TaskRecord> => {
      const channel = await this.member(client, principal, input.channelId)
      const requestHash=hashContent(canonicalJson({...input,grantIds:[...new Set(input.grantIds)].sort()}))
      const old = await client.query<TaskRecord>('SELECT * FROM channel_tasks WHERE company_id=$1 AND ingress_key=$2', [principal.companyId, input.ingressKey])
      if (old.rows[0]) {
        const request=(await client.query(`SELECT references_json FROM task_authorization_events WHERE company_id=$1 AND task_id=$2 AND operation='task.create' AND outcome='REQUEST_BOUND'`,[principal.companyId,old.rows[0].id])).rows[0]
        if(request && request.references_json.requestHash!==requestHash)throw new TaskError('INGRESS_KEY_CONFLICT')
        if (old.rows[0].creator_principal_id !== principal.id || old.rows[0].conversation_id !== input.channelId || old.rows[0].objective !== input.objective ||
          (input.bindingId && old.rows[0].accountable_binding_id !== input.bindingId)) throw new TaskError('INGRESS_KEY_CONFLICT')
        return old.rows[0]
      }
      const binding = await this.binding(client, principal.companyId, input.channelId, input.bindingId)
      const grants = await client.query<{ id: string; rule: AccessRule; version: number; revoked_at: unknown; expires_at: Date | null; caller_principal_id: string }>(
        `SELECT * FROM access_grants WHERE company_id=$1 AND conversation_id=$2 AND id=ANY($3::text[]) FOR SHARE`, [principal.companyId, input.channelId, input.grantIds])
      if (grants.rows.length !== new Set(input.grantIds).size) throw new TaskError('GRANT_NOT_FOUND', 403)
      for (const grant of grants.rows) {
        const rule = requireLiveGrant(grant, grant.version)
        // Bundle membership is a reference, never proof that its caller may exercise a grant.
        if (grant.caller_principal_id !== principal.id || rule.audience.kind !== channel.audience.kind || rule.audience.id !== channel.audience.id) throw new TaskError('GRANT_CALLER_DENIED', 403)
      }
      const id = randomUUID()
      const snapshot = await new ConfigurationService(this).snapshot(client, principal.companyId, binding)
      const inserted = await client.query<TaskRecord>(`INSERT INTO channel_tasks(id,company_id,conversation_id,creator_principal_id,accountable_binding_id,root_task_id,objective,ingress_key,reply_message_id,board_card_id,governance_action_id,governance_attempt_id,definition_version_id,configuration)
        VALUES($1,$2,$3,$4,$5,$1,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [id, principal.companyId, input.channelId, principal.id, binding.id, input.objective, input.ingressKey, input.messageId ?? null, input.boardCardId ?? null, input.governanceActionId ?? null, input.governanceAttemptId ?? null,binding.definition_version_id,snapshot])
      await checkTaskGovernance(client, inserted.rows[0], binding)
      await client.query(`INSERT INTO task_authorization_events(id,company_id,task_id,principal_id,operation,outcome,references_json) VALUES($1,$2,$3,$4,'task.create','REQUEST_BOUND',$5)`,[randomUUID(),principal.companyId,id,principal.id,{requestHash}])
      await client.query(`INSERT INTO task_scope_revisions(company_id,task_id,revision,objective,changed_by) VALUES($1,$2,1,$3,$4)`, [principal.companyId, id, input.objective, principal.id])
      for (const grant of grants.rows) await client.query(`INSERT INTO task_grant_versions(id,company_id,task_id,source_grant_id,source_version,scope_revision,rule) VALUES($1,$2,$3,$4,$5,1,$6)`,
        [randomUUID(), principal.companyId, id, grant.id, grant.version, grant.rule])
      await this.addInput(client, principal, inserted.rows[0], input.messageId ? { messageId: input.messageId } : { text: input.objective })
      return inserted.rows[0]
    }
    return existingClient ? run(existingClient) : this.transaction(principal.companyId, run)
  }

  async addInput(client: PoolClient, principal: TaskPrincipal, task: TaskRecord, input: { messageId?: string; text?: string }): Promise<void> {
    let content = input.text
    let source: Provenance['sources'][number]
    if (input.messageId) {
      const result = await client.query<{ body: string; author_id: string; task_source_version: number; attachment: StoredAttachment | null }>(`SELECT body,author_id,task_source_version,attachment FROM messages WHERE id=$1 AND conversation_id=$2 FOR SHARE`, [input.messageId, task.conversation_id])
      if (!result.rows[0] || result.rows[0].author_id !== principal.id) throw new TaskError('INPUT_SOURCE_DENIED', 403)
      content = messageInputText(result.rows[0].body, result.rows[0].attachment)
      source = { kind: 'MESSAGE', id: input.messageId, version: result.rows[0].task_source_version }
      await client.query(`INSERT INTO task_message_links(company_id,task_id,message_id,purpose) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [principal.companyId, task.id, input.messageId, task.input_revision === 1 ? 'TRIGGER' : 'SUPPLEMENT'])
    } else {
      if (!content?.trim() || content.length > 12000) throw new TaskError('INVALID_INPUT', 400)
      // The root scope revision is the source of user-provided text; supplied provenance is never accepted.
      source = { kind: 'TASK_SCOPE', id: task.id, version: task.scope_revision }
    }
    const channel = await this.member(client, principal, task.conversation_id)
    const provenance: Provenance = { companyId: principal.companyId, conversationId: task.conversation_id,
      audience: channel.audience, sources: [source], destinations: ['task-model', 'artifact', 'channel'] }
    await client.query(`INSERT INTO task_inputs(id,company_id,task_id,kind,reference_id,content,content_hash,provenance,input_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [randomUUID(), principal.companyId, task.id, input.messageId ? 'MESSAGE' : 'TEXT', input.messageId ?? null, content, hashContent(content!), provenance, task.input_revision])
  }

  async supplement(principal: TaskPrincipal, taskId: string, input: { messageId?: string; text?: string }): Promise<void> {
    await this.transaction(principal.companyId, async (client) => {
      const task = await this.task(client, principal, taskId)
      if (!['OPEN', 'BLOCKED'].includes(task.status)) throw new TaskError('TASK_CLOSED')
      task.input_revision++
      await this.addInput(client, principal, task, input)
      await client.query('UPDATE channel_tasks SET input_revision=$3,version=version+1,updated_at=NOW() WHERE company_id=$1 AND id=$2', [principal.companyId, taskId, task.input_revision])
      // Input alone never silently changes scope or starts a new execution.
    })
  }

  async steer(principal:TaskPrincipal,taskId:string,key:string,text:string):Promise<string>{
    return this.transaction(principal.companyId,async client=>{
      const task=await this.task(client,principal,taskId,'drive')
      const old=(await client.query(`SELECT id FROM task_dispatches WHERE company_id=$1 AND dispatch_key=$2`,[principal.companyId,`${taskId}:${key}`])).rows[0]
      if(old)return old.id
      if(!['OPEN','BLOCKED'].includes(task.status))throw new TaskError('TASK_CLOSED')
      task.input_revision++
      await this.addInput(client,principal,task,{text})
      await client.query(`UPDATE channel_tasks SET input_revision=$3,version=version+1 WHERE company_id=$1 AND id=$2`,[principal.companyId,taskId,task.input_revision])
      return this.drive(principal,taskId,key,client)
    })
  }

  async cancel(principal: TaskPrincipal, taskId: string): Promise<void> {
    await this.transaction(principal.companyId, async (client) => {
      const task = await this.task(client, principal, taskId, 'cancel')
      if (task.status === 'DELIVERED') throw new TaskError('TASK_CLOSED')
      await client.query(`UPDATE channel_tasks SET status='CANCELLED',version=version+1 WHERE company_id=$1 AND root_task_id=$2`, [principal.companyId, task.root_task_id])
      await client.query(`UPDATE task_execution_contexts SET revoked_at=NOW() WHERE company_id=$1 AND task_id IN(SELECT id FROM channel_tasks WHERE root_task_id=$2)`, [principal.companyId, task.root_task_id])
      await client.query(`UPDATE task_dispatches SET state=CASE WHEN state='PENDING' THEN 'CANCELLED' ELSE 'UNKNOWN' END WHERE company_id=$1 AND task_id IN(SELECT id FROM channel_tasks WHERE root_task_id=$2) AND state IN('PENDING','CLAIMED')`, [principal.companyId, task.root_task_id])
    })
  }

  async reviseScope(principal: TaskPrincipal, taskId: string, objective: string): Promise<void> {
    if (!objective?.trim() || objective.length > 12000) throw new TaskError('INVALID_SCOPE', 400)
    await this.transaction(principal.companyId, async (client) => {
      const task = await this.task(client, principal, taskId, 'scope')
      if (!['OPEN', 'BLOCKED','DELIVERED'].includes(task.status)) throw new TaskError('TASK_CLOSED')
      if (task.parent_task_id) throw new TaskError('ROOT_SCOPE_REQUIRED', 403)
      const live = await client.query(`SELECT 1 FROM task_dispatches WHERE company_id=$1 AND task_id IN(SELECT id FROM channel_tasks WHERE company_id=$1 AND root_task_id=$2) AND state IN('CLAIMED','UNKNOWN','COMPLETED','BLOCKED') AND stopped_at IS NULL`, [principal.companyId, taskId])
      if (live.rowCount) throw new TaskError('EXECUTOR_NOT_STOPPED')
      await client.query(`UPDATE channel_tasks SET status='CANCELLED',version=version+1 WHERE company_id=$1 AND parent_task_id=$2`, [principal.companyId, taskId])
      await client.query(`UPDATE task_inputs SET retired_at=NOW() WHERE company_id=$1 AND task_id=$2 AND (kind='ARTIFACT' OR (kind='TEXT' AND provenance->'sources' @> $3::jsonb))`, [principal.companyId, taskId,JSON.stringify([{kind:'TASK_SCOPE',id:taskId,version:task.scope_revision}])])
      await client.query(`UPDATE task_grant_versions SET revoked_at=NOW() WHERE company_id=$1 AND task_id=$2`, [principal.companyId,taskId])
      await client.query(`INSERT INTO task_scope_revisions(company_id,task_id,revision,objective,changed_by) VALUES($1,$2,$3,$4,$5)`, [principal.companyId, taskId, task.scope_revision + 1, objective, principal.id])
      await client.query(`UPDATE channel_tasks SET objective=$3,scope_revision=scope_revision+1,version=version+1 WHERE company_id=$1 AND id=$2`, [principal.companyId, taskId, objective])
      task.scope_revision++; task.input_revision++
      await this.addInput(client, principal, task, {text:objective})
      await client.query(`UPDATE channel_tasks SET input_revision=$3,status='OPEN',blocked_code=NULL WHERE company_id=$1 AND id=$2`, [principal.companyId,taskId,task.input_revision])
      await client.query(`UPDATE task_execution_contexts SET revoked_at=NOW() WHERE company_id=$1 AND task_id IN(SELECT id FROM channel_tasks WHERE company_id=$1 AND root_task_id=$2)`, [principal.companyId, taskId])
      await client.query(`UPDATE task_dispatches SET state='CANCELLED' WHERE company_id=$1 AND task_id IN(SELECT id FROM channel_tasks WHERE company_id=$1 AND root_task_id=$2) AND state='PENDING'`, [principal.companyId, taskId])
      // Scope revisions require newly approved grants, never promote old snapshot authority automatically.
    })
  }

  async controller(principal: TaskPrincipal, taskId: string, targetId: string, actions: string[]): Promise<void> {
    if (actions.some((action) => !['drive', 'cancel', 'scope', 'knowledge'].includes(action))) throw new TaskError('INVALID_CONTROLLER', 400)
    await this.transaction(principal.companyId, async (client) => {
      const task = await this.task(client, principal, taskId)
      if (task.creator_principal_id !== principal.id) throw new TaskError('TASK_CONTROL_DENIED', 403)
      await this.member(client, { companyId: principal.companyId, id: targetId }, task.conversation_id)
      await client.query(`INSERT INTO task_controller_grants(company_id,task_id,principal_id,actions,granted_by,revoked_at) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(company_id,task_id,principal_id) DO UPDATE SET actions=EXCLUDED.actions,granted_by=EXCLUDED.granted_by,revoked_at=EXCLUDED.revoked_at`,
        [principal.companyId, taskId, targetId, JSON.stringify(actions), principal.id, actions.length ? null : new Date()])
    })
  }

  async approveGrants(principal: TaskPrincipal, taskId: string, grantIds: string[]): Promise<void> {
    await this.transaction(principal.companyId, async (client) => {
      const task = await this.task(client, principal, taskId, 'scope')
      if (task.creator_principal_id !== principal.id || !['OPEN', 'BLOCKED'].includes(task.status)) throw new TaskError('TASK_CONTROL_DENIED', 403)
      const channel = await this.member(client, principal, task.conversation_id)
      const result = await client.query(`SELECT * FROM access_grants WHERE company_id=$1 AND conversation_id=$2 AND id=ANY($3::text[]) FOR SHARE`, [principal.companyId, task.conversation_id, grantIds])
      if (result.rows.length !== new Set(grantIds).size) throw new TaskError('GRANT_NOT_FOUND', 403)
      for (const grant of result.rows) {
        const rule = requireLiveGrant(grant, grant.version)
        if (grant.caller_principal_id !== principal.id || rule.audience.kind !== channel.audience.kind || rule.audience.id !== channel.audience.id) throw new TaskError('GRANT_CALLER_DENIED', 403)
        const old=await client.query(`SELECT 1 FROM task_grant_versions WHERE company_id=$1 AND task_id=$2 AND source_grant_id=$3 AND source_version=$4 AND scope_revision=$5 AND revoked_at IS NULL`,[principal.companyId,taskId,grant.id,grant.version,task.scope_revision])
        if(old.rowCount)continue
        await client.query(`INSERT INTO task_grant_versions(id,company_id,task_id,source_grant_id,source_version,scope_revision,rule) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [randomUUID(), principal.companyId, taskId, grant.id, grant.version, task.scope_revision, rule])
      }
    })
  }

  async connectChannel(principal: TaskPrincipal, channelId: string): Promise<string> {
    return this.transaction(principal.companyId, async (client) => {
      await this.administrator(client, principal)
      const channel = await this.member(client, principal, channelId)
      const id = randomUUID()
      await client.query(`INSERT INTO access_connections(id,company_id,owner_principal_id,identity_kind,access_identity,adapter,configuration)
        VALUES($1,$2,$3,$4,$5,'channel',$6)`, [id, principal.companyId, principal.id, channel.kind === 'direct' ? 'PERSONAL' : 'SERVICE',
        channel.kind === 'direct' ? `personal:${principal.id}` : `service:channel:${channelId}`, { channelId }])
      return id
    })
  }

  /** Called inside the membership transaction, after the prospective insert.
   * A failed check rolls back the member and its join message together. */
  async checkMembershipHistory(client: PoolClient, companyId: string, channelId: string, memberId: string): Promise<void> {
    const exists = (await client.query(`SELECT to_regclass('channel_tasks') AS tasks`)).rows[0].tasks
    if (!exists) return
    const tasks = await client.query<TaskRecord>(`SELECT * FROM channel_tasks WHERE company_id=$1 AND conversation_id=$2`, [companyId, channelId])
    if (!tasks.rowCount) return
    try {
      const invalid = await client.query(`SELECT 1 FROM participants p WHERE p.id=$1 AND p.company_id=$2 AND p.kind='human'
        AND NOT EXISTS(SELECT 1 FROM company_members cm WHERE cm.company_id=p.company_id AND cm.user_id=p.id)`, [memberId, companyId])
      if (invalid.rowCount) throw new TaskError('SOURCE_AUDIENCE_DENIED',403)
      for (const task of tasks.rows) {
        if (['OPEN','BLOCKED'].includes(task.status)) {
          const inputs = await client.query(`SELECT provenance FROM task_inputs WHERE company_id=$1 AND task_id=$2 AND retired_at IS NULL`, [companyId, task.id])
          for (const input of inputs.rows) await this.liveSources(client, parseProvenance(input.provenance), task, 'channel')
        }
        const published = await client.query(`SELECT a.* FROM task_deliveries d JOIN artifact_versions a
          ON a.company_id=d.company_id AND (d.artifact_ids @> jsonb_build_array(a.id) OR d.evidence_ids @> jsonb_build_array(a.id))
          WHERE d.company_id=$1 AND d.task_id=$2 AND d.message_id IS NOT NULL`, [companyId, task.id])
        for (const artifact of published.rows) {
          if (hashContent(artifact.content)!==artifact.content_hash) throw new TaskError('ARTIFACT_HASH_MISMATCH',403)
          await this.liveSources(client, parseProvenance(artifact.provenance), task, 'channel')
        }
      }
    } catch (error) {
      if (error instanceof TaskError) throw new TaskError('MEMBERSHIP_SOURCE_AUTHORITY_REQUIRED',409)
      throw error
    }
  }

  async liveSources(client: PoolClient, p: Provenance, task: TaskRecord, destination: string, path = new Set<string>()): Promise<void> {
    if (path.size > 32) throw new TaskError('SOURCE_GRAPH_TOO_DEEP', 403)
    const channel = await this.member(client, { companyId: task.company_id, id: task.creator_principal_id }, task.conversation_id)
    checkDestination(p, { companyId: task.company_id, conversationId: task.conversation_id, audience: channel.audience, destination })
    for (const source of p.sources) {
      if (source.kind === 'MESSAGE') {
        const found = await client.query(`SELECT 1 FROM messages WHERE id=$1 AND conversation_id=$2 AND task_source_version=$3 FOR SHARE`, [source.id, task.conversation_id, source.version])
        if (!found.rowCount) throw new TaskError('SOURCE_REVOKED', 403)
      } else if (source.kind === 'TASK_SCOPE') {
        const found = await client.query(`SELECT 1 FROM task_scope_revisions r JOIN channel_tasks t ON t.id=r.task_id AND t.company_id=r.company_id
          WHERE r.company_id=$1 AND r.task_id=$2 AND r.revision=$3 AND t.conversation_id=$4 AND t.status<>'CANCELLED' AND t.scope_revision=r.revision`, [task.company_id, source.id, source.version, task.conversation_id])
        if (!found.rowCount) throw new TaskError('SOURCE_UNKNOWN', 403)
      } else if (source.kind === 'GRANT') {
        const found = await client.query(`SELECT * FROM access_grants WHERE company_id=$1 AND id=$2 FOR SHARE`, [task.company_id, source.id])
        if (!found.rows[0]) throw new TaskError('SOURCE_UNKNOWN', 403)
        const rule = requireLiveGrant(found.rows[0], source.version)
        if (!rule.destinations.includes(destination)) throw new TaskError('SOURCE_DESTINATION_DENIED', 403)
      } else if(source.kind==='BOARD'){
        const sourceCard=(await client.query(`SELECT c.title,c.description FROM board_cards c JOIN boards b ON b.id=c.board_id WHERE b.company_id=$1 AND c.id=$2 AND c.governance_mode='COLLABORATION' FOR SHARE OF c,b`,[task.company_id,source.id])).rows[0]
        if(!sourceCard || hashContent(canonicalJson(sourceCard))!==source.hash)throw new TaskError('SOURCE_REVOKED',403)
        // Boards are workspace-visible. Every human in the destination must
        // still be a workspace member; no private external board is inferred.
        const audience=await client.query(`SELECT 1 FROM conversation_members m JOIN participants p ON p.id=m.participant_id AND p.company_id=m.company_id WHERE m.company_id=$1 AND m.conversation_id=$2 AND p.kind='human' AND (p.departed_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM company_members cm WHERE cm.company_id=m.company_id AND cm.user_id=m.participant_id))`,[task.company_id,task.conversation_id])
        if(audience.rowCount)throw new TaskError('SOURCE_AUDIENCE_DENIED',403)
      } else if(source.kind==='GOVERNANCE'){
        const sourceVersion=(await client.query(`SELECT a.allowed_reader_scope,a.card_id FROM governance_artifact_versions a JOIN board_cards c ON c.id=a.card_id JOIN boards b ON b.id=c.board_id AND b.company_id=a.company_id WHERE a.company_id=$1 AND a.version_id=$2`,[task.company_id,source.id])).rows[0]
        if(source.version!==1 || !sourceVersion || !Array.isArray(sourceVersion.allowed_reader_scope) || !sourceVersion.allowed_reader_scope.some((scope:{channelId?:string})=>scope.channelId===task.conversation_id))throw new TaskError('GOVERNANCE_ARTIFACT_AUDIENCE_DENIED',403)
      } else if (source.kind === 'ARTIFACT') {
        if (path.has(source.id)) throw new TaskError('SOURCE_GRAPH_CYCLE', 403)
        const found = await client.query(`SELECT provenance,content,content_hash FROM artifact_versions WHERE company_id=$1 AND id=$2`, [task.company_id, source.id])
        if (!found.rows[0]) throw new TaskError('SOURCE_UNKNOWN', 403)
        if (hashContent(found.rows[0].content) !== found.rows[0].content_hash) throw new TaskError('ARTIFACT_HASH_MISMATCH',403)
        await this.liveSources(client, parseProvenance(found.rows[0].provenance), task, destination, new Set([...path, source.id]))
      } else if (source.kind === 'KNOWLEDGE') {
        if (path.has(source.id)) throw new TaskError('SOURCE_GRAPH_CYCLE', 403)
        const found = await client.query(`SELECT provenance FROM knowledge_entries WHERE company_id=$1 AND id=$2 AND version=$3 AND state='CONFIRMED' FOR SHARE`, [task.company_id, source.id, source.version])
        if (!found.rows[0]) throw new TaskError('SOURCE_REVOKED', 403)
        const original = parseProvenance(found.rows[0].provenance)
        if (original.conversationId === task.conversation_id) {
          await this.liveSources(client, original, task, destination, new Set([...path, source.id]))
        } else {
          const publication = await client.query(`SELECT * FROM knowledge_publications WHERE company_id=$1 AND knowledge_id=$2 AND knowledge_version=$3 AND target_conversation_id=$4 AND revoked_at IS NULL FOR SHARE`, [task.company_id, source.id, source.version, task.conversation_id])
          if (!publication.rows[0] || !original.destinations.includes(destination)) throw new TaskError('SOURCE_PUBLICATION_AUTHORITY_REQUIRED', 403)
          const principal = { companyId: task.company_id, id: publication.rows[0].published_by }
          const current = await this.disclosureAuthority(client, principal, original, task.conversation_id)
          if (canonicalJson(current) !== canonicalJson(publication.rows[0].authority_refs)) throw new TaskError('SOURCE_REVOKED', 403)
        }
      } else throw new TaskError('SOURCE_UNKNOWN', 403)
    }
  }

  /** Explicit disclosure requires ownership of every leaf; channel administration alone does not suffice. */
  async disclosureAuthority(client: PoolClient, principal: TaskPrincipal, provenance: Provenance, targetChannel: string, path = new Set<string>()): Promise<unknown[]> {
    if (path.size > 32) throw new TaskError('SOURCE_GRAPH_TOO_DEEP', 403)
    await this.member(client, principal, provenance.conversationId)
    await this.member(client, principal, targetChannel)
    const authority: unknown[] = []
    for (const source of provenance.sources) {
      if (source.kind === 'MESSAGE') {
        const found = await client.query(`SELECT author_id FROM messages WHERE company_id=$1 AND conversation_id=$2 AND id=$3 AND task_source_version=$4 FOR SHARE`, [principal.companyId, provenance.conversationId, source.id, source.version])
        if (found.rows[0]?.author_id !== principal.id) throw new TaskError('SOURCE_PUBLICATION_AUTHORITY_REQUIRED', 403)
        authority.push({ ...source, owner: principal.id })
      } else if (source.kind === 'TASK_SCOPE') {
        const found = await client.query(`SELECT creator_principal_id,status FROM channel_tasks WHERE company_id=$1 AND conversation_id=$2 AND id=$3 FOR SHARE`, [principal.companyId, provenance.conversationId, source.id])
        if (found.rows[0]?.creator_principal_id !== principal.id || found.rows[0].status === 'CANCELLED') throw new TaskError('SOURCE_PUBLICATION_AUTHORITY_REQUIRED', 403)
        authority.push({ ...source, owner: principal.id })
      } else if(source.kind==='GOVERNANCE'){
        const found=(await client.query(`SELECT allowed_reader_scope FROM governance_artifact_versions WHERE company_id=$1 AND version_id=$2`,[principal.companyId,source.id])).rows[0]
        if(source.version!==1 || !found || !Array.isArray(found.allowed_reader_scope) || !found.allowed_reader_scope.some((scope:{channelId?:string})=>scope.channelId===targetChannel))throw new TaskError('SOURCE_PUBLICATION_AUTHORITY_REQUIRED',403)
        authority.push({...source,targetChannel,publicationRef:source.id})
      } else if (source.kind === 'ARTIFACT') {
        if (path.has(source.id)) throw new TaskError('SOURCE_GRAPH_CYCLE', 403)
        const found = await client.query(`SELECT provenance,content,content_hash FROM artifact_versions WHERE company_id=$1 AND id=$2`, [principal.companyId, source.id])
        if (!found.rows[0]) throw new TaskError('SOURCE_UNKNOWN', 403)
        authority.push(...await this.disclosureAuthority(client, principal, parseProvenance(found.rows[0].provenance), targetChannel, new Set([...path, source.id])))
      } else if (source.kind === 'GRANT') {
        const found = await client.query(`SELECT * FROM access_grants WHERE company_id=$1 AND id=$2 FOR SHARE`, [principal.companyId, source.id])
        if (!found.rows[0]) throw new TaskError('SOURCE_UNKNOWN', 403)
        const rule = requireLiveGrant(found.rows[0], source.version)
        // Resource sharing must itself name the full target audience. Never switch a personal connection implicitly.
        if (rule.audience.kind !== 'CHANNEL' || rule.audience.id !== targetChannel || !rule.actions.includes('publish')) throw new TaskError('SOURCE_PUBLICATION_AUTHORITY_REQUIRED', 403)
        authority.push({ ...source, owner: found.rows[0].issuer_principal_id })
      } else throw new TaskError('SOURCE_PUBLICATION_AUTHORITY_REQUIRED', 403)
    }
    return authority
  }

  async drive(principal: TaskPrincipal, taskId: string, key: string, existingClient?:PoolClient): Promise<string> {
    if(!key?.trim() || key.length>160) throw new TaskError('INVALID_DISPATCH_KEY',400)
    const run = async (client:PoolClient) => {
      const task = await this.task(client, principal, taskId, 'drive')
      if (!['OPEN', 'BLOCKED'].includes(task.status)) throw new TaskError('TASK_CLOSED')
      const settings = await client.query<{ generation: number }>(`SELECT generation FROM task_workspace_settings WHERE company_id=$1 AND mode='TASK' FOR SHARE`, [principal.companyId])
      if (!settings.rows[0]) throw new TaskError('TASK_MODE_REQUIRED')
      const old = await client.query<{ id: string }>('SELECT id FROM task_dispatches WHERE company_id=$1 AND dispatch_key=$2', [principal.companyId, `${taskId}:${key}`])
      if (old.rows[0]) return old.rows[0].id
      const ownLive=await client.query(`SELECT 1 FROM task_dispatches WHERE company_id=$1 AND task_id=$2 AND state IN('CLAIMED','UNKNOWN','COMPLETED','BLOCKED') AND stopped_at IS NULL`,[principal.companyId,taskId])
      const pendingLive=await client.query(`SELECT 1 FROM task_dispatches WHERE company_id=$1 AND task_id=$2 AND state='PENDING'`,[principal.companyId,taskId])
      if(pendingLive.rowCount) throw new TaskError('TASK_DISPATCH_ALREADY_PENDING')
      if(ownLive.rowCount && key.startsWith('plan:')) throw new TaskError('EXECUTOR_NOT_STOPPED')
      if (task.parent_task_id) {
        const plan = await client.query(`SELECT p.plan,t.status,t.scope_revision FROM task_plan_versions p JOIN channel_tasks t ON t.id=p.task_id AND t.company_id=p.company_id
          WHERE p.company_id=$1 AND p.task_id=$2 ORDER BY p.revision DESC LIMIT 1`, [principal.companyId, task.parent_task_id])
        if (!plan.rows[0] || !['OPEN', 'BLOCKED'].includes(plan.rows[0].status) || plan.rows[0].scope_revision !== plan.rows[0].plan.scopeRevision) throw new TaskError('PLAN_SCOPE_STALE')
        const dependent = await client.query(`SELECT 1 FROM task_dependencies d JOIN channel_tasks t ON t.id=d.dependency_task_id AND t.company_id=d.company_id
          WHERE d.company_id=$1 AND d.task_id=$2 AND t.status<>'DELIVERED'`, [principal.companyId, taskId])
        if (dependent.rowCount) throw new TaskError('PLAN_DEPENDENCY_NOT_DELIVERED')
        const missingHandoff=await client.query(`SELECT 1 FROM task_dependencies dep JOIN channel_tasks producer ON producer.id=dep.dependency_task_id AND producer.company_id=dep.company_id
          JOIN task_deliveries delivery ON delivery.task_id=producer.id AND delivery.company_id=producer.company_id AND delivery.scope_revision=producer.scope_revision
          CROSS JOIN LATERAL jsonb_array_elements_text(delivery.artifact_ids) version(id)
          WHERE dep.company_id=$1 AND dep.task_id=$2 AND (NOT EXISTS(SELECT 1 FROM artifact_handoffs h WHERE h.company_id=dep.company_id AND h.version_id=version.id AND h.consumer_task_id=dep.task_id AND h.consumer_binding_id=$3)
          OR NOT EXISTS(SELECT 1 FROM task_inputs i WHERE i.company_id=dep.company_id AND i.task_id=dep.task_id AND i.kind='ARTIFACT' AND i.reference_id=version.id AND i.retired_at IS NULL))`,[principal.companyId,taskId,task.accountable_binding_id])
        if(missingHandoff.rowCount)throw new TaskError('PLAN_HANDOFF_REQUIRED')
        const live = await client.query(`SELECT 1 FROM task_dispatches d JOIN channel_tasks t ON t.id=d.task_id AND t.company_id=d.company_id
          WHERE d.company_id=$1 AND t.parent_task_id=$2 AND d.state IN('PENDING','CLAIMED','UNKNOWN','COMPLETED','BLOCKED') AND d.stopped_at IS NULL`, [principal.companyId, task.parent_task_id])
        if ((live.rowCount ?? 0) >= plan.rows[0].plan.parallelism) throw new TaskError('PLAN_PARALLELISM_LIMIT')
      }
      const binding = await this.binding(client, principal.companyId, task.conversation_id, task.accountable_binding_id)
      await checkTaskGovernance(client, task, binding)
      if((!binding.computer_id || binding.computer_kind==='cloud') && binding.engine && binding.engine!=='managed')throw new TaskError('RUNTIME_CAPABILITY_UNQUALIFIED')
      if (binding.computer_id && binding.computer_kind !== 'cloud') {
        const admission = await client.query(`SELECT capabilities FROM task_runtime_admissions WHERE company_id=$1 AND computer_id=$2 AND engine=$3 AND revoked_at IS NULL FOR SHARE`, [principal.companyId, binding.computer_id, binding.engine])
        if (!admission.rowCount) throw new TaskError('RUNTIME_CAPABILITY_UNQUALIFIED')
        if (env.LOCAL_ONLY && admission.rows[0].capabilities?.modelProvider !== 'codex-login') throw new TaskError('SERVER_MODEL_UNAVAILABLE',503)
      }
      if (env.LOCAL_ONLY && (!binding.computer_id || binding.computer_kind === 'cloud')) throw new TaskError('SERVER_MODEL_UNAVAILABLE',503)
      const grants = await client.query(`SELECT s.*, g.version AS live_version,g.revoked_at AS live_revoked,g.expires_at AS live_expires FROM task_grant_versions s
        JOIN access_grants g ON g.id=s.source_grant_id AND g.company_id=s.company_id WHERE s.company_id=$1 AND s.task_id=$2 AND s.scope_revision=$3 AND s.revoked_at IS NULL FOR SHARE OF s,g`, [principal.companyId, taskId, task.scope_revision])
      for (const grant of grants.rows) requireLiveGrant({ ...grant, version: grant.live_version, revoked_at: grant.live_revoked, expires_at: grant.live_expires }, grant.source_version)
      const knowledge = await new TaskKnowledgeService(this).retrieve(task, binding.agent_id, 'task-model', client)
      for (const entry of knowledge) {
        const existing = await client.query(`SELECT 1 FROM task_inputs WHERE company_id=$1 AND task_id=$2 AND kind='KNOWLEDGE' AND reference_id=$3 AND retired_at IS NULL`, [principal.companyId,taskId,entry.id])
        if (!existing.rowCount) await client.query(`INSERT INTO task_inputs(id,company_id,task_id,kind,reference_id,content,content_hash,provenance,input_revision) VALUES($1,$2,$3,'KNOWLEDGE',$4,$5,$6,$7,$8)`,
          [randomUUID(),principal.companyId,taskId,entry.id,entry.body,hashContent(entry.body),{...entry.provenance,sources:[{kind:'KNOWLEDGE',id:entry.id,version:entry.version}]},task.input_revision])
      }
      const inputs = await client.query(`SELECT id,provenance FROM task_inputs WHERE company_id=$1 AND task_id=$2 AND input_revision<=$3 AND retired_at IS NULL ORDER BY created_at,id`, [principal.companyId, taskId, task.input_revision])
      for (const input of inputs.rows) await this.liveSources(client, parseProvenance(input.provenance), task, 'task-model')
      const contextId = randomUUID()
      await client.query(`INSERT INTO task_execution_contexts(id,company_id,task_id,binding_id,scope_revision,input_revision,workspace_generation,binding_version,assignment_id,computer_id,runtime,configuration,input_ids,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW()+INTERVAL '15 minutes')`,
        [contextId, principal.companyId, taskId, binding.id, task.scope_revision, task.input_revision, settings.rows[0].generation, binding.eligibility_version ?? binding.version, binding.runtime_assignment_id, binding.computer_id,
          { engine: binding.engine, computerKind: binding.computer_kind }, task.configuration, JSON.stringify(inputs.rows.map((row) => row.id))])
      const id = randomUUID()
      await client.query(`INSERT INTO task_dispatches(id,company_id,task_id,context_id,agent_id,dispatch_key) VALUES($1,$2,$3,$4,$5,$6)`, [id, principal.companyId, taskId, contextId, binding.agent_id, `${taskId}:${key}`])
      await client.query(`UPDATE channel_tasks SET status='OPEN',blocked_code=NULL WHERE company_id=$1 AND id=$2`, [principal.companyId, taskId])
      return id
    }
    return existingClient?run(existingClient):this.transaction(principal.companyId,run)
  }

  async claim(companyId: string, agentId: string, claimant: string): Promise<{ id: string; contextId: string; generation: number; token: string } | null> {
    return this.transaction(companyId, async (client) => {
      await client.query(`UPDATE task_dispatches SET state='UNKNOWN' WHERE company_id=$1 AND agent_id=$2 AND state='CLAIMED' AND lease_expires_at<=NOW()`, [companyId, agentId])
      const live = await client.query(`SELECT 1 FROM task_dispatches WHERE company_id=$1 AND agent_id=$2 AND state IN('CLAIMED','UNKNOWN','COMPLETED','BLOCKED') AND stopped_at IS NULL`, [companyId, agentId])
      if (live.rowCount) return null
      const pending = await client.query<{ id: string; context_id: string; claim_generation: number }>(`SELECT * FROM task_dispatches WHERE company_id=$1 AND agent_id=$2 AND state='PENDING' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [companyId, agentId])
      if (!pending.rows[0]) return null
      const dispatch = pending.rows[0]
      await client.query(`UPDATE channel_tasks SET status='OPEN',blocked_code=NULL WHERE company_id=$1 AND id=(SELECT task_id FROM task_dispatches WHERE id=$2) AND status='BLOCKED'`, [companyId, dispatch.id])
      const token = randomBytes(32).toString('base64url')
      await client.query(`UPDATE task_dispatches SET state='CLAIMED',claim_generation=claim_generation+1,claimant=$3,claim_token_hash=$4,lease_expires_at=NOW()+INTERVAL '60 seconds' WHERE company_id=$1 AND id=$2`, [companyId, dispatch.id, claimant, hashContent(token)])
      return { id: dispatch.id, contextId: dispatch.context_id, generation: dispatch.claim_generation + 1, token }
    })
  }

  async confirmStopped(companyId: string, dispatchId: string, generation: number, token: string): Promise<void> {
    await this.transaction(companyId, async (client) => {
      const result = await client.query(`UPDATE task_dispatches SET stopped_at=NOW(),state=CASE WHEN state IN('CLAIMED','UNKNOWN') THEN 'BLOCKED' ELSE state END
        WHERE company_id=$1 AND id=$2 AND claim_generation=$3 AND claim_token_hash=$4 RETURNING id`, [companyId, dispatchId, generation, hashContent(token)])
      if (!result.rowCount) throw new TaskError('STALE_CLAIM', 403)
    })
  }
}
