import { taskLocalToolsAllowed } from '../tasks/contracts.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attenuateRule, authorizeTuple, checkDestination, parseProvenance, parseRule, requireLiveGrant, validatePlan,
  type AccessRule, type Provenance } from '../tasks/contracts.js'

const now = Date.parse('2026-01-01T00:00:00Z')
const rule: AccessRule = { resource: 'repo:one', actions: ['read', 'write'], identity: 'service:one',
  audience: { kind: 'CHANNEL', id: 'channel' }, destinations: ['model:a', 'artifact'], expiresAt: '2027-01-01T00:00:00Z' }

test('task grants deny permission cross-products', () => {
  const second = { ...rule, resource: 'repo:two', identity: 'service:two', actions: ['read'] }
  assert.throws(() => authorizeTuple([rule, second], { resource: second.resource, identity: second.identity, action: 'write',
    audience: rule.audience, destination: 'artifact' }, now), /ACCESS_DENIED/)
  assert.throws(() => authorizeTuple([rule, second], { resource: rule.resource, identity: second.identity, action: 'read',
    audience: rule.audience, destination: 'artifact' }, now), /ACCESS_DENIED/)
  assert.equal(authorizeTuple([rule, second], { resource: rule.resource, identity: rule.identity, action: 'write',
    audience: rule.audience, destination: 'artifact' }, now), rule)
})

test('attenuation preserves identity, audience and resource and only narrows actions/destinations/time', () => {
  const child = { ...rule, actions: ['read'], destinations: ['artifact'], expiresAt: '2026-06-01T00:00:00Z' }
  assert.deepEqual(attenuateRule(rule, child, now), child)
  for (const changed of [{ resource: 'repo:two' }, { identity: 'personal' }, { actions: ['admin'] },
    { audience: { kind: 'PERSONAL', id: 'owner' } }, { destinations: ['model:b'] }, { expiresAt: '2028-01-01T00:00:00Z' }]) {
    assert.throws(() => attenuateRule(rule, { ...child, ...changed }, now), /GRANT_NOT_ATTENUATED/)
  }
  assert.throws(() => attenuateRule(rule, child, Date.parse('2026-08-01T00:00:00Z')), /GRANT_NOT_ATTENUATED/)
})

test('unknown grant fields, wildcard resources, invalid audience and invalid expiration fail closed', () => {
  for (const changed of [{ admin: true }, { resource: '*' }, { actions: [] }, { audience: { kind: 'ALL', id: 'channel' } },
    { expiresAt: 'never' }, { actions: ['read', 'read'] }]) assert.throws(() => parseRule({ ...rule, ...changed }), /INVALID_GRANT/)
})

test('revoked, changed and expired live source grants invalidate snapshots', () => {
  const live = { rule, version: 1, revoked_at: null, expires_at: null }
  assert.deepEqual(requireLiveGrant(live, 1, now), rule)
  for (const changed of [{ revoked_at: new Date(now) }, { version: 2 }, { expires_at: new Date(now - 1) }]) {
    assert.throws(() => requireLiveGrant({ ...live, ...changed }, 1, now), /SOURCE_REVOKED/)
  }
})

test('pinned or copied memory still needs provenance and approved audience/model destination', () => {
  assert.throws(() => parseProvenance({ pinned: true }), /SOURCE_UNKNOWN/)
  const p: Provenance = { companyId: 'tenant', conversationId: 'channel', audience: rule.audience,
    sources: [{ kind: 'MESSAGE', id: 'source', version: 1 }], destinations: ['model:a'] }
  const target = { companyId: 'tenant', conversationId: 'channel', audience: rule.audience, destination: 'model:a' }
  checkDestination(parseProvenance(p), target)
  for (const changed of [{ companyId: 'other' }, { conversationId: 'other' }, { destination: 'embedding:b' },
    { audience: { kind: 'PERSONAL' as const, id: 'owner' } }]) {
    assert.throws(() => checkDestination(p, { ...target, ...changed }), /SOURCE_DESTINATION_DENIED/)
  }
})

test('bounded plans reject cycles, unknown bindings and excessive parallelism', () => {
  const member = { key: 'repair', bindingId: 'worker', objective: 'repair', dependsOn: [] as string[], grantIds: ['grant'], role: 'WORK' as const }
  const verify = { ...member, key: 'verify', bindingId: 'verifier', role: 'VERIFY' as const, dependsOn: ['repair'] }
  const bindings = new Set(['worker', 'verifier'])
  assert.equal(validatePlan({ members: [member, verify], parallelism: 2 }, bindings).members.length, 2)
  assert.throws(() => validatePlan({ members: [{ ...member, dependsOn: ['verify'] }, verify], parallelism: 2 }, bindings), /PLAN_CYCLE/)
  assert.throws(() => validatePlan({ members: [{ ...member, bindingId: 'other-channel' }], parallelism: 1 }, bindings), /INVALID_PLAN/)
  assert.throws(() => validatePlan({ members: [member], parallelism: 5 }, bindings), /INVALID_PLAN/)
  assert.throws(() => validatePlan({ members: Array.from({length:9},(_,index)=>({...member,key:`work-${index}`})), parallelism: 1 }, bindings), /INVALID_PLAN/)
  assert.throws(() => validatePlan({ members: [{ ...member, dependsOn: ['missing'] }], parallelism: 1 }, bindings), /PLAN_DEPENDENCY_UNKNOWN/)
})

test('native namespaces allow only local tools and never nested hosted tools',()=>{
  assert.equal(taskLocalToolsAllowed([{type:'namespace',name:'functions',tools:[{type:'function',name:'exec_command'}]},{type:'custom',name:'apply_patch'}]),true)
  for(const tool of [{type:'web_search'},{type:'mcp'},{type:'image_generation'},{type:'namespace',name:'functions',tools:[{type:'web_search'}]}])assert.equal(taskLocalToolsAllowed([tool]),false)
})
