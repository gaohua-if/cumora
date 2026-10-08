import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import {
  ConfigurationError,
  parseSkill,
  parseDefinition,
  parseBundle,
  parseGroup,
  parseMember,
  resolveConfiguration,
  groupDefaults,
  bundleDefaults,
  type Published,
  type SkillBody,
  type DefinitionBody,
  type BundleBody,
  type GroupConfiguration,
  type MemberConfiguration,
  type WorkbenchData,
  type EffectiveConfiguration,
  type Language,
} from '../../../shared/configuration.js'
import { TaskError, hashContent, canonicalJson } from './contracts.js'
import type { TaskService, TaskPrincipal, BindingRecord } from './service.js'
import { modelCapabilities } from '../model-availability.js'

function fail(code: string, status = 400): never {
  throw new TaskError(code, status)
}
function text(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    fail('INVALID_CONFIGURATION')
  return value
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) fail('INVALID_CONFIGURATION')
  const result = value.map((v) => text(v))
  if (new Set(result).size !== result.length) fail('DUPLICATE_REFERENCE')
  return result
}
function published<T>(row: {
  id: string
  object_id: string
  version: number
  body: T
}): Published<T> {
  return { id: row.id, objectId: row.object_id, version: row.version, body: row.body }
}
export class ConfigurationService {
  constructor(readonly tasks: TaskService) {}
  async revision(client: PoolClient, companyId: string) {
    await client.query(
      `INSERT INTO configuration_workspace_settings(company_id) VALUES($1) ON CONFLICT DO NOTHING`,
      [companyId],
    )
    return (
      await client.query<{ revision: number; language: Language }>(
        `SELECT revision,language FROM configuration_workspace_settings WHERE company_id=$1 FOR UPDATE`,
        [companyId],
      )
    ).rows[0]
  }
  async read(actor: TaskPrincipal): Promise<WorkbenchData> {
    return this.tasks.transaction(actor.companyId, async (client) => {
      await this.tasks.administrator(client, actor)
      const settings = await this.revision(client, actor.companyId)
      const agents = (
        await client.query(
          `SELECT id,name,role,bio,system_prompt,computer_id,engine,creation_request_id FROM participants WHERE company_id=$1 AND kind='agent' AND departed_at IS NULL ORDER BY name,id`,
          [actor.companyId],
        )
      ).rows
      const definitions = (
        await client.query(
          `SELECT id,definition_id AS object_id,version,body FROM agent_definition_versions WHERE company_id=$1 ORDER BY version DESC,created_at DESC,id`,
          [actor.companyId],
        )
      ).rows.map(published<DefinitionBody>)
      const skills = (
        await client.query(
          `SELECT id,skill_id AS object_id,version,body FROM skill_versions WHERE company_id=$1 ORDER BY version DESC,skill_id`,
          [actor.companyId],
        )
      ).rows.map(published<SkillBody>)
      const bundles = (
        await client.query(
          `SELECT id,bundle_id AS object_id,version,body FROM access_bundle_versions WHERE company_id=$1 ORDER BY version DESC,bundle_id`,
          [actor.companyId],
        )
      ).rows.map((row) =>
        published<BundleBody>({
          ...row,
          body: { ...bundleDefaults, name: row.object_id, ...row.body },
        }),
      )
      const channels = (
        await client.query(
          `SELECT c.id,c.title,c.kind,c.task_configuration FROM conversations c JOIN conversation_members m ON m.company_id=c.company_id AND m.conversation_id=c.id WHERE c.company_id=$1 AND m.participant_id=$2 ORDER BY c.title,c.id`,
          [actor.companyId, actor.id],
        )
      ).rows
      const bindings = (
        await client.query(
          `SELECT b.* FROM channel_agent_bindings b JOIN conversation_members m ON m.company_id=b.company_id AND m.conversation_id=b.conversation_id AND m.participant_id=b.agent_id JOIN participants p ON p.company_id=b.company_id AND p.id=b.agent_id WHERE b.company_id=$1 AND b.status='ACTIVE' AND p.departed_at IS NULL ORDER BY b.created_at DESC,b.id`,
          [actor.companyId],
        )
      ).rows
      const members = (
        await client.query(
          `SELECT m.conversation_id,m.participant_id FROM conversation_members m JOIN participants p ON p.company_id=m.company_id AND p.id=m.participant_id WHERE m.company_id=$1 AND p.kind='agent' AND p.departed_at IS NULL`,
          [actor.companyId],
        )
      ).rows
      const refs = (
        await client.query(
          `SELECT conversation_id,bundle_version_id FROM channel_access_refs WHERE company_id=$1 ORDER BY bundle_version_id`,
          [actor.companyId],
        )
      ).rows
      const computers = (
        await client.query(
          `SELECT id,name,status,available_engines FROM computers WHERE company_id=$1 AND kind<>'cloud' AND revoked_at IS NULL ORDER BY name,id`,
          [actor.companyId],
        )
      ).rows
      return {
        runtime: modelCapabilities(),
        revision: settings.revision,
        language: settings.language,
        definitions,
        skills,
        bundles,
        agents: agents.map((a) => {
          const binding = bindings.find((b) => b.agent_id === a.id)
          const def = definitions.find((d) => d.id === binding?.definition_version_id)
          return {
            id: a.id,
            name: a.name,
            role: a.role ?? '',
            description: a.bio ?? '',
            prompt: a.system_prompt ?? '',
            computerId: a.computer_id,
            engine: a.engine,
            definitionId: def?.objectId ?? `cumora.agent:${a.id}`,
            isAida:
              a.creation_request_id?.startsWith('channel-default-aida:') ||
              a.name.toLowerCase() === 'aida',
          }
        }),
        channels: channels.map((c) => ({
          id: c.id,
          title: c.title ?? '私聊',
          kind: c.kind,
          members: members.filter((m) => m.conversation_id === c.id).map((m) => m.participant_id),
          configuration: { ...groupDefaults, ...c.task_configuration },
          bundleVersionIds: refs
            .filter((r) => r.conversation_id === c.id)
            .map((r) => r.bundle_version_id),
          bindings: bindings
            .filter((b) => b.conversation_id === c.id)
            .map((b) => ({
              id: b.id,
              agentId: b.agent_id,
              definitionVersionId: b.definition_version_id,
              alias: b.alias,
              isDefault: b.is_default,
              version: b.version,
              configuration: b.configuration,
            })),
        })),
        computers: computers.map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          engines: c.available_engines ?? [],
        })),
      }
    })
  }
  async skillReferences(client: PoolClient, companyId: string, refs: string[]) {
    if (!refs.length) return
    const result = await client.query(
      `SELECT id,skill_id FROM skill_versions WHERE company_id=$1 AND id=ANY($2::text[]) FOR SHARE`,
      [companyId, refs],
    )
    if (result.rowCount !== refs.length) fail('SKILL_VERSION_NOT_FOUND')
    if (new Set(result.rows.map((r) => r.skill_id)).size !== refs.length)
      fail('DUPLICATE_SKILL_REFERENCE')
  }
  async bundleReferences(client: PoolClient, companyId: string, refs: string[]) {
    const result = await client.query(
      `SELECT id,bundle_id FROM access_bundle_versions WHERE company_id=$1 AND id=ANY($2::text[]) FOR SHARE`,
      [companyId, refs],
    )
    if (result.rowCount !== refs.length) fail('BUNDLE_VERSION_NOT_FOUND')
    if (new Set(result.rows.map((r) => r.bundle_id)).size !== refs.length)
      fail('DUPLICATE_BUNDLE_REFERENCE')
    return result.rows
  }
  async mutate(
    actor: TaskPrincipal,
    input: Record<string, unknown>,
  ): Promise<{ revision: number; id?: string }> {
    try {
      return await this.tasks.transaction(actor.companyId, async (client) => {
        await this.tasks.administrator(client, actor)
        const settings = await this.revision(client, actor.companyId)
        if (!Number.isInteger(input.revision) || input.revision !== settings.revision)
          fail('CONFIGURATION_REVISION_CONFLICT', 409)
        let id: string | undefined
        if (
          input.action === 'publish-skill' ||
          input.action === 'publish-definition' ||
          input.action === 'publish-bundle'
        ) {
          const objectId = text(input.objectId)
          const kind = input.action
          const body =
            kind === 'publish-skill'
              ? parseSkill(input.body)
              : kind === 'publish-definition'
                ? parseDefinition(input.body)
                : parseBundle(input.body)
          if (kind === 'publish-definition')
            await this.skillReferences(
              client,
              actor.companyId,
              (body as DefinitionBody).skills ?? [],
            )
          const table =
            kind === 'publish-skill'
              ? 'skill_versions'
              : kind === 'publish-definition'
                ? 'agent_definition_versions'
                : 'access_bundle_versions'
          const key =
            kind === 'publish-skill'
              ? 'skill_id'
              : kind === 'publish-definition'
                ? 'definition_id'
                : 'bundle_id'
          const next = (
            await client.query(
              `SELECT COALESCE(MAX(version),0)+1 AS version FROM ${table} WHERE company_id=$1 AND ${key}=$2`,
              [actor.companyId, objectId],
            )
          ).rows[0].version
          id = randomUUID()
          if (kind === 'publish-bundle')
            await client.query(
              `INSERT INTO access_bundle_versions(id,company_id,bundle_id,version,grant_ids,created_by,body) VALUES($1,$2,$3,$4,'[]',$5,$6)`,
              [id, actor.companyId, objectId, next, actor.id, body],
            )
          else
            await client.query(
              `INSERT INTO ${table}(id,company_id,${key},version,body,content_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,
              [
                id,
                actor.companyId,
                objectId,
                next,
                body,
                hashContent(canonicalJson(body)),
                actor.id,
              ],
            )
        } else if (input.action === 'save-workspace') {
          if (!['zh-CN', 'en'].includes(String(input.language))) fail('INVALID_LANGUAGE')
          await client.query(
            `UPDATE configuration_workspace_settings SET language=$2 WHERE company_id=$1`,
            [actor.companyId, input.language],
          )
        } else if (input.action === 'save-channel') {
          const channelId = text(input.channelId),
            title = text(input.title),
            config = parseGroup(input.configuration),
            refs = ids(input.bundleVersionIds)
          await this.tasks.member(client, actor, channelId)
          const resources = await this.bundleReferences(client, actor.companyId, refs)
          await client.query(
            `UPDATE conversations SET title=$3,task_configuration=$4 WHERE company_id=$1 AND id=$2`,
            [actor.companyId, channelId, title, config],
          )
          await client.query(
            `DELETE FROM channel_access_refs WHERE company_id=$1 AND conversation_id=$2`,
            [actor.companyId, channelId],
          )
          for (const ref of refs)
            await client.query(
              `INSERT INTO channel_access_refs(company_id,conversation_id,bundle_version_id) VALUES($1,$2,$3)`,
              [actor.companyId, channelId, ref],
            )
          // Prune only selected IDs. Never reinterpret empty subset as all.
          await client.query(
            `UPDATE channel_agent_bindings SET configuration=jsonb_set(configuration,'{bundleIds}',COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements_text(COALESCE(configuration->'bundleIds','[]')) x WHERE x=ANY($3::text[])),'[]')),version=version+1 WHERE company_id=$1 AND conversation_id=$2 AND status='ACTIVE' AND configuration->>'accessMode'='subset' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(configuration->'bundleIds','[]')) x WHERE NOT(x=ANY($3::text[])))`,
            [actor.companyId, channelId, resources.map((r) => r.bundle_id)],
          )
        } else if (input.action === 'save-binding') {
          const channelId = text(input.channelId),
            agentId = text(input.agentId),
            definitionVersionId = text(input.definitionVersionId),
            alias = text(input.alias, 120),
            configuration = parseMember(input.configuration)
          if (typeof input.isDefault !== 'boolean') fail('INVALID_BINDING')
          await this.tasks.member(client, actor, channelId)
          const eligible = await client.query(
            `SELECT 1 FROM conversation_members m JOIN participants p ON p.id=m.participant_id AND p.company_id=m.company_id WHERE m.company_id=$1 AND m.conversation_id=$2 AND m.participant_id=$3 AND p.kind='agent' AND p.departed_at IS NULL FOR SHARE OF m,p`,
            [actor.companyId, channelId, agentId],
          )
          if (!eligible.rowCount) fail('BINDING_INELIGIBLE', 403)
          const def = (
            await client.query(
              `SELECT body FROM agent_definition_versions WHERE company_id=$1 AND id=$2 FOR SHARE`,
              [actor.companyId, definitionVersionId],
            )
          ).rows[0]
          if (!def) fail('DEFINITION_VERSION_NOT_FOUND')
          await this.skillReferences(client, actor.companyId, configuration.skills ?? [])
          const validBundles = (
            await client.query(
              `SELECT b.bundle_id FROM channel_access_refs r JOIN access_bundle_versions b ON b.company_id=r.company_id AND b.id=r.bundle_version_id WHERE r.company_id=$1 AND r.conversation_id=$2`,
              [actor.companyId, channelId],
            )
          ).rows.map((r) => r.bundle_id)
          if ((configuration.bundleIds ?? []).some((id) => !validBundles.includes(id)))
            fail('BUNDLE_NOT_REFERENCED')
          if ((configuration.disabledSkills ?? []).length) {
            const base = (
              await client.query(
                `SELECT skill_id FROM skill_versions WHERE company_id=$1 AND id=ANY($2::text[])`,
                [actor.companyId, def.body.skills ?? []],
              )
            ).rows.map((r) => r.skill_id)
            if (configuration.disabledSkills!.some((id) => !base.includes(id)))
              fail('SKILL_NOT_INHERITED')
          }
          const existing = (
            await client.query(
              `SELECT id,definition_version_id,alias,is_default,configuration FROM channel_agent_bindings WHERE company_id=$1 AND conversation_id=$2 AND agent_id=$3 AND status='ACTIVE' FOR UPDATE`,
              [actor.companyId, channelId, agentId],
            )
          ).rows[0]
          if (
            existing?.is_default &&
            !input.isDefault &&
            !(
              await client.query(
                `SELECT 1 FROM channel_agent_bindings WHERE company_id=$1 AND conversation_id=$2 AND status='ACTIVE' AND is_default AND id<>$3`,
                [actor.companyId, channelId, existing.id],
              )
            ).rowCount
          )
            fail('DEFAULT_BINDING_REQUIRED')
          if (input.isDefault)
            await client.query(
              `UPDATE channel_agent_bindings SET is_default=FALSE WHERE company_id=$1 AND conversation_id=$2 AND status='ACTIVE' AND is_default AND agent_id<>$3`,
              [actor.companyId, channelId, agentId],
            )
          id = existing?.id ?? randomUUID()
          if (!existing)
            await client.query(
              `INSERT INTO channel_agent_bindings(id,company_id,conversation_id,agent_id,definition_version_id,alias,is_default,configuration) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
              [
                id,
                actor.companyId,
                channelId,
                agentId,
                definitionVersionId,
                alias,
                input.isDefault,
                configuration,
              ],
            )
          else if (
            existing.definition_version_id !== definitionVersionId ||
            existing.alias !== alias ||
            existing.is_default !== input.isDefault ||
            canonicalJson(existing.configuration) !== canonicalJson(configuration)
          )
            await client.query(
              `UPDATE channel_agent_bindings SET definition_version_id=$3,alias=$4,is_default=$5,configuration=$6,version=version+1 WHERE company_id=$1 AND id=$2`,
              [actor.companyId, id, definitionVersionId, alias, input.isDefault, configuration],
            )
        } else fail('INVALID_CONFIGURATION_ACTION')
        const updated = (
          await client.query(
            `UPDATE configuration_workspace_settings SET revision=revision+1 WHERE company_id=$1 RETURNING revision`,
            [actor.companyId],
          )
        ).rows[0]
        return { revision: updated.revision, ...(id ? { id } : {}) }
      })
    } catch (error) {
      if (error instanceof ConfigurationError) fail(error.message)
      throw error
    }
  }
  async resolve(
    client: PoolClient,
    companyId: string,
    binding: BindingRecord,
    overrides?: {
      group?: GroupConfiguration
      member?: MemberConfiguration
      bundleVersionIds?: string[]
    },
  ): Promise<EffectiveConfiguration> {
    const group = (
      await client.query(
        `SELECT task_configuration FROM conversations WHERE company_id=$1 AND id=$2 FOR SHARE`,
        [companyId, binding.conversation_id],
      )
    ).rows[0]
    const workspace = (
      await client.query(
        `SELECT language FROM configuration_workspace_settings WHERE company_id=$1`,
        [companyId],
      )
    ).rows[0]
    const def = (
      await client.query(
        `SELECT id,definition_id AS object_id,version,body FROM agent_definition_versions WHERE company_id=$1 AND id=$2`,
        [companyId, binding.definition_version_id],
      )
    ).rows[0]
    const refs =
      overrides?.bundleVersionIds ??
      (
        await client.query(
          `SELECT bundle_version_id FROM channel_access_refs WHERE company_id=$1 AND conversation_id=$2`,
          [companyId, binding.conversation_id],
        )
      ).rows.map((r) => r.bundle_version_id)
    await this.bundleReferences(client, companyId, refs)
    const bundles = (
      await client.query(
        `SELECT id,bundle_id AS object_id,version,body FROM access_bundle_versions WHERE company_id=$1 AND id=ANY($2::text[])`,
        [companyId, refs],
      )
    ).rows.map((r) =>
      published<BundleBody>({ ...r, body: { ...bundleDefaults, name: r.object_id, ...r.body } }),
    )
    const member = overrides?.member ?? (binding.configuration as MemberConfiguration)
    const skillIds = [...new Set([...(def.body.skills ?? []), ...(member.skills ?? [])])]
    const skills = (
      await client.query(
        `SELECT id,skill_id AS object_id,version,body FROM skill_versions WHERE company_id=$1 AND id=ANY($2::text[])`,
        [companyId, skillIds],
      )
    ).rows.map(published<SkillBody>)
    return resolveConfiguration({
      definition: published<DefinitionBody>(def),
      binding: member,
      group: overrides?.group ?? { ...groupDefaults, ...group.task_configuration },
      workspaceLanguage: workspace?.language ?? 'zh-CN',
      skills,
      bundles,
    })
  }
  async preview(actor: TaskPrincipal, input: Record<string, unknown>) {
    try {
      return await this.tasks.transaction(actor.companyId, async (client) => {
        await this.tasks.administrator(client, actor)
        const channelId = text(input.channelId)
        await this.tasks.member(client, actor, channelId)
        const binding = await this.tasks.binding(
          client,
          actor.companyId,
          channelId,
          input.bindingId === undefined ? undefined : text(input.bindingId),
        )
        return this.resolve(client, actor.companyId, binding, {
          group: input.group === undefined ? undefined : parseGroup(input.group),
          member: input.member === undefined ? undefined : parseMember(input.member),
          bundleVersionIds:
            input.bundleVersionIds === undefined ? undefined : ids(input.bundleVersionIds),
        })
      })
    } catch (error) {
      if (error instanceof ConfigurationError) fail(error.message)
      throw error
    }
  }
  async snapshot(
    client: PoolClient,
    companyId: string,
    binding: BindingRecord,
  ): Promise<Record<string, unknown>> {
    // Version 14-19 deployments retain their existing configuration contract until migrated.
    const schema = (
      await client.query(`SELECT MAX(version)::int AS version FROM schema_migrations`)
    ).rows[0].version
    if (schema < 20)
      return {
        instructions: binding.configuration.instructions ?? binding.definition.instructions ?? '',
        role: binding.definition.role ?? null,
      }
    const effective = await this.resolve(client, companyId, binding)
    const group = (await client.query<{ task_configuration: Record<string, unknown> }>(
      `SELECT task_configuration FROM conversations WHERE company_id=$1 AND id=$2`,
      [companyId, binding.conversation_id],
    )).rows[0]?.task_configuration ?? {}
    // Existing three-field definitions retain their original override semantics
    // until a workbench layer is explicitly configured.
    const configured =
      Object.keys(group).length > 0 ||
      Object.keys(binding.definition).some(
        (key) => !['name', 'role', 'instructions'].includes(key),
      ) ||
      Object.keys(binding.configuration).some((key) => key !== 'instructions') ||
      effective.settings.rules ||
      effective.settings.language !== 'inherit' ||
      effective.resources.length ||
      effective.bundles.some((b) => b.body.instructions) ||
      effective.language.value !== '中文'
    if (!configured)
      return {
        instructions: binding.configuration.instructions ?? binding.definition.instructions ?? '',
        role: binding.definition.role ?? null,
      }
    return { instructions: effective.instructions, role: effective.role, workbench: effective }
  }
}
