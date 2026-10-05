import { createHash } from 'node:crypto'

export class TaskError extends Error {
  constructor(readonly code: string, readonly status: number = 409) { super(code) }
}

/** A rule is an associated tuple. Never combine independent field unions. */
export interface AccessRule {
  resource: string
  actions: string[]
  identity: string
  audience: { kind: 'CHANNEL'; id: string } | { kind: 'PERSONAL'; id: string }
  destinations: string[]
  expiresAt: string
}

export interface SourceRef {
  kind: 'MESSAGE' | 'ARTIFACT' | 'GRANT' | 'KNOWLEDGE' | 'TASK_SCOPE' | 'GOVERNANCE' | 'BOARD'
  id: string
  version: number
  hash?: string
}
export interface Provenance {
  companyId: string
  conversationId: string
  audience: AccessRule['audience']
  sources: SourceRef[]
  destinations: string[]
}

const bounded = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value)

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 64 &&
    value.every((item) => bounded(item)) && new Set(value).size === value.length
}

export function parseRule(value: unknown): AccessRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaskError('INVALID_GRANT', 400)
  const rule = value as Partial<AccessRule>
  const keys = Object.keys(rule)
  if (keys.some((key) => !['resource', 'actions', 'identity', 'audience', 'destinations', 'expiresAt'].includes(key)) ||
    !bounded(rule.resource) || !bounded(rule.identity) || !stringList(rule.actions) || !stringList(rule.destinations) ||
    !rule.audience || !['CHANNEL', 'PERSONAL'].includes(rule.audience.kind) || !bounded(rule.audience.id) ||
    Object.keys(rule.audience).some((key) => !['kind', 'id'].includes(key)) ||
    typeof rule.expiresAt !== 'string' || !Number.isFinite(Date.parse(rule.expiresAt))) {
    throw new TaskError('INVALID_GRANT', 400)
  }
  // Resource names are exact capability IDs, not a caller-supplied glob/prefix.
  if (rule.resource.includes('*') || rule.identity.includes('*')) throw new TaskError('INVALID_GRANT', 400)
  return structuredClone(rule as AccessRule)
}

export function attenuateRule(parentValue: unknown, childValue: unknown, now = Date.now()): AccessRule {
  const parent = parseRule(parentValue)
  const child = parseRule(childValue)
  if (parent.resource !== child.resource || parent.identity !== child.identity ||
    parent.audience.kind !== child.audience.kind || parent.audience.id !== child.audience.id ||
    child.actions.some((action) => !parent.actions.includes(action)) ||
    child.destinations.some((destination) => !parent.destinations.includes(destination)) ||
    Date.parse(child.expiresAt) > Date.parse(parent.expiresAt) || Date.parse(child.expiresAt) <= now) {
    throw new TaskError('GRANT_NOT_ATTENUATED', 403)
  }
  return child
}

export function authorizeTuple(rules: readonly AccessRule[], request: {
  resource: string; action: string; identity: string; audience: AccessRule['audience']; destination: string
}, now = Date.now()): AccessRule {
  const found = rules.find((rule) => rule.resource === request.resource && rule.identity === request.identity &&
    rule.actions.includes(request.action) && rule.destinations.includes(request.destination) &&
    rule.audience.kind === request.audience.kind && rule.audience.id === request.audience.id && Date.parse(rule.expiresAt) > now)
  if (!found) throw new TaskError('ACCESS_DENIED', 403)
  return found
}

export function requireLiveGrant(grant: { rule: unknown; version: number; revoked_at: unknown; expires_at: Date | string | null },
  expectedVersion: number, now = Date.now()): AccessRule {
  if (grant.revoked_at || grant.version !== expectedVersion ||
    (grant.expires_at && new Date(grant.expires_at).getTime() <= now)) throw new TaskError('SOURCE_REVOKED', 403)
  const rule = parseRule(grant.rule)
  if (Date.parse(rule.expiresAt) <= now) throw new TaskError('SOURCE_REVOKED', 403)
  return rule
}

export function parseProvenance(value: unknown): Provenance {
  if (!value || typeof value !== 'object') throw new TaskError('SOURCE_UNKNOWN', 403)
  const p = value as Partial<Provenance>
  if (!bounded(p.companyId) || !bounded(p.conversationId) || !p.audience ||
    !['CHANNEL', 'PERSONAL'].includes(p.audience.kind) || !bounded(p.audience.id) ||
    !Array.isArray(p.sources) || p.sources.length === 0 || p.sources.length > 256 ||
    !p.sources.every((s) => s && ['MESSAGE', 'ARTIFACT', 'GRANT', 'KNOWLEDGE', 'TASK_SCOPE', 'GOVERNANCE', 'BOARD'].includes(s.kind) && bounded(s.id) &&
      Number.isInteger(s.version) && s.version > 0 && (s.kind!=='BOARD' || (s.version===1 && typeof s.hash==='string' && /^[a-f0-9]{64}$/.test(s.hash)))) || !stringList(p.destinations)) {
    throw new TaskError('SOURCE_UNKNOWN', 403)
  }
  return structuredClone(p as Provenance)
}

/** Publication does not relabel provenance; explicit publication is a separate fact. */
export function checkDestination(p: Provenance, target: {
  companyId: string; conversationId: string; audience: AccessRule['audience']; destination: string
}): void {
  if (p.companyId !== target.companyId || p.conversationId !== target.conversationId ||
    p.audience.kind !== target.audience.kind || p.audience.id !== target.audience.id ||
    !p.destinations.includes(target.destination)) throw new TaskError('SOURCE_DESTINATION_DENIED', 403)
}

export function hashContent(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`).join(',')}}`
  return JSON.stringify(value)
}

export interface PlanMember {
  key: string
  bindingId: string
  objective: string
  dependsOn: string[]
  grantIds: string[]
  role: 'WORK' | 'VERIFY'
  governanceAttemptId?: string
}
export interface TaskPlan { members: PlanMember[]; parallelism: number }

export function validatePlan(value: unknown, eligibleBindings: ReadonlySet<string>): TaskPlan {
  if (!value || typeof value !== 'object') throw new TaskError('INVALID_PLAN', 400)
  const plan = value as TaskPlan
  if(Object.keys(plan).some(key=>!['members','parallelism'].includes(key))) throw new TaskError('INVALID_PLAN',400)
  if (!Array.isArray(plan.members) || plan.members.length < 1 || plan.members.length > 8 ||
    !Number.isInteger(plan.parallelism) || plan.parallelism < 1 || plan.parallelism > 4) throw new TaskError('INVALID_PLAN', 400)
  const members = new Map<string, PlanMember>()
  for (const member of plan.members) {
    if (Object.keys(member).some(key=>!['key','bindingId','objective','dependsOn','grantIds','role','governanceAttemptId'].includes(key)) || (member.governanceAttemptId!==undefined && !bounded(member.governanceAttemptId)) || !bounded(member.key, 80) || members.has(member.key) || !eligibleBindings.has(member.bindingId) ||
      !bounded(member.objective, 12000) || !['WORK', 'VERIFY'].includes(member.role) ||
      !Array.isArray(member.dependsOn) || !member.dependsOn.every((key) => bounded(key, 80)) ||
      new Set(member.dependsOn).size !== member.dependsOn.length ||
      !Array.isArray(member.grantIds) || !member.grantIds.every((id) => bounded(id))) throw new TaskError('INVALID_PLAN', 400)
    members.set(member.key, member)
  }
  const active = new Set<string>()
  const visited = new Set<string>()
  const visit = (key: string): void => {
    if (active.has(key)) throw new TaskError('PLAN_CYCLE', 400)
    if (visited.has(key)) return
    const member = members.get(key)
    if (!member) throw new TaskError('PLAN_DEPENDENCY_UNKNOWN', 400)
    active.add(key)
    for (const dependency of member.dependsOn) visit(dependency)
    active.delete(key)
    visited.add(key)
  }
  for (const key of members.keys()) visit(key)
  return structuredClone(plan)
}

/** Native tool namespaces are grouping only. Provider-hosted tools remain forbidden. */
export function taskLocalToolsAllowed(value:unknown):boolean {
  if(!Array.isArray(value) || value.length>64)return false
  let count=0
  const local=(tool:unknown):boolean=>{
    if(!tool || typeof tool!=='object' || ++count>64)return false
    const item=tool as {type?:string;name?:string}
    return ['function','custom'].includes(item.type??'') && bounded(item.name,120)
  }
  return value.every(tool=>{
    if(tool?.type==='namespace')return bounded(tool.name,120) && Array.isArray(tool.tools) && tool.tools.length>0 && tool.tools.every(local)
    return local(tool)
  })
}
