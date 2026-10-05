import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { createAgentRecord } from '../agents/create.js'
import { addConversationMember } from '../agents/membership.js'
import { TaskError, hashContent } from './contracts.js'
import { TaskService, type TaskPrincipal } from './service.js'

export const defaultAidaInstructions = '你是 Aida，当前群聊的默认助手和协调者。直接完成简单任务；需要专业分工、并行工作或独立验证时，使用当前频道的有效成员提出一层计划。只有一个 Agent 时直接完成。仅处理当前任务批准输入，子任务完成后汇总产物和验证结论。遵守 canPlan；本地协调时使用 /workspace/task-plan.json，子任务或已经规划的根任务禁止再委派。面向用户的答复不描述内部协议字段或执行配置。'

export class DefaultAidaService {
  constructor(readonly tasks: TaskService, readonly capacity: (companyId: string) => Promise<{ tier: 'free' | 'pro' | 'max'; maxActiveAgents: number }>) {}

  async identity(actor: TaskPrincipal): Promise<string> {
    return this.tasks.transaction(actor.companyId, async client => {
      const membership = await client.query(`SELECT 1 FROM company_members m JOIN participants p ON p.id=m.user_id AND p.company_id=m.company_id
        WHERE m.company_id=$1 AND m.user_id=$2 AND p.kind='human' AND p.departed_at IS NULL FOR SHARE OF m,p`, [actor.companyId, actor.id])
      if (!membership.rowCount) throw new TaskError('CHANNEL_ACCESS_DENIED', 403)
      const existing = await client.query<{ id: string }>(`SELECT id FROM participants WHERE company_id=$1 AND kind='agent' AND departed_at IS NULL
        AND (creation_request_id LIKE 'channel-default-aida:%' OR lower(name)='aida') ORDER BY (creation_request_id LIKE 'channel-default-aida:%') DESC NULLS LAST,id LIMIT 1 FOR SHARE`, [actor.companyId])
      if (existing.rowCount) return existing.rows[0].id
      const local = await client.query<{ id: string }>(`SELECT id FROM computers WHERE company_id=$1 AND kind<>'cloud' AND revoked_at IS NULL
        AND available_engines ? 'codex' ORDER BY (status='online') DESC,created_at DESC,id LIMIT 1`, [actor.companyId])
      const generation = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM participants WHERE company_id=$1 AND creation_request_id LIKE 'channel-default-aida:%'`, [actor.companyId])
      const limits = await this.capacity(actor.companyId)
      const created = await createAgentRecord({ companyId: actor.companyId, ...limits, name: 'Aida', role: '协调者', systemPrompt: defaultAidaInstructions,
        bio: '群聊默认助手，负责直接执行、协作与最终交付。', requestId: `channel-default-aida:${actor.companyId}:${generation.rows[0].count}`,
        ...(local.rowCount ? { computerId: local.rows[0].id, engine: 'codex', inherit: false } : {}) })
      return created.id
    })
  }

  /** Called inside group creation's transaction; never switches workspace mode. */
  async binding(client: PoolClient, actor: TaskPrincipal, channelId: string, aidaId: string): Promise<string | null> {
    const version = await client.query(`SELECT max(version)::int AS version FROM schema_migrations`)
    if (Number(version.rows[0].version) < 19) return null
    const peers = await client.query<{ id: string; name: string; role: string | null; system_prompt: string | null }>(`SELECT p.id,p.name,p.role,p.system_prompt FROM participants p JOIN conversation_members m ON m.company_id=p.company_id AND m.participant_id=p.id
      WHERE p.company_id=$1 AND m.conversation_id=$2 AND p.kind='agent' AND p.departed_at IS NULL AND p.id<>$3
      AND NOT EXISTS(SELECT 1 FROM channel_agent_bindings b WHERE b.company_id=p.company_id AND b.conversation_id=m.conversation_id AND b.agent_id=p.id AND b.status='ACTIVE') ORDER BY p.id FOR SHARE OF p,m`, [actor.companyId, channelId, aidaId])
    for (const peer of peers.rows) {
      const reusable = await client.query<{ definition_version_id: string }>(`SELECT definition_version_id FROM channel_agent_bindings WHERE company_id=$1 AND agent_id=$2 AND status='ACTIVE' ORDER BY created_at DESC,id LIMIT 1`, [actor.companyId, peer.id])
      let peerDefinition = reusable.rows[0]?.definition_version_id
      if (!peerDefinition) {
        const existingDefinition = await client.query<{ id: string }>(`SELECT id FROM agent_definition_versions WHERE company_id=$1 AND definition_id=$2 ORDER BY version DESC LIMIT 1`, [actor.companyId, `cumora.agent:${peer.id}`])
        peerDefinition = existingDefinition.rows[0]?.id
        if (!peerDefinition) {
          peerDefinition = randomUUID()
          const body = { name: peer.name, role: /verify|验证|test|测试/i.test(`${peer.name} ${peer.role ?? ''}`) ? 'VERIFY' : 'WORK', instructions: peer.system_prompt || `你是 ${peer.name}，仅处理当前任务批准输入并交付产物。` }
          await client.query(`INSERT INTO agent_definition_versions(id,company_id,definition_id,version,body,content_hash,created_by) VALUES($1,$2,$3,1,$4,$5,$6)`, [peerDefinition, actor.companyId, `cumora.agent:${peer.id}`, body, hashContent(JSON.stringify(body)), actor.id])
        }
      }
      await client.query(`INSERT INTO channel_agent_bindings(id,company_id,conversation_id,agent_id,definition_version_id,alias,is_default) VALUES($1,$2,$3,$4,$5,$6,FALSE)`, [randomUUID(), actor.companyId, channelId, peer.id, peerDefinition, peer.name])
    }
    const current = await client.query<{ id: string }>(`SELECT id FROM channel_agent_bindings WHERE company_id=$1 AND conversation_id=$2 AND status='ACTIVE' AND is_default`, [actor.companyId, channelId])
    const existing = await client.query<{ id: string }>(`SELECT id FROM channel_agent_bindings WHERE company_id=$1 AND conversation_id=$2 AND agent_id=$3 AND status='ACTIVE'`, [actor.companyId, channelId, aidaId])
    if (existing.rowCount) {
      if (!current.rowCount) await client.query(`UPDATE channel_agent_bindings SET is_default=TRUE WHERE company_id=$1 AND id=$2`, [actor.companyId, existing.rows[0].id])
      return current.rows[0]?.id ?? existing.rows[0].id
    }
    const definition = await client.query<{ id: string }>(`SELECT id FROM agent_definition_versions WHERE company_id=$1 AND definition_id='cumora.default-aida' ORDER BY version DESC LIMIT 1`, [actor.companyId])
    let definitionId = definition.rows[0]?.id
    if (!definitionId) {
      definitionId = randomUUID()
      const body = { name: 'Aida', role: 'COORDINATOR', instructions: defaultAidaInstructions }
      await client.query(`INSERT INTO agent_definition_versions(id,company_id,definition_id,version,body,content_hash,created_by) VALUES($1,$2,'cumora.default-aida',1,$3,$4,$5)`, [definitionId, actor.companyId, body, hashContent(JSON.stringify(body)), actor.id])
    }
    const id = randomUUID()
    await client.query(`INSERT INTO channel_agent_bindings(id,company_id,conversation_id,agent_id,definition_version_id,alias,is_default) VALUES($1,$2,$3,$4,$5,'Aida',$6)`, [id, actor.companyId, channelId, aidaId, definitionId, !current.rowCount])
    return current.rows[0]?.id ?? id
  }

  async initialize(actor: TaskPrincipal, channelId: string) {
    await this.tasks.transaction(actor.companyId, async client => {
      const channel = await this.tasks.member(client, actor, channelId)
      if (channel.kind !== 'group') throw new TaskError('GROUP_CHANNEL_REQUIRED', 400)
    })
    const aidaId = await this.identity(actor)
    await addConversationMember({ conversationId: channelId, companyId: actor.companyId, actorId: actor.id, memberId: aidaId })
    return this.tasks.transaction(actor.companyId, async client => {
      await this.tasks.member(client, actor, channelId)
      const joined = await client.query(`SELECT 1 FROM conversation_members m JOIN participants p ON p.company_id=m.company_id AND p.id=m.participant_id
        WHERE m.company_id=$1 AND m.conversation_id=$2 AND m.participant_id=$3 AND p.departed_at IS NULL FOR SHARE OF m,p`, [actor.companyId, channelId, aidaId])
      if (!joined.rowCount) throw new TaskError('BINDING_INELIGIBLE', 403)
      const bindingId = await this.binding(client, actor, channelId, aidaId)
      const responsible = bindingId ? (await client.query(`SELECT b.alias,p.name,b.agent_id FROM channel_agent_bindings b JOIN participants p ON p.company_id=b.company_id AND p.id=b.agent_id WHERE b.company_id=$1 AND b.id=$2`, [actor.companyId, bindingId])).rows[0] : null
      return { aidaId, bindingId, defaultName: responsible?.alias ?? 'Aida', defaultAgentId: responsible?.agent_id ?? aidaId }
    })
  }
}
