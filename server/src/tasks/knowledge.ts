import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { TaskError, hashContent, parseProvenance, type Provenance } from './contracts.js'
import { TaskService, type TaskPrincipal, type TaskRecord } from './service.js'

export class TaskKnowledgeService {
  constructor(readonly tasks: TaskService) {}

  async candidate(principal: TaskPrincipal, input: { artifactVersionId: string; body: string; ownerKind: 'CHANNEL' | 'AGENT' }): Promise<string> {
    if (!input.body?.trim() || input.body.length > 12000) throw new TaskError('INVALID_KNOWLEDGE', 400)
    return this.tasks.transaction(principal.companyId, async (client) => {
      const artifact = await client.query(`SELECT a.*,b.agent_id FROM artifact_versions a JOIN channel_agent_bindings b ON b.id=a.producer_binding_id AND b.company_id=a.company_id
        WHERE a.company_id=$1 AND a.id=$2`, [principal.companyId, input.artifactVersionId])
      if (!artifact.rows[0]) throw new TaskError('ARTIFACT_NOT_FOUND', 404)
      const row = artifact.rows[0]
      const task = await this.tasks.task(client, principal, row.task_id, 'knowledge')
      const p = parseProvenance(row.provenance)
      await this.tasks.liveSources(client, p, task, 'artifact')
      const id = randomUUID()
      const provenance: Provenance = { ...p, sources: [{ kind: 'ARTIFACT', id: row.id, version: 1 }] }
      await client.query(`INSERT INTO knowledge_entries(id,company_id,owner_kind,owner_id,body,content_hash,provenance,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, principal.companyId, input.ownerKind, input.ownerKind === 'CHANNEL' ? task.conversation_id : row.agent_id, input.body, hashContent(input.body), provenance, principal.id])
      return id
    })
  }

  async confirm(principal: TaskPrincipal, knowledgeId: string): Promise<void> {
    await this.tasks.transaction(principal.companyId, async (client) => {
      const found = await client.query(`SELECT * FROM knowledge_entries WHERE company_id=$1 AND id=$2 FOR UPDATE`, [principal.companyId, knowledgeId])
      const entry = found.rows[0]
      if (!entry || entry.created_by !== principal.id || entry.state !== 'CANDIDATE') throw new TaskError('KNOWLEDGE_CONFIRM_DENIED', 403)
      const p = parseProvenance(entry.provenance)
      await this.tasks.member(client, principal, p.conversationId)
      const artifact = await client.query(`SELECT t.* FROM artifact_versions a JOIN channel_tasks t ON t.id=a.task_id AND t.company_id=a.company_id WHERE a.company_id=$1 AND a.id=$2`, [principal.companyId, p.sources[0].id])
      if (!artifact.rows[0]) throw new TaskError('SOURCE_UNKNOWN', 403)
      await this.tasks.liveSources(client, p, artifact.rows[0], 'task-model')
      await client.query(`UPDATE knowledge_entries SET state='CONFIRMED' WHERE company_id=$1 AND id=$2`, [principal.companyId, knowledgeId])
    })
  }

  async invalidate(principal: TaskPrincipal, id: string): Promise<void> {
    await this.tasks.transaction(principal.companyId, async (client) => {
      const entry = await client.query(`SELECT created_by FROM knowledge_entries WHERE company_id=$1 AND id=$2 FOR UPDATE`, [principal.companyId, id])
      if (entry.rows[0]?.created_by !== principal.id) throw new TaskError('KNOWLEDGE_INVALIDATION_DENIED', 403)
      await client.query(`UPDATE knowledge_entries SET state='INVALIDATED' WHERE company_id=$1 AND id=$2`, [principal.companyId, id])
      await client.query(`UPDATE knowledge_publications SET revoked_at=NOW() WHERE company_id=$1 AND knowledge_id=$2`, [principal.companyId, id])
    })
  }

  async retrieve(task: TaskRecord, agentId: string, destination = 'task-model', existingClient?: PoolClient): Promise<{ id: string; body: string; version: number; provenance: Provenance }[]> {
    const run = async (client: PoolClient) => {
      await this.tasks.member(client, { companyId: task.company_id, id: task.creator_principal_id }, task.conversation_id)
      const rows = await client.query(`SELECT * FROM knowledge_entries k WHERE company_id=$1 AND state='CONFIRMED'
        AND ((owner_kind='CHANNEL' AND owner_id=$2) OR (owner_kind='AGENT' AND owner_id=$3) OR EXISTS(
          SELECT 1 FROM knowledge_publications p WHERE p.company_id=k.company_id AND p.knowledge_id=k.id AND p.knowledge_version=k.version AND p.target_conversation_id=$2 AND p.revoked_at IS NULL))
        ORDER BY pinned DESC,created_at DESC,id LIMIT 40`, [task.company_id, task.conversation_id, agentId])
      const visible: { id: string; body: string; version: number; provenance: Provenance }[] = []
      for (const row of rows.rows) {
        try {
          let p = parseProvenance(row.provenance)
          if (p.conversationId !== task.conversation_id) {
            const channel = await this.tasks.member(client, { companyId: task.company_id, id: task.creator_principal_id }, task.conversation_id)
            p = { ...p, conversationId: task.conversation_id, audience: channel.audience, sources: [{ kind: 'KNOWLEDGE', id: row.id, version: row.version }] }
          }
          await this.tasks.liveSources(client, p, task, destination)
          if (hashContent(row.body) !== row.content_hash) throw new TaskError('KNOWLEDGE_HASH_MISMATCH', 403)
          visible.push({ id: row.id, body: row.body, version: row.version, provenance: p })
        } catch (error) { if (!(error instanceof TaskError)) throw error }
      }
      return visible
    }
    return existingClient ? run(existingClient) : this.tasks.transaction(task.company_id, run)
  }

  async publish(principal: TaskPrincipal, id: string, targetChannelId: string, authorityGrantIds: string[]): Promise<string> {
    return this.tasks.transaction(principal.companyId, async (client) => {
      const result = await client.query(`SELECT * FROM knowledge_entries WHERE company_id=$1 AND id=$2 AND state='CONFIRMED' FOR UPDATE`, [principal.companyId, id])
      const entry = result.rows[0]
      if (!entry || entry.created_by !== principal.id) throw new TaskError('KNOWLEDGE_PUBLICATION_DENIED', 403)
      const p = parseProvenance(entry.provenance)
      await this.tasks.member(client, principal, p.conversationId)
      const target = await this.tasks.member(client, principal, targetChannelId)
      const artifact = await client.query(`SELECT t.* FROM artifact_versions a JOIN channel_tasks t ON t.id=a.task_id AND t.company_id=a.company_id WHERE a.company_id=$1 AND a.id=$2`, [principal.companyId, p.sources[0].id])
      if (!artifact.rows[0]) throw new TaskError('SOURCE_UNKNOWN', 403)
      await this.tasks.liveSources(client, p, artifact.rows[0], 'channel')
      const authority = p.conversationId !== targetChannelId || p.audience.kind !== target.audience.kind || p.audience.id !== target.audience.id
        ? await this.tasks.disclosureAuthority(client, principal, p, targetChannelId) : []
      const publicationId = randomUUID()
      await client.query(`INSERT INTO knowledge_publications(id,company_id,knowledge_id,knowledge_version,target_conversation_id,published_by,authority_refs)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(company_id,knowledge_id,knowledge_version,target_conversation_id) DO NOTHING`,
        [publicationId, principal.companyId, id, entry.version, targetChannelId, principal.id, JSON.stringify(authority)])
      return (await client.query<{ id: string }>(`SELECT id FROM knowledge_publications WHERE company_id=$1 AND knowledge_id=$2 AND knowledge_version=$3 AND target_conversation_id=$4`, [principal.companyId, id, entry.version, targetChannelId])).rows[0].id
    })
  }
}
