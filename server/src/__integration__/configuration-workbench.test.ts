import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../db/pool.js'
import {
  ensureSchemaOnce,
  resetAllTables,
  teardownAll,
  seedUserMembership,
  buildApiTestApp,
} from './_helpers.js'
import { TaskService } from '../tasks/service.js'
import { ConfigurationService } from '../tasks/configuration.js'
import { TaskExecutionService } from '../tasks/execution.js'
import { TaskPlanService } from '../tasks/plans.js'
import { groupDefaults, bundleDefaults, type BundleBody } from '../../../shared/configuration.js'

before(ensureSchemaOnce)
beforeEach(resetAllTables)
after(async () => {
  await teardownAll()
})
const actor = { companyId: 'workbench-test', id: 'workbench-owner' }
const tasks = new TaskService(pool),
  configuration = new ConfigurationService(tasks)
async function fixture() {
  await pool.query(
    `INSERT INTO companies(id,name,slug,owner_user_id) VALUES($1,'Workbench',$1,$2)`,
    [actor.companyId, actor.id],
  )
  await seedUserMembership(actor.id, actor.companyId)
  await pool.query(`UPDATE company_members SET role='owner' WHERE company_id=$1 AND user_id=$2`, [
    actor.companyId,
    actor.id,
  ])
  for (const [id, name] of [
    ['wb-aida', 'Aida'],
    ['wb-worker', 'Bram'],
  ])
    await pool.query(
      `INSERT INTO participants(id,company_id,kind,name,initial,avatar_bg,status) VALUES($1,$2,'agent',$3,'A','#fff','avail')`,
      [id, actor.companyId, name],
    )
  await pool.query(
    `INSERT INTO conversations(id,company_id,kind,title,members) VALUES('wb-group',$1,'group','研发',$2),('wb-other',$1,'group','其他',$2)`,
    [actor.companyId, JSON.stringify([actor.id, 'wb-aida', 'wb-worker'])],
  )
  const definition = await tasks.define(actor, 'wb-worker-definition', {
    name: 'Bram',
    role: 'WORK',
    instructions: 'Original instructions',
  })
  const binding = await tasks.bind(actor, {
    channelId: 'wb-group',
    agentId: 'wb-worker',
    definitionVersionId: definition,
    alias: 'Bram',
    isDefault: true,
  })
  await tasks.bind(actor, {
    channelId: 'wb-other',
    agentId: 'wb-worker',
    definitionVersionId: definition,
    alias: 'Bram',
    isDefault: true,
  })
  const app = await buildApiTestApp(actor.id),
    server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    definition,
    binding,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    request: async (path: string, method = 'GET', body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${address.port}/api/tasks${path}`, {
        method,
        headers: { 'x-company-id': actor.companyId, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: r.status, body: (await r.json()) as any }
    },
    change: async (operation: Record<string, unknown>) =>
      configuration.mutate(actor, {
        ...operation,
        revision: (await configuration.read(actor)).revision,
      }),
  }
}
const skillBody = { name: '编码', slug: 'coding', description: '', content: '# 旧 Skill' }
const bundle: BundleBody = {
  ...bundleDefaults,
  name: '工程',
  identity: '项目账号',
  mcp: [
    {
      id: 'mcp',
      name: '文档',
      url: 'https://example.com/mcp',
      identity: '连接账号',
      tools: ['fetch'],
      enabled: true,
    },
  ],
  github: [
    {
      id: 'github',
      repo: 'owner/repo',
      branch: 'main',
      path: '/src/**',
      identity: '',
      actions: ['读取代码'],
      enabled: true,
    },
  ],
}

test('migration 20 and APIs persist immutable versions and reject stale writes', async () => {
  const f = await fixture()
  try {
    const state = await f.request('/workbench')
    assert.equal(state.status, 200)
    assert.equal(state.body.agents.length, 2)
    const a = await f.request('/workbench', 'PATCH', {
      revision: state.body.revision,
      action: 'publish-skill',
      objectId: 'coding',
      body: skillBody,
    })
    assert.equal(a.status, 200)
    const stale = await f.request('/workbench', 'PATCH', {
      revision: state.body.revision,
      action: 'save-workspace',
      language: 'en',
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.error, 'CONFIGURATION_REVISION_CONFLICT')
    const latest = await f.request('/workbench')
    assert.equal(latest.body.skills[0].body.content, '# 旧 Skill')
    await assert.rejects(
      pool.query(`UPDATE skill_versions SET body='{}' WHERE id=$1`, [a.body.id]),
      { code: '23514' },
    )
    assert.equal(
      (await pool.query(`SELECT MAX(version)::int v FROM schema_migrations`)).rows[0].v,
      20,
    )
  } finally {
    await f.close()
  }
})
test('group reference removal preserves empty subset and preview shows actual identities', async () => {
  const f = await fixture()
  try {
    const engineering = (
      await f.change({ action: 'publish-bundle', objectId: 'engineering', body: bundle })
    ).id!
    const research = (
      await f.change({
        action: 'publish-bundle',
        objectId: 'research',
        body: { ...bundleDefaults, name: '研究' },
      })
    ).id!
    await f.change({
      action: 'save-channel',
      channelId: 'wb-group',
      title: '研发',
      configuration: { ...groupDefaults, language: 'zh-CN' },
      bundleVersionIds: [engineering, research],
    })
    await f.change({
      action: 'save-binding',
      channelId: 'wb-group',
      agentId: 'wb-worker',
      definitionVersionId: f.definition,
      alias: 'Bram',
      isDefault: true,
      configuration: { accessMode: 'subset', bundleIds: ['engineering'] },
    })
    const preview = await f.request('/workbench/preview', 'POST', {
      channelId: 'wb-group',
      bindingId: f.binding,
    })
    assert.equal(preview.status, 200)
    assert.equal(preview.body.resources[0].identity, '连接账号')
    assert.equal(preview.body.resources[1].identity, '项目账号')
    assert.deepEqual(preview.body.resources[1].scope.actions, ['读取代码'])
    await f.change({
      action: 'save-channel',
      channelId: 'wb-group',
      title: '研发',
      configuration: groupDefaults,
      bundleVersionIds: [research],
    })
    const empty = await configuration.preview(actor, {
      channelId: 'wb-group',
      bindingId: f.binding,
    })
    assert.equal(empty.resources.length, 0)
    const read = await configuration.read(actor)
    const binding = read.channels.find((c) => c.id === 'wb-group')!.bindings[0]
    assert.equal(binding.configuration.accessMode, 'subset')
    assert.deepEqual(binding.configuration.bundleIds, [])
    await assert.rejects(
      pool.query(`UPDATE access_bundle_versions SET body='{}' WHERE id=$1`, [engineering]),
      { code: '23514' },
    )
  } finally {
    await f.close()
  }
})
test('pinned versions, member settings and language are isolated by group', async () => {
  const f = await fixture()
  try {
    const oldSkill = (
      await f.change({ action: 'publish-skill', objectId: 'coding', body: skillBody })
    ).id!
    const definition = (
      await f.change({
        action: 'publish-definition',
        objectId: 'wb-worker-definition',
        body: {
          name: 'Bram',
          role: 'WORK',
          instructions: 'Pinned prompt',
          language: 'en',
          skills: [oldSkill],
        },
      })
    ).id!
    await f.change({
      action: 'save-binding',
      channelId: 'wb-group',
      agentId: 'wb-worker',
      definitionVersionId: definition,
      alias: 'Bram',
      isDefault: true,
      configuration: { instructions: '本群要求', language: 'inherit' },
    })
    await f.change({
      action: 'save-channel',
      channelId: 'wb-group',
      title: '研发',
      configuration: { ...groupDefaults, language: 'zh-CN' },
      bundleVersionIds: [],
    })
    await f.change({
      action: 'publish-skill',
      objectId: 'coding',
      body: { ...skillBody, content: '# 新 Skill' },
    })
    const projection = await configuration.preview(actor, {
      channelId: 'wb-group',
      bindingId: f.binding,
    })
    assert.equal(projection.language.source, '群聊')
    assert.equal(projection.skills[0].id, oldSkill)
    assert.match(projection.instructions, /本群要求/)
    assert.doesNotMatch(projection.instructions, /新 Skill/)
    const other = await configuration.preview(actor, { channelId: 'wb-other' })
    assert.doesNotMatch(other.instructions, /本群要求/)
    assert.equal(other.skills.length, 0)
  } finally {
    await f.close()
  }
})
test('claimed Task keeps snapshot across configuration upgrades but runtime reassignment revokes', async () => {
  const f = await fixture()
  try {
    await f.change({
      action: 'save-channel',
      channelId: 'wb-group',
      title: '研发',
      configuration: { ...groupDefaults, rules: 'Old group rules' },
      bundleVersionIds: [],
    })
    const old = await tasks.create(actor, {
      channelId: 'wb-group',
      objective: 'Old task',
      ingressKey: 'wb-old',
      grantIds: [],
    })
    await tasks.prepare(actor)
    await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id=$1`, [
      actor.companyId,
    ])
    await tasks.drive(actor, old.id, 'wb-drive')
    const claim = (await tasks.claim(actor.companyId, 'wb-worker', 'wb-claim'))!
    const before = await new TaskExecutionService(tasks).context(actor.companyId, claim)
    const next = (
      await f.change({
        action: 'publish-definition',
        objectId: 'wb-worker-definition',
        body: { name: 'Bram', role: 'WORK', instructions: 'NEW prompt', skills: [] },
      })
    ).id!
    await f.change({
      action: 'save-binding',
      channelId: 'wb-group',
      agentId: 'wb-worker',
      definitionVersionId: next,
      alias: 'Bram',
      isDefault: true,
      configuration: {},
    })
    const after = await new TaskExecutionService(tasks).context(actor.companyId, claim)
    assert.equal(after.instructions, before.instructions)
    assert.equal(after.task.definition_version_id, f.definition)
    const current = await tasks.create(actor, {
      channelId: 'wb-group',
      objective: 'New task',
      ingressKey: 'wb-new',
      grantIds: [],
    })
    assert.match(String(current.configuration.instructions), /NEW prompt/)
    await pool.query(
      `UPDATE participants SET runtime_assignment_id='new-placement' WHERE company_id=$1 AND id='wb-worker'`,
      [actor.companyId],
    )
    await assert.rejects(
      new TaskExecutionService(tasks).context(actor.companyId, claim),
      /TASK_CONTEXT_REVOKED/,
    )
  } finally {
    await f.close()
  }
})

test('delegated Task snapshots fixed member Skill content and respects group parallelism', async () => {
  const f = await fixture()
  try {
    const skill = (await f.change({ action: 'publish-skill', objectId: 'coding', body: skillBody }))
      .id!
    const workerDef = (
      await f.change({
        action: 'publish-definition',
        objectId: 'wb-worker-definition',
        body: { name: 'Bram', role: 'WORK', instructions: 'Worker fixed prompt', skills: [skill] },
      })
    ).id!
    await f.change({
      action: 'save-binding',
      channelId: 'wb-group',
      agentId: 'wb-worker',
      definitionVersionId: workerDef,
      alias: 'Bram',
      isDefault: true,
      configuration: {},
    })
    const aidaDef = (
      await f.change({
        action: 'publish-definition',
        objectId: 'wb-aida-definition',
        body: { name: 'Aida', role: 'COORDINATOR', instructions: 'Plan and aggregate', skills: [] },
      })
    ).id!
    await f.change({
      action: 'save-binding',
      channelId: 'wb-group',
      agentId: 'wb-aida',
      definitionVersionId: aidaDef,
      alias: 'Aida',
      isDefault: true,
      configuration: {},
    })
    await f.change({
      action: 'save-channel',
      channelId: 'wb-group',
      title: '研发',
      configuration: { ...groupDefaults, rules: 'Group fixed rules', parallelism: 1 },
      bundleVersionIds: [],
    })
    const root = await tasks.create(actor, {
      channelId: 'wb-group',
      objective: 'Delegate',
      ingressKey: 'wb-root',
      grantIds: [],
    })
    await tasks.prepare(actor)
    await pool.query(`UPDATE task_workspace_settings SET mode='TASK' WHERE company_id=$1`, [
      actor.companyId,
    ])
    await tasks.drive(actor, root.id, 'wb-plan')
    const claim = (await tasks.claim(actor.companyId, 'wb-aida', 'wb-aida-claim'))!
    const plan = {
      parallelism: 1,
      members: [
        {
          key: 'work',
          bindingId: f.binding,
          objective: 'Implement',
          dependsOn: [],
          grantIds: [],
          role: 'WORK',
        },
      ],
    }
    await assert.rejects(
      new TaskPlanService(tasks).propose(actor.companyId, claim, { ...plan, parallelism: 2 }),
      /PLAN_PARALLELISM_LIMIT/,
    )
    await new TaskPlanService(tasks).propose(actor.companyId, claim, plan)
    const child = (
      await pool.query(`SELECT configuration FROM channel_tasks WHERE parent_task_id=$1`, [root.id])
    ).rows[0]
    assert.match(child.configuration.instructions, /旧 Skill/)
    assert.match(child.configuration.instructions, /Group fixed rules/)
    await f.change({
      action: 'publish-skill',
      objectId: 'coding',
      body: { ...skillBody, content: '# 新 Skill' },
    })
    assert.equal(
      (
        await pool.query(`SELECT configuration FROM channel_tasks WHERE parent_task_id=$1`, [
          root.id,
        ])
      ).rows[0].configuration.instructions,
      child.configuration.instructions,
    )
  } finally {
    await f.close()
  }
})

test('ordinary group settings activate snapshots even with a legacy three-field definition', async () => {
  const f = await fixture()
  try {
    await f.change({ action: 'save-channel', channelId: 'wb-group', title: '研发', configuration: { ...groupDefaults, parallelism: 1, memory: '仅当前任务' }, bundleVersionIds: [] })
    const task = await tasks.create(actor, { channelId: 'wb-group', objective: 'Keep ordinary configuration', ingressKey: 'ordinary-settings', grantIds: [] })
    const snapshot = task.configuration.workbench as { settings: typeof groupDefaults; instructions: string }
    assert.ok(snapshot)
    assert.equal(snapshot.settings.parallelism, 1)
    assert.equal(snapshot.settings.memory, '仅当前任务')
    assert.ok(snapshot.instructions.includes('结论 + 依据'))
    await f.change({ action: 'save-channel', channelId: 'wb-group', title: '研发', configuration: { ...groupDefaults, parallelism: 3 }, bundleVersionIds: [] })
    assert.deepEqual((await pool.query('SELECT configuration FROM channel_tasks WHERE id=$1', [task.id])).rows[0].configuration, task.configuration)
    const next = await tasks.create(actor, { channelId: 'wb-group', objective: 'Use current configuration', ingressKey: 'ordinary-next', grantIds: [] })
    assert.equal((next.configuration.workbench as { settings: typeof groupDefaults }).settings.parallelism, 3)
  } finally { await f.close() }
})
