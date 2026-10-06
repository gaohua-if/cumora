export type Language = 'inherit' | 'zh-CN' | 'en'
export type AccessMode = 'all' | 'subset' | 'none'
export interface Published<T> {
  id: string
  objectId: string
  version: number
  body: T
}
export interface SkillBody {
  name: string
  slug: string
  description: string
  content: string
}
export interface DefinitionBody {
  name: string
  role: string
  instructions: string
  description?: string
  skills?: string[]
  language?: Language
  model?: string
}
export interface McpResource {
  id: string
  name: string
  url: string
  identity: string
  tools: string[]
  enabled: boolean
}
export interface DomainResource {
  id: string
  host: string
  port: number
  purpose: string
  enabled: boolean
}
export interface GithubResource {
  id: string
  repo: string
  branch: string
  path: string
  identity: string
  actions: string[]
  enabled: boolean
}
export interface BundleBody {
  name: string
  description: string
  identity: string
  instructions: string
  mcp: McpResource[]
  domains: DomainResource[]
  github: GithubResource[]
}
export interface GroupConfiguration {
  rules: string
  language: Language
  model: string
  format: string
  response: string
  parallelism: number
  memory: string
}
export interface MemberConfiguration {
  instructions?: string
  language?: Language
  model?: string
  skills?: string[]
  disabledSkills?: string[]
  accessMode?: AccessMode
  bundleIds?: string[]
}
export interface WorkbenchBinding {
  id: string
  agentId: string
  definitionVersionId: string
  alias: string
  isDefault: boolean
  version: number
  configuration: MemberConfiguration
}
export interface WorkbenchChannel {
  id: string
  title: string
  kind: string
  members: string[]
  configuration: GroupConfiguration
  bundleVersionIds: string[]
  bindings: WorkbenchBinding[]
}
export interface WorkbenchAgent {
  id: string
  name: string
  role: string
  description: string
  prompt: string
  computerId: string | null
  engine: string | null
  definitionId: string
  isAida: boolean
}
export interface WorkbenchData {
  revision: number
  language: Language
  agents: WorkbenchAgent[]
  definitions: Published<DefinitionBody>[]
  skills: Published<SkillBody>[]
  bundles: Published<BundleBody>[]
  channels: WorkbenchChannel[]
  computers: { id: string; name: string; status: string; engines: string[] }[]
}
export interface ResolvedResource {
  type: 'mcp' | 'domains' | 'github'
  name: string
  bundleVersionId: string
  bundleName: string
  bundleVersion: number
  identity: string
  identitySource: string
  readiness: 'UNQUALIFIED'
  scope: Record<string, unknown>
}
export interface EffectiveConfiguration {
  definitionVersionId: string
  language: { value: string; source: string }
  skills: Published<SkillBody>[]
  bundles: Published<BundleBody>[]
  resources: ResolvedResource[]
  sources: { source: string; content: string }[]
  instructions: string
  role: string
  settings: GroupConfiguration
  model: string
}

export const groupDefaults: GroupConfiguration = {
  rules: '',
  language: 'inherit',
  model: 'inherit',
  format: '结论 + 依据',
  response: 'Aida 默认响应',
  parallelism: 2,
  memory: '仅当前群聊',
}
export const bundleDefaults: BundleBody = {
  name: '',
  description: '',
  identity: 'Cumora 服务账号',
  instructions: '',
  mcp: [],
  domains: [],
  github: [],
}
export const languageLabels: Record<Language, string> = {
  inherit: '继承默认',
  'zh-CN': '中文',
  en: 'English',
}

export class ConfigurationError extends Error {}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ConfigurationError('INVALID_CONFIGURATION')
  return value as Record<string, unknown>
}
function allowed(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((k) => !keys.includes(k)))
    throw new ConfigurationError('INVALID_CONFIGURATION_FIELD')
}
function str(value: unknown, max = 200, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()))
    throw new ConfigurationError('INVALID_CONFIGURATION_TEXT')
  return value
}
function list(value: unknown, max = 64): string[] {
  if (!Array.isArray(value) || value.length > max)
    throw new ConfigurationError('INVALID_CONFIGURATION_LIST')
  const result = value.map((v) => str(v))
  if (new Set(result).size !== result.length) throw new ConfigurationError('DUPLICATE_REFERENCE')
  return result
}
function language(value: unknown): Language {
  if (!['inherit', 'zh-CN', 'en'].includes(String(value)))
    throw new ConfigurationError('INVALID_LANGUAGE')
  return value as Language
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ConfigurationError('INVALID_CONFIGURATION_BOOLEAN')
  return value
}

export function parseSkill(value: unknown): SkillBody {
  const v = object(value)
  allowed(v, ['name', 'slug', 'description', 'content'])
  const slug = str(v.slug, 120)
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) throw new ConfigurationError('INVALID_SKILL_SLUG')
  return {
    name: str(v.name),
    slug,
    description: str(v.description, 2000, true),
    content: str(v.content, 100000),
  }
}
export function parseDefinition(value: unknown): DefinitionBody {
  const v = object(value)
  allowed(v, ['name', 'role', 'instructions', 'description', 'skills', 'language', 'model'])
  if (!['COORDINATOR', 'WORK', 'VERIFY'].includes(String(v.role)))
    throw new ConfigurationError('INVALID_AGENT_ROLE')
  return {
    name: str(v.name),
    role: str(v.role),
    instructions: str(v.instructions, 12000),
    description: str(v.description ?? '', 2000, true),
    skills: list(v.skills ?? []),
    language: language(v.language ?? 'inherit'),
    model: str(v.model ?? 'inherit', 200),
  }
}
export function parseGroup(value: unknown): GroupConfiguration {
  const v = object(value)
  allowed(v, Object.keys(groupDefaults))
  if (!Number.isInteger(v.parallelism) || Number(v.parallelism) < 1 || Number(v.parallelism) > 4)
    throw new ConfigurationError('INVALID_PARALLELISM')
  return {
    rules: str(v.rules, 12000, true),
    language: language(v.language),
    model: str(v.model),
    format: str(v.format),
    response: str(v.response),
    parallelism: Number(v.parallelism),
    memory: str(v.memory),
  }
}
export function parseMember(value: unknown): MemberConfiguration {
  const v = object(value)
  allowed(v, [
    'instructions',
    'language',
    'model',
    'skills',
    'disabledSkills',
    'accessMode',
    'bundleIds',
  ])
  if (!['all', 'subset', 'none'].includes(String(v.accessMode ?? 'all')))
    throw new ConfigurationError('INVALID_ACCESS_MODE')
  return {
    instructions: str(v.instructions ?? '', 12000, true),
    language: language(v.language ?? 'inherit'),
    model: str(v.model ?? 'inherit'),
    skills: list(v.skills ?? []),
    disabledSkills: list(v.disabledSkills ?? []),
    accessMode: (v.accessMode ?? 'all') as AccessMode,
    bundleIds: list(v.bundleIds ?? []),
  }
}
export function parseBundle(value: unknown): BundleBody {
  const v = object(value)
  allowed(v, ['name', 'description', 'identity', 'instructions', 'mcp', 'domains', 'github'])
  const rows = (key: string) => {
    const items = v[key]
    if (!Array.isArray(items) || items.length > 64)
      throw new ConfigurationError('INVALID_RESOURCES')
    return items.map(object)
  }
  const result: BundleBody = {
    name: str(v.name),
    description: str(v.description, 2000, true),
    identity: str(v.identity),
    instructions: str(v.instructions, 12000, true),
    mcp: [],
    domains: [],
    github: [],
  }
  result.mcp = rows('mcp').map((r) => {
    allowed(r, ['id', 'name', 'url', 'identity', 'tools', 'enabled'])
    const url = str(r.url, 2000)
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw 0
    } catch {
      throw new ConfigurationError('INVALID_MCP_URL')
    }
    const tools = list(r.tools)
    if (!tools.length) throw new ConfigurationError('MCP_TOOLS_REQUIRED')
    return {
      id: str(r.id),
      name: str(r.name),
      url,
      identity: str(r.identity, 200, true),
      tools,
      enabled: bool(r.enabled),
    }
  })
  result.domains = rows('domains').map((r) => {
    allowed(r, ['id', 'host', 'port', 'purpose', 'enabled'])
    const host = str(r.host)
    if (
      !/^(\*\.)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/i.test(host) ||
      !Number.isInteger(r.port) ||
      Number(r.port) < 1 ||
      Number(r.port) > 65535
    )
      throw new ConfigurationError('INVALID_DOMAIN')
    return {
      id: str(r.id),
      host,
      port: Number(r.port),
      purpose: str(r.purpose, 2000, true),
      enabled: bool(r.enabled),
    }
  })
  result.github = rows('github').map((r) => {
    allowed(r, ['id', 'repo', 'branch', 'path', 'identity', 'actions', 'enabled'])
    const repo = str(r.repo),
      path = str(r.path, 2000),
      actions = list(r.actions)
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
      !path.startsWith('/') ||
      !actions.length ||
      actions.some((a) => !['读取代码', '创建分支', '创建 PR', '评论 Issue', '合并 PR'].includes(a))
    )
      throw new ConfigurationError('INVALID_GITHUB_SCOPE')
    return {
      id: str(r.id),
      repo,
      branch: str(r.branch),
      path,
      identity: str(r.identity, 200, true),
      actions,
      enabled: bool(r.enabled),
    }
  })
  const ids = [...result.mcp, ...result.domains, ...result.github].map((r) => r.id)
  if (new Set(ids).size !== ids.length) throw new ConfigurationError('DUPLICATE_RESOURCE')
  return result
}

export function resolveConfiguration(input: {
  definition: Published<DefinitionBody>
  binding: MemberConfiguration
  group: GroupConfiguration
  workspaceLanguage: Language
  skills: Published<SkillBody>[]
  bundles: Published<BundleBody>[]
}): EffectiveConfiguration {
  const { definition, binding, group } = input
  const choices = [
    [binding.language, '群内 Agent 设置'],
    [group.language, '群聊'],
    [definition.body.language, 'Agent 默认'],
    [input.workspaceLanguage, '工作区默认'],
  ] as const
  const choice = choices.find(([v]) => v && v !== 'inherit')
  const resolvedLanguage = {
    value: languageLabels[(choice?.[0] ?? 'zh-CN') as Language],
    source: choice?.[1] ?? '产品默认',
  }
  const byId = new Map(input.skills.map((s) => [s.id, s]))
  const selected = new Map<string, Published<SkillBody>>()
  for (const id of definition.body.skills ?? []) {
    const s = byId.get(id)
    if (!s) throw new ConfigurationError('SKILL_VERSION_NOT_FOUND')
    if (!(binding.disabledSkills ?? []).includes(s.objectId)) selected.set(s.objectId, s)
  }
  for (const id of binding.skills ?? []) {
    const s = byId.get(id)
    if (!s) throw new ConfigurationError('SKILL_VERSION_NOT_FOUND')
    selected.set(s.objectId, s)
  }
  const bundles =
    binding.accessMode === 'none'
      ? []
      : binding.accessMode === 'subset'
        ? input.bundles.filter((b) => (binding.bundleIds ?? []).includes(b.objectId))
        : input.bundles
  const resources: ResolvedResource[] = bundles.flatMap((b) => {
    const base = {
      bundleVersionId: b.id,
      bundleName: b.body.name,
      bundleVersion: b.version,
      readiness: 'UNQUALIFIED' as const,
    }
    const identity = (value: string) => ({
      identity: value || b.body.identity,
      identitySource: value ? '连接显式指定' : 'Bundle 默认',
    })
    return [
      ...b.body.mcp
        .filter((r) => r.enabled)
        .map((r) => ({
          ...base,
          ...identity(r.identity),
          type: 'mcp' as const,
          name: r.name,
          scope: { url: r.url, tools: r.tools },
        })),
      ...b.body.domains
        .filter((r) => r.enabled)
        .map((r) => ({
          ...base,
          type: 'domains' as const,
          name: r.host,
          identity: '不附带登录凭证',
          identitySource: '域名访问',
          scope: { host: r.host, port: r.port, purpose: r.purpose },
        })),
      ...b.body.github
        .filter((r) => r.enabled)
        .map((r) => ({
          ...base,
          ...identity(r.identity),
          type: 'github' as const,
          name: r.repo,
          scope: { repo: r.repo, branch: r.branch, path: r.path, actions: r.actions },
        })),
    ]
  })
  const skills = [...selected.values()]
  const sources = [
    { source: `Agent v${definition.version}`, content: definition.body.instructions },
    { source: '群聊共同规则', content: group.rules },
    ...bundles.map((b) => ({
      source: `${b.body.name} v${b.version}`,
      content: b.body.instructions,
    })),
    { source: '成员补充要求', content: binding.instructions ?? '' },
    ...skills.map((s) => ({
      source: `Skill ${s.body.name} v${s.version}`,
      content: s.body.content,
    })),
    {
      source: `语言（${resolvedLanguage.source}）`,
      content: `回复语言：${resolvedLanguage.value}`,
    },
    {
      source: '群聊工作偏好',
      content: `输出结构：${group.format}\n记忆范围：${group.memory}\n响应方式：${group.response}\n最多并行 Agent：${group.parallelism}`,
    },
  ]
  return {
    definitionVersionId: definition.id,
    language: resolvedLanguage,
    skills,
    bundles,
    resources,
    sources,
    instructions: sources
      .filter((s) => s.content)
      .map((s) => `## ${s.source}\n${s.content}`)
      .join('\n\n'),
    role: definition.body.role,
    settings: group,
    model:
      binding.model && binding.model !== 'inherit'
        ? binding.model
        : group.model !== 'inherit'
          ? group.model
          : (definition.body.model ?? 'inherit'),
  }
}
