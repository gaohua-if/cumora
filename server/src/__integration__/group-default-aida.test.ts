import { before, beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import type { PoolClient } from 'pg'
import { pool } from '../db/pool.js'
import { ensureSchemaOnce, resetAllTables, teardownAll, seedUserMembership, buildApiTestApp } from './_helpers.js'
import { TaskService } from '../tasks/service.js'
import { DefaultAidaService } from '../tasks/default-aida.js'

before(ensureSchemaOnce)
beforeEach(resetAllTables)
after(async () => { await teardownAll() })
const actor = { companyId: 'group-aida-test', id: 'group-owner' }
const tasks = new TaskService(pool)
async function fixture() {
  await pool.query(`INSERT INTO companies(id,name,slug,owner_user_id) VALUES($1,'Group Aida',$1,$2)`, [actor.companyId, actor.id])
  await seedUserMembership(actor.id, actor.companyId)
  await pool.query(`UPDATE company_members SET role='owner' WHERE company_id=$1 AND user_id=$2`, [actor.companyId, actor.id])
  await pool.query(`INSERT INTO participants(id,company_id,kind,name,role,initial,avatar_bg,status,system_prompt) VALUES('group-worker',$1,'agent','Worker','Engineer','W','#fff','avail','Handle only the approved task')`, [actor.companyId])
  await pool.query(`INSERT INTO computers(id,company_id,name,kind,available_engines,status) VALUES('group-local',$1,'Local','linux','["claude","codex"]','online')`, [actor.companyId])
  const app = await buildApiTestApp(actor.id)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  return { server, post: (path: string, body = {}) => fetch(`http://127.0.0.1:${address.port}/api${path}`, { method: 'POST', headers: { 'x-company-id': actor.companyId, 'content-type': 'application/json' }, body: JSON.stringify(body) }), close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

test('ordinary solo/multi group creation installs one local Aida and live bindings under concurrent requests', async () => {
  const f = await fixture()
  try {
    const responses = await Promise.all([f.post('/conversations', { title: 'Solo', members: [] }), f.post('/conversations', { title: 'Team', members: ['group-worker'] })])
    assert.deepEqual(responses.map(r => r.status), [201, 201])
    const groups = await Promise.all(responses.map(async r => await r.json() as { id: string; members: string[] }))
    const aidas = (await pool.query(`SELECT id,computer_id,engine FROM participants WHERE company_id=$1 AND name='Aida'`, [actor.companyId])).rows
    assert.equal(aidas.length, 1); assert.equal(aidas[0].computer_id, 'group-local'); assert.equal(aidas[0].engine, 'codex')
    assert.deepEqual(new Set(groups[0].members), new Set([actor.id, aidas[0].id]))
    assert.deepEqual(new Set(groups[1].members), new Set([actor.id, aidas[0].id, 'group-worker']))
    assert.equal((await pool.query(`SELECT count(*)::int n FROM channel_agent_bindings WHERE company_id=$1 AND is_default`, [actor.companyId])).rows[0].n, 2)
    assert.equal((await pool.query(`SELECT count(*)::int n FROM channel_agent_bindings WHERE company_id=$1`, [actor.companyId])).rows[0].n, 3)
    assert.equal(await tasks.mode(actor.companyId), 'LEGACY')
    await Promise.all([f.post(`/conversations/${groups[1].id}/default-aida`), f.post(`/conversations/${groups[1].id}/default-aida`)])
    assert.equal((await pool.query(`SELECT count(*)::int n FROM channel_agent_bindings WHERE company_id=$1`, [actor.companyId])).rows[0].n, 3)
    assert.equal((await pool.query(`SELECT count(*)::int n FROM task_dispatches WHERE company_id=$1`, [actor.companyId])).rows[0].n, 0)
    const defaultBinding = await tasks.transaction(actor.companyId, client => tasks.binding(client, actor.companyId, groups[1].id))
    assert.equal(defaultBinding.agent_id, aidas[0].id)
    const task = await tasks.create(actor, { channelId: groups[1].id, objective: 'Use the automatic default', ingressKey: 'group-default-work', grantIds: [] })
    assert.equal(task.accountable_binding_id, defaultBinding.id)
  } finally { await f.close() }
})

test('opening existing group initializes Aida once and preserves explicit default and task snapshots', async () => {
  const f = await fixture()
  try {
    await pool.query(`INSERT INTO conversations(id,company_id,kind,title,members) VALUES('existing-group',$1,'group','Existing',$2)`, [actor.companyId, JSON.stringify([actor.id, 'group-worker'])])
    const definition = await tasks.define(actor, 'existing-worker', { name: 'Worker', role: 'WORK', instructions: 'Existing immutable instructions' })
    const original = await tasks.bind(actor, { channelId: 'existing-group', agentId: 'group-worker', definitionVersionId: definition, alias: 'Custom owner', isDefault: true })
    const oldTask = await tasks.create(actor, { channelId: 'existing-group', objective: 'Keep original responsibility', ingressKey: 'group-old-task', grantIds: [] })
    const results = await Promise.all([f.post('/conversations/existing-group/default-aida'), f.post('/conversations/existing-group/default-aida')])
    assert.deepEqual(results.map(r => r.status), [200, 200])
    assert.equal((await tasks.transaction(actor.companyId, c => tasks.binding(c, actor.companyId, 'existing-group'))).id, original)
    assert.equal((await pool.query(`SELECT accountable_binding_id FROM channel_tasks WHERE id=$1`, [oldTask.id])).rows[0].accountable_binding_id, original)
    assert.equal((await pool.query(`SELECT count(*)::int n FROM messages WHERE conversation_id='existing-group' AND kind='system'`)).rows[0].n, 1)
    const bindings = (await pool.query(`SELECT b.agent_id,b.alias,d.body->>'role' role FROM channel_agent_bindings b JOIN agent_definition_versions d ON d.id=b.definition_version_id WHERE b.conversation_id='existing-group' AND b.status='ACTIVE'`)).rows
    // Aida must remain available for explicit @ requests even with a custom default.
    assert.equal(bindings.length, 2)
    assert.ok(bindings.some(b => b.alias === 'Aida' && b.role === 'COORDINATOR'))
  } finally { await f.close() }
})

test('group initializer rejects non-members/private conversations and installation obeys existing quotas', async () => {
  const f = await fixture()
  try {
    await pool.query(`INSERT INTO conversations(id,company_id,kind,title,members) VALUES('other-group',$1,'group','Other','["group-worker"]'),('private-channel',$1,'direct','Private',$2)`, [actor.companyId, JSON.stringify([actor.id, 'group-worker'])])
    assert.equal((await f.post('/conversations/other-group/default-aida')).status, 403)
    assert.equal((await f.post('/conversations/private-channel/default-aida')).status, 400)
    assert.equal((await pool.query(`SELECT count(*)::int n FROM participants WHERE company_id=$1 AND name='Aida'`, [actor.companyId])).rows[0].n, 0)
    const limited = new DefaultAidaService(tasks, async () => ({ tier: 'free', maxActiveAgents: 1 }))
    await assert.rejects(limited.identity(actor), /at most 1/)
    assert.equal((await pool.query(`SELECT count(*)::int n FROM participants WHERE company_id=$1 AND name='Aida'`, [actor.companyId])).rows[0].n, 0)
    const service = new DefaultAidaService(tasks, async () => ({ tier: 'free', maxActiveAgents: 10 }))
    const queries: string[] = []
    const oldSchema = { query: async (sql: string) => { queries.push(sql); return { rows: [{ version: 14 }] } } } as unknown as PoolClient
    assert.equal(await service.binding(oldSchema, actor, 'old-schema-group', 'aida'), null)
    assert.equal(queries.length, 1)
  } finally { await f.close() }
})
