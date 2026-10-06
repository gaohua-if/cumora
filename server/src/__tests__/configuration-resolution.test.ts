import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveConfiguration,
  parseBundle,
  parseMember,
  groupDefaults,
  bundleDefaults,
  type BundleBody,
  type Published,
} from '../../../shared/configuration.js'

const definition = {
  id: 'definition-1',
  objectId: 'bram',
  version: 1,
  body: {
    name: 'Bram',
    role: 'WORK',
    instructions: 'old instructions',
    language: 'en' as const,
    skills: ['skill-v1'],
  },
}
const skills = [
  {
    id: 'skill-v1',
    objectId: 'coding',
    version: 1,
    body: { name: '编码', slug: 'coding', description: '', content: 'old skill' },
  },
  {
    id: 'skill-v2',
    objectId: 'coding',
    version: 2,
    body: { name: '编码', slug: 'coding', description: '', content: 'new skill' },
  },
]
const bundle: Published<BundleBody> = {
  id: 'bundle-v1',
  objectId: 'engineering',
  version: 1,
  body: {
    ...bundleDefaults,
    name: '工程开发',
    identity: '项目账号',
    mcp: [
      {
        id: 'm',
        name: 'MCP',
        url: 'https://example.com/mcp',
        identity: '服务账号',
        tools: ['fetch'],
        enabled: true,
      },
    ],
    domains: [{ id: 'd', host: 'example.com', port: 443, purpose: '', enabled: true }],
    github: [
      {
        id: 'g',
        repo: 'owner/repo',
        branch: 'main',
        path: '/src/**',
        identity: '',
        actions: ['读取代码'],
        enabled: true,
      },
    ],
  },
}
const base = {
  definition,
  skills,
  bundles: [bundle],
  binding: {},
  group: { ...groupDefaults, language: 'zh-CN' as const },
  workspaceLanguage: 'zh-CN' as const,
}

test('empty subset and none do not inherit available resources', () => {
  assert.equal(
    resolveConfiguration({ ...base, binding: { accessMode: 'subset', bundleIds: [] } }).resources
      .length,
    0,
  )
  assert.equal(
    resolveConfiguration({ ...base, binding: { accessMode: 'subset', bundleIds: ['removed'] } })
      .resources.length,
    0,
  )
  assert.equal(
    resolveConfiguration({ ...base, binding: { accessMode: 'none' } }).resources.length,
    0,
  )
  assert.equal(
    resolveConfiguration({ ...base, binding: { accessMode: 'all' } }).resources.length,
    3,
  )
})
test('language has a concrete acyclic source and explicit priority', () => {
  assert.deepEqual(resolveConfiguration(base).language, { value: '中文', source: '群聊' })
  assert.deepEqual(resolveConfiguration({ ...base, binding: { language: 'en' } }).language, {
    value: 'English',
    source: '群内 Agent 设置',
  })
  assert.deepEqual(
    resolveConfiguration({
      ...base,
      group: groupDefaults,
      definition: { ...definition, body: { ...definition.body, language: 'inherit' } },
    }).language,
    { value: '中文', source: '工作区默认' },
  )
})
test('pinned skill content and explicit member replacement', () => {
  assert.match(resolveConfiguration(base).instructions, /old skill/)
  assert.doesNotMatch(resolveConfiguration(base).instructions, /new skill/)
  const projection = resolveConfiguration({ ...base, binding: { skills: ['skill-v2'] } })
  assert.equal(projection.skills.length, 1)
  assert.match(projection.instructions, /new skill/)
  assert.equal(
    resolveConfiguration({ ...base, binding: { disabledSkills: ['coding'] } }).skills.length,
    0,
  )
  assert.throws(() => resolveConfiguration({ ...base, skills: [] }), /SKILL_VERSION_NOT_FOUND/)
})
test('resource identity, exact scope and unqualified status remain visible', () => {
  const { resources } = resolveConfiguration(base)
  assert.equal(resources[0].identity, '服务账号')
  assert.equal(resources[0].identitySource, '连接显式指定')
  assert.equal(resources[1].identity, '不附带登录凭证')
  assert.equal(resources[2].identity, '项目账号')
  assert.equal(resources[2].identitySource, 'Bundle 默认')
  assert.deepEqual(resources[2].scope, {
    repo: 'owner/repo',
    branch: 'main',
    path: '/src/**',
    actions: ['读取代码'],
  })
  assert.ok(resources.every((r) => r.readiness === 'UNQUALIFIED'))
})
test('configuration parsing rejects ambiguous modes and invalid resource scope', () => {
  assert.throws(() => parseMember({ accessMode: 'inherit-empty' }), /INVALID_ACCESS_MODE/)
  assert.throws(() => parseMember({ skills: ['a', 'a'] }), /DUPLICATE_REFERENCE/)
  assert.throws(
    () =>
      parseBundle({ ...bundle.body, mcp: [{ ...bundle.body.mcp[0], url: 'http://example.com' }] }),
    /INVALID_MCP_URL/,
  )
  assert.throws(
    () => parseBundle({ ...bundle.body, domains: [{ ...bundle.body.domains[0], port: 0 }] }),
    /INVALID_DOMAIN/,
  )
  assert.throws(
    () => parseBundle({ ...bundle.body, github: [{ ...bundle.body.github[0], path: 'src' }] }),
    /INVALID_GITHUB_SCOPE/,
  )
})
