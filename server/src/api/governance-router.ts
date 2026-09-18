import { createHash, randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import type { Pool, PoolClient } from 'pg'
import type { AuthedRequest } from '../auth.js'
import { env } from '../env.js'
import { priceFor } from '../agents/cost.js'

type CompanyContext = { userId: string; companyId: string }
type CompanyRoleContext = CompanyContext & { role: string }
export interface GovernanceRouterDeps {
  pool: Pool
  requireCompany(req: Request & AuthedRequest): Promise<CompanyContext>
  requireCompanyRole(req: Request & AuthedRequest): Promise<CompanyRoleContext>
}

class GovernanceError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}

const GRANT_OPERATIONS = new Set([
  'card.read', 'card.comment', 'card.claim', 'card.move', 'card.assign', 'card.rename', 'card.action.create', 'card.action.delegate',
  'artifact.read', 'artifact.publish', 'shipping.verify', 'shipping.read',
])
const SENSITIVITY = new Set(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'])
const APPROVAL_OPERATIONS = new Set(['connector.write', 'shipping.release', 'external.write'])
const STATES = new Set(['CREATED', 'READY', 'RUNNING', 'WAITING_HUMAN', 'BLOCKED', 'SUBMITTED', 'CANCELLING', 'COMPLETED', 'CANCELLED', 'SUPERSEDED', 'FAILED'])

function text(value: unknown, max = 4000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}
function id(value: unknown, name: string): string {
  const result = text(value, 200)
  if (!result || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(result)) throw new GovernanceError(400, 'INVALID_ID', `${name} is required`)
  return result
}
function int(value: unknown, name: string, min = 0, max = 2_147_483_647): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new GovernanceError(400, 'INVALID_NUMBER', `${name} must be an integer between ${min} and ${max}`)
  return value as number
}
function iso(value: unknown, name: string, required = true): Date | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new GovernanceError(400, 'INVALID_TIME', `${name} is required`)
    return null
  }
  const result = new Date(String(value))
  if (Number.isNaN(result.getTime())) throw new GovernanceError(400, 'INVALID_TIME', `${name} must be an ISO timestamp`)
  return result
}
function array(value: unknown, name: string, max = 100): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new GovernanceError(400, 'INVALID_ARRAY', `${name} must be an array of at most ${max} items`)
  return value
}
type Grant = { resourceType: string; resourceId: string; operation: string }
function grants(value: unknown, name = 'grants'): Grant[] {
  return array(value, name).map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new GovernanceError(400, 'INVALID_GRANT', `${name} contains an invalid grant`)
    const x = raw as Record<string, unknown>
    const resourceType = id(x.resourceType, 'resourceType')
    const resourceId = id(x.resourceId, 'resourceId')
    const operation = id(x.operation, 'operation')
    if (!GRANT_OPERATIONS.has(operation)) throw new GovernanceError(400, 'UNKNOWN_OPERATION', `unsupported operation: ${operation}`)
    return { resourceType, resourceId, operation }
  })
}
function grantKey(g: Grant): string { return `${g.resourceType}\u0000${g.resourceId}\u0000${g.operation}` }
function subset(child: Grant[], parent: Grant[]): boolean {
  const allowed = new Set(parent.map(grantKey))
  return child.every((grant) => allowed.has(grantKey(grant)))
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function json(value: unknown, fallback: unknown): string { return JSON.stringify(value === undefined ? fallback : value) }
function errorResponse(res: Response, error: unknown): void {
  if (error instanceof GovernanceError) { res.status(error.status).json({ error: error.message, code: error.code }); return }
  console.error('[governance]', error)
  res.status(500).json({ error: 'governance request failed', code: 'INTERNAL_ERROR' })
}

async function event(client: PoolClient, args: {
  companyId: string; aggregateType: string; aggregateId: string; aggregateVersion: number
  eventType: string; actorType: 'HUMAN' | 'AGENT' | 'SERVICE'; actorId: string
  cardId?: string | null; actionId?: string | null; mandateId?: string | null; mandateVersion?: number | null
  attemptId?: string | null; actingRoleId?: string | null; sponsorUserId?: string | null; sponsorAssignmentId?: string | null
  planEpoch?: number | null; correlationId?: string; causationId?: string | null; idempotencyKey?: string | null; payload?: unknown
}): Promise<string> {
  const eventId = `gev-${randomUUID()}`
  await client.query(
    `INSERT INTO governance_events
      (id, company_id, aggregate_type, aggregate_id, aggregate_version, event_type,
       actor_type, actor_id, acting_role_id, sponsor_user_id, sponsor_assignment_id,
       mandate_id, mandate_version, card_id, action_id, attempt_id, plan_epoch,
       correlation_id, causation_id, idempotency_key, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb)`,
    [eventId, args.companyId, args.aggregateType, args.aggregateId, args.aggregateVersion,
      args.eventType, args.actorType, args.actorId, args.actingRoleId ?? null, args.sponsorUserId ?? null,
      args.sponsorAssignmentId ?? null, args.mandateId ?? null, args.mandateVersion ?? null,
      args.cardId ?? null, args.actionId ?? null, args.attemptId ?? null, args.planEpoch ?? null,
      args.correlationId ?? randomUUID(), args.causationId ?? null, args.idempotencyKey ?? null, json(args.payload, {})],
  )
  return eventId
}

async function membership(pool: Pool, companyId: string, userId: string): Promise<string> {
  const { rows } = await pool.query<{ role: string }>(
    `SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2 LIMIT 1`, [companyId, userId],
  )
  if (!rows[0]) throw new GovernanceError(403, 'NOT_MEMBER', 'not a member of this workspace')
  return rows[0].role
}

async function primaryAssignment(client: PoolClient | Pool, companyId: string, roleId: string, userId?: string) {
  const params: unknown[] = [companyId, roleId]
  let predicate = `company_id = $1 AND role_id = $2 AND assignment_type = 'PRIMARY' AND status = 'ACTIVE'
    AND valid_from <= NOW() AND (valid_until IS NULL OR valid_until > NOW())
    AND EXISTS (SELECT 1 FROM company_members cm WHERE cm.company_id=governance_role_assignments.company_id AND cm.user_id=governance_role_assignments.human_user_id)`
  if (userId) { params.push(userId); predicate += ` AND human_user_id = $${params.length}` }
  const { rows } = await client.query<any>(`SELECT * FROM governance_role_assignments WHERE ${predicate} ORDER BY valid_from DESC LIMIT 1`, params)
  if (!rows[0]) throw new GovernanceError(409, 'PRIMARY_REQUIRED', 'role has no valid Primary assignment')
  return rows[0]
}

async function card(client: PoolClient, companyId: string, cardId: string, lock = false) {
  const { rows } = await client.query<any>(
    `SELECT c.*, b.company_id FROM board_cards c JOIN boards b ON b.id = c.board_id
      WHERE c.id = $1 AND b.company_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [cardId, companyId],
  )
  if (!rows[0]) throw new GovernanceError(404, 'CARD_NOT_FOUND', 'card not found')
  return rows[0]
}

async function mandate(client: PoolClient, companyId: string, mandateId: string, agentId?: string, lock = false) {
  const params: unknown[] = [companyId, mandateId]
  let extra = ''
  if (agentId) { params.push(agentId); extra = ` AND agent_id = $${params.length}` }
  const { rows } = await client.query<any>(
    `SELECT * FROM governance_mandates WHERE company_id = $1 AND id = $2${extra}
      AND status = 'ACTIVE' AND valid_from <= NOW() AND valid_until > NOW()
      AND EXISTS (SELECT 1 FROM governance_role_assignments ra JOIN company_members cm ON cm.company_id=ra.company_id AND cm.user_id=ra.human_user_id
        WHERE ra.id=governance_mandates.sponsor_assignment_id AND ra.company_id=governance_mandates.company_id AND ra.role_id=governance_mandates.role_id
          AND ra.human_user_id=governance_mandates.sponsor_user_id AND ra.assignment_type='PRIMARY' AND ra.status='ACTIVE'
          AND ra.valid_from<=NOW() AND (ra.valid_until IS NULL OR ra.valid_until>NOW())) ${lock ? 'FOR UPDATE' : ''}`,
    params,
  )
  if (!rows[0]) throw new GovernanceError(409, 'MANDATE_INVALID', 'mandate is not active or has expired')
  return rows[0]
}

export function createGovernanceRouter(deps: GovernanceRouterDeps): Router {
  const { pool } = deps
  const router = Router()

  router.get('/roles', async (req, res) => {
    try {
      const { companyId } = await deps.requireCompany(req as Request & AuthedRequest)
      const { rows } = await pool.query(
        `SELECT r.id, r.name, r.responsibility_scope AS "responsibilityScope", r.status, r.version,
                a.id AS "primaryAssignmentId", a.human_user_id AS "primaryUserId",
                a.valid_from AS "validFrom", a.valid_until AS "validUntil"
           FROM governance_roles r
           LEFT JOIN governance_role_assignments a ON a.role_id = r.id AND a.company_id = r.company_id
            AND a.assignment_type = 'PRIMARY' AND a.status = 'ACTIVE'
            AND a.valid_from <= NOW() AND (a.valid_until IS NULL OR a.valid_until > NOW())
          WHERE r.company_id = $1 ORDER BY r.name`, [companyId],
      )
      res.json(rows)
    } catch (error) { errorResponse(res, error) }
  })

  router.post('/roles', async (req, res) => {
    try {
      const { userId, companyId } = await deps.requireCompanyRole(req as Request & AuthedRequest)
      const roleId = `role-${randomUUID().slice(0, 12)}`
      const name = text(req.body?.name, 200)
      if (!name) throw new GovernanceError(400, 'NAME_REQUIRED', 'role name is required')
      const scope = text(req.body?.responsibilityScope, 4000)
      const grantable = grants(req.body?.grantableGrants ?? [], 'grantableGrants')
      await pool.query(
        `INSERT INTO governance_roles (id, company_id, name, responsibility_scope, grantable_grants, created_by)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6)`, [roleId, companyId, name, scope, JSON.stringify(grantable), userId],
      )
      res.status(201).json({ id: roleId, companyId, name, responsibilityScope: scope, grantableGrants: grantable, version: 1 })
    } catch (error) { errorResponse(res, error) }
  })

  router.post('/roles/:roleId/assignments', async (req, res) => {
    try {
      const { userId, companyId } = await deps.requireCompanyRole(req as Request & AuthedRequest)
      const roleId = id(req.params.roleId, 'roleId')
      const humanUserId = id(req.body?.humanUserId, 'humanUserId')
      const validFrom = iso(req.body?.validFrom, 'validFrom', false) ?? new Date()
      const validUntil = iso(req.body?.validUntil, 'validUntil', false)
      const assignmentType = req.body?.assignmentType === 'BACKUP' ? 'BACKUP' : 'PRIMARY'
      if (assignmentType !== 'PRIMARY') throw new GovernanceError(400, 'P0_PRIMARY_ONLY', 'only Primary assignments are supported in P0')
      const expectedVersion = int(req.body?.expectedVersion, 'expectedVersion', 1)
      const assignmentId = `rassign-${randomUUID().slice(0, 12)}`
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const role = await client.query<any>(`SELECT id,version FROM governance_roles WHERE id = $1 AND company_id = $2 AND status='ACTIVE' FOR UPDATE`, [roleId, companyId])
        if (!role.rows[0]) throw new GovernanceError(404, 'ROLE_NOT_FOUND', 'active role not found')
        if (role.rows[0].version !== expectedVersion) throw new GovernanceError(409, 'VERSION_CONFLICT', 'role version changed')
        await membership(client as unknown as Pool, companyId, humanUserId)
        if (assignmentType === 'PRIMARY') {
          await client.query(
            `UPDATE governance_role_assignments SET status='ENDED', valid_until=COALESCE(valid_until,NOW()), version=version+1, updated_at=NOW()
              WHERE company_id=$1 AND role_id=$2 AND assignment_type='PRIMARY' AND status='ACTIVE'
                AND valid_from <= NOW() AND (valid_until IS NULL OR valid_until > NOW())`, [companyId, roleId],
          )
        }
        await client.query(
          `INSERT INTO governance_role_assignments
             (id,company_id,role_id,human_user_id,assignment_type,valid_from,valid_until,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [assignmentId, companyId, roleId, humanUserId, assignmentType, validFrom, validUntil, userId],
        )
        await client.query(`UPDATE governance_roles SET version=version+1,updated_at=NOW() WHERE id=$1 AND company_id=$2`, [roleId, companyId])
        await event(client, { companyId, aggregateType: 'ROLE_ASSIGNMENT', aggregateId: assignmentId, aggregateVersion: 1,
          eventType: 'ROLE_ASSIGNED', actorType: 'HUMAN', actorId: userId, actingRoleId: roleId, payload: { humanUserId, assignmentType } } as any)
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
      res.status(201).json({ id: assignmentId, roleId, humanUserId, assignmentType, validFrom, validUntil, roleVersion: expectedVersion + 1 })
    } catch (error) { errorResponse(res, error) }
  })

  router.post('/cards/:cardId/upgrade', async (req, res) => {
    try {
      if (!env.GOVERNANCE_UPGRADES_ENABLED) throw new GovernanceError(503, 'GOVERNANCE_UPGRADES_DISABLED', 'new governance upgrades are temporarily disabled')
      const { userId, companyId } = await deps.requireCompany(req as Request & AuthedRequest)
      const cardId = id(req.params.cardId, 'cardId')
      const roleId = id(req.body?.accountableRoleId, 'accountableRoleId')
      const agentId = id(req.body?.agentId, 'agentId')
      const definition = text(req.body?.definitionOfDone, 8000)
      if (!definition) throw new GovernanceError(400, 'DOD_REQUIRED', 'definitionOfDone is required')
      const deadline = iso(req.body?.deadline, 'deadline')!
      const budgetMicrousd = int(req.body?.budgetLimitMicrousd ?? 0, 'budgetLimitMicrousd')
      const callLimit = int(req.body?.modelCallLimit ?? 0, 'modelCallLimit')
      const deliveryGate = req.body?.deliveryGate === 'PRODUCTION_READBACK' ? 'PRODUCTION_READBACK' : 'CODE_ACCEPTED'
      if (deliveryGate === 'PRODUCTION_READBACK') throw new GovernanceError(400, 'P1_GATE_UNAVAILABLE', 'PRODUCTION_READBACK is not available in P0')
      const shippingFeatureId = req.body?.shippingFeatureId ? id(req.body.shippingFeatureId, 'shippingFeatureId') : null
      const reviewPolicy = req.body?.reviewPolicy ?? { independentCheck: true, finalAcceptance: true }
      const expectedVersion = int(req.body?.expectedVersion, 'expectedVersion')
      const idempotencyKey = text(req.get('Idempotency-Key') || req.body?.idempotencyKey, 200); if (!idempotencyKey) throw new GovernanceError(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required')
      const requestHash = hash({ cardId, body: req.body ?? {} })
      const client = await pool.connect()
      let response: unknown
      try {
        await client.query('BEGIN')
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [JSON.stringify([companyId, userId, 'upgrade_card_governance', idempotencyKey])])
        const prior = (await client.query<any>(`SELECT request_hash,result FROM governance_idempotency WHERE company_id=$1 AND actor_type='HUMAN' AND actor_id=$2 AND command_name='upgrade_card_governance' AND idempotency_key=$3`, [companyId, userId, idempotencyKey])).rows[0]
        if (prior) { if (prior.request_hash !== requestHash) throw new GovernanceError(409, 'IDEMPOTENCY_CONFLICT', 'idempotency key was used with a different request'); await client.query('COMMIT'); res.json(prior.result); return }
        const c = await card(client, companyId, cardId, true)
        if (c.governance_version !== expectedVersion) throw new GovernanceError(409, 'VERSION_CONFLICT', 'card version changed')
        if (c.governance_mode === 'GOVERNED') throw new GovernanceError(409, 'ALREADY_GOVERNED', 'card is already governed')
        const role = await client.query<any>(`SELECT * FROM governance_roles WHERE id=$1 AND company_id=$2 AND status='ACTIVE' FOR SHARE`, [roleId, companyId])
        if (!role.rows[0]) throw new GovernanceError(404, 'ROLE_NOT_FOUND', 'accountable role not found')
        const assignment = await primaryAssignment(client, companyId, roleId, userId)
        const agent = await client.query<any>(`SELECT id FROM participants WHERE id=$1 AND company_id=$2 AND kind='agent' AND departed_at IS NULL`, [agentId, companyId])
        if (!agent.rows[0]) throw new GovernanceError(404, 'AGENT_NOT_FOUND', 'agent not found or inactive')
        let shippingContractRevision: number | null = null
        if (shippingFeatureId) {
          const feature = (await client.query<any>(`SELECT * FROM shipping_features WHERE id=$1 AND company_id=$2 FOR UPDATE`, [shippingFeatureId, companyId])).rows[0]
          if (!feature || (feature.board_card_id && feature.board_card_id !== cardId)) throw new GovernanceError(409, 'SHIPPING_FEATURE_MISMATCH', 'shipping feature is missing or linked to another card')
          shippingContractRevision = Number(feature.contract_revision)
          await client.query(`UPDATE shipping_features SET board_card_id=$1,governance_version=governance_version+1,updated_at=NOW() WHERE id=$2`, [cardId, shippingFeatureId])
        }
        const budgetId = `gbudget-${randomUUID().slice(0, 12)}`
        await client.query(
          `INSERT INTO governance_budget_accounts (id,company_id,card_id,limit_microusd,model_call_limit)
           VALUES ($1,$2,$3,$4,$5)`, [budgetId, companyId, cardId, budgetMicrousd, callLimit],
        )
        const planId = `plan-${randomUUID().slice(0, 12)}`
        await client.query(
          `INSERT INTO governance_card_plans
             (id,company_id,card_id,version,epoch,goal,definition_of_done,review_policy,created_by,approved_by,state)
           VALUES ($1,$2,$3,1,1,$4,$5,$6::jsonb,$7,$7,'ACTIVE')`,
          [planId, companyId, cardId, text(c.title, 200), definition, JSON.stringify(reviewPolicy), userId],
        )
        if (shippingFeatureId) {
          await client.query(`UPDATE governance_card_plans SET shipping_contract_revision=$1 WHERE id=$2`, [shippingContractRevision, planId])
          await client.query(`UPDATE board_cards SET shipping_feature_id=$1 WHERE id=$2`, [shippingFeatureId, cardId])
        }
        const mandateId = `mandate-${randomUUID().slice(0, 12)}`
        const mandateVersion = 1
        const mandateGrants = grants(req.body?.grants ?? [
          { resourceType: 'CARD', resourceId: cardId, operation: 'card.read' },
          { resourceType: 'CARD', resourceId: cardId, operation: 'card.action.create' },
          { resourceType: 'CARD', resourceId: cardId, operation: 'artifact.publish' },
        ])
        const allowed = new Set((role.rows[0].grantable_grants ?? []).map((x: Grant) => grantKey(x)))
        if (!mandateGrants.every((g) => allowed.has(grantKey(g)))) throw new GovernanceError(403, 'GRANT_NOT_ALLOWED', 'mandate exceeds role grantable scope')
        await client.query(
          `INSERT INTO governance_mandates
             (id,mandate_version,company_id,card_id,role_id,sponsor_user_id,sponsor_assignment_id,agent_id,
              grants,data_resource_ids,tool_ids,budget_account_id,budget_limit_microusd,model_call_limit,
              valid_from,valid_until,max_delegation_depth,autonomy_policy,status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'[]'::jsonb,'[]'::jsonb,$10,$11,$12,NOW(),$13,1,$14::jsonb,'ACTIVE')`,
          [mandateId, mandateVersion, companyId, cardId, roleId, userId, assignment.id, agentId,
            JSON.stringify(mandateGrants), budgetId, budgetMicrousd, callLimit, deadline, JSON.stringify(req.body?.autonomyPolicy ?? {})],
        )
        await client.query(
          `UPDATE board_cards SET governance_mode='GOVERNED', governance_state='READY', governance_version=1,
             plan_epoch=1, accountable_role_id=$1, human_sponsor_user_id=$2, definition_of_done=$3,
             review_policy=$4::jsonb, budget_account_id=$5, governance_deadline=$6, active_plan_id=$7,
             delivery_gate=$8, updated_at=NOW() WHERE id=$9`,
          [roleId, userId, definition, JSON.stringify(reviewPolicy), budgetId, deadline, planId, deliveryGate, cardId],
        )
        const eventId = await event(client, { companyId, aggregateType: 'CARD', aggregateId: cardId, aggregateVersion: 1,
          eventType: 'CARD_GOVERNANCE_UPGRADED', actorType: 'HUMAN', actorId: userId, cardId, planEpoch: 1,
          mandateId, mandateVersion, idempotencyKey, payload: { roleId, agentId, planId, budgetId } })
        response = { cardId, governanceMode: 'GOVERNED', governanceState: 'READY', planEpoch: 1, planId, mandateId, mandateVersion, eventId }
        await client.query(`INSERT INTO governance_idempotency (company_id,actor_type,actor_id,command_name,idempotency_key,request_hash,result,event_id) VALUES ($1,'HUMAN',$2,'upgrade_card_governance',$3,$4,$5::jsonb,$6)`, [companyId, userId, idempotencyKey, requestHash, JSON.stringify(response), eventId])
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
      res.status(201).json(response)
    } catch (error) { errorResponse(res, error) }
  })

  router.post('/mandates/:mandateId/:operation', async (req, res) => {
    try {
      const { userId, companyId } = await deps.requireCompany(req as Request & AuthedRequest)
      const mandateId = id(req.params.mandateId, 'mandateId')
      const operation = req.params.operation
      if (!['suspend', 'revoke', 'activate'].includes(operation)) throw new GovernanceError(400, 'INVALID_OPERATION', 'unsupported mandate operation')
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const { rows } = await client.query<any>(`SELECT * FROM governance_mandates WHERE id=$1 AND company_id=$2 FOR UPDATE`, [mandateId, companyId])
        const m = rows[0]
        if (!m) throw new GovernanceError(404, 'MANDATE_NOT_FOUND', 'mandate not found')
        await primaryAssignment(client, companyId, m.role_id, userId)
        const next = operation === 'suspend' ? 'SUSPENDED' : operation === 'revoke' ? 'REVOKED' : 'ACTIVE'
        if (operation === 'activate' && m.status !== 'SUSPENDED' && m.status !== 'DRAFT') throw new GovernanceError(409, 'INVALID_TRANSITION', 'mandate cannot be activated')
        if (operation === 'revoke' && ['REVOKED', 'EXPIRED'].includes(m.status)) throw new GovernanceError(409, 'ALREADY_TERMINAL', 'mandate is already terminal')
        await client.query(`UPDATE governance_mandates SET status=$1,state_version=state_version+1,updated_at=NOW() WHERE id=$2 AND company_id=$3`, [next, mandateId, companyId])
        const eventId = await event(client, { companyId, aggregateType: 'MANDATE', aggregateId: mandateId, aggregateVersion: m.state_version + 1,
          eventType: `MANDATE_${operation.toUpperCase()}`, actorType: 'HUMAN', actorId: userId, mandateId, mandateVersion: m.mandate_version,
          cardId: m.card_id, payload: { from: m.status, to: next } })
        await client.query('COMMIT')
        res.json({ id: mandateId, status: next, eventId })
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
    } catch (error) { errorResponse(res, error) }
  })

  router.post('/cards/:cardId/:operation', async (req, res, next) => {
    const operation = req.params.operation
    if (!['pause', 'resume', 'cancel', 'archive'].includes(operation)) { next(); return }
    try {
      const { userId, companyId } = await deps.requireCompany(req as Request & AuthedRequest); const cardId = id(req.params.cardId, 'cardId'); const client = await pool.connect()
      const expectedVersion = int(req.body?.expectedVersion, 'expectedVersion'); const expectedEpoch = int(req.body?.expectedEpoch, 'expectedEpoch', 1)
      try {
        await client.query('BEGIN'); const c = await card(client, companyId, cardId, true)
        if (c.governance_mode !== 'GOVERNED') throw new GovernanceError(409, 'GOVERNANCE_REQUIRED', 'card is not governed')
        if (c.governance_version !== expectedVersion) throw new GovernanceError(409, 'VERSION_CONFLICT', 'card version changed')
        if (c.plan_epoch !== expectedEpoch) throw new GovernanceError(409, 'STALE_EPOCH', 'card plan epoch changed')
        await primaryAssignment(client, companyId, c.accountable_role_id, userId)
        let nextState = c.governance_state
        if (operation === 'pause') {
          if (!['READY','IN_PROGRESS','IN_REVIEW'].includes(c.governance_state)) throw new GovernanceError(409, 'INVALID_TRANSITION', 'card cannot be paused')
          nextState = 'PAUSED'
          await client.query(`UPDATE governance_action_attempts SET state='STOPPING',version=version+1 WHERE action_id IN (SELECT id FROM governance_actions WHERE card_id=$1 AND plan_epoch=$2) AND state IN ('RUNNING','WAITING_HUMAN')`, [cardId, c.plan_epoch])
        } else if (operation === 'resume') {
          if (c.governance_state !== 'PAUSED') throw new GovernanceError(409, 'INVALID_TRANSITION', 'card is not paused')
          const paused = (await client.query<any>(`SELECT payload->>'from' AS previous FROM governance_events WHERE company_id=$1 AND card_id=$2 AND event_type='CARD_PAUSED' ORDER BY occurred_at DESC,id DESC LIMIT 1`, [companyId, cardId])).rows[0]
          nextState = ['READY','IN_PROGRESS','IN_REVIEW'].includes(paused?.previous) ? paused.previous : 'READY'
        } else if (operation === 'cancel') {
          if (!['READY','IN_PROGRESS','IN_REVIEW','PAUSED'].includes(c.governance_state)) throw new GovernanceError(409, 'INVALID_TRANSITION', 'card cannot be cancelled')
          nextState = 'CANCELLED'
          await client.query(`UPDATE governance_actions SET state='CANCELLED',terminal_reason=$1,version=version+1,updated_at=NOW() WHERE card_id=$2 AND plan_epoch=$3 AND state NOT IN ('COMPLETED','CANCELLED','SUPERSEDED','FAILED')`, [text(req.body?.reason, 1000) || 'card cancelled', cardId, c.plan_epoch])
          await client.query(`UPDATE governance_action_attempts SET state='CANCELLED',ended_at=NOW(),version=version+1 WHERE action_id IN (SELECT id FROM governance_actions WHERE card_id=$1 AND plan_epoch=$2) AND state IN ('RUNNING','WAITING_HUMAN','STOPPING')`, [cardId, c.plan_epoch])
        } else {
          if (!['DONE','CANCELLED'].includes(c.governance_state)) throw new GovernanceError(409, 'INVALID_TRANSITION', 'only terminal cards can be archived')
          const pending = await client.query(`SELECT 1 FROM governance_operations WHERE card_id=$1 AND state IN ('PREPARED','DISPATCHED','UNKNOWN') LIMIT 1`, [cardId]); if (pending.rows[0]) throw new GovernanceError(409, 'OPERATION_PENDING', 'pending operation prevents archive')
          await client.query(`UPDATE board_cards SET archived_at=NOW(),governance_version=governance_version+1,updated_at=NOW() WHERE id=$1`, [cardId])
        }
        if (operation !== 'archive') await client.query(`UPDATE board_cards SET governance_state=$1,governance_version=governance_version+1,updated_at=NOW() WHERE id=$2`, [nextState, cardId])
        const eventId = await event(client, { companyId, aggregateType: 'CARD', aggregateId: cardId, aggregateVersion: c.governance_version + 1, eventType: `CARD_${operation.toUpperCase()}${operation === 'resume' ? 'D' : operation === 'cancel' ? 'LED' : operation === 'archive' ? 'D' : 'D'}`, actorType: 'HUMAN', actorId: userId, cardId, planEpoch: c.plan_epoch, payload: { from: c.governance_state, to: nextState, reason: text(req.body?.reason, 1000) } })
        await client.query('COMMIT'); res.json({ cardId, state: nextState, archived: operation === 'archive', version: c.governance_version + 1, eventId })
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    } catch (e) { errorResponse(res, e) }
  })

  router.post('/cards/:cardId/plans/activate', async (req, res) => {
    try {
      const { userId, companyId } = await deps.requireCompany(req as Request & AuthedRequest); const cardId = id(req.params.cardId, 'cardId'); const expectedVersion = int(req.body?.expectedVersion, 'expectedVersion'); const expectedEpoch = int(req.body?.expectedEpoch, 'expectedEpoch', 1); const reason = text(req.body?.reason, 2000); if (!reason) throw new GovernanceError(400, 'REASON_REQUIRED', 'plan activation reason is required'); const client = await pool.connect()
      try {
        await client.query('BEGIN'); const c = await card(client, companyId, cardId, true); if (c.governance_mode !== 'GOVERNED') throw new GovernanceError(409, 'GOVERNANCE_REQUIRED', 'card is not governed'); if (c.governance_version !== expectedVersion) throw new GovernanceError(409, 'VERSION_CONFLICT', 'card version changed'); if (c.plan_epoch !== expectedEpoch) throw new GovernanceError(409, 'STALE_EPOCH', 'card epoch changed'); if (c.governance_state === 'CANCELLED') throw new GovernanceError(409, 'CARD_TERMINAL', 'cancelled cards cannot be reopened')
        const assignment = await primaryAssignment(client, companyId, c.accountable_role_id, userId); const currentMandate = (await client.query<any>(`SELECT * FROM governance_mandates WHERE company_id=$1 AND card_id=$2 ORDER BY mandate_version DESC LIMIT 1 FOR UPDATE`, [companyId, cardId])).rows[0]; if (!currentMandate) throw new GovernanceError(409, 'MANDATE_REQUIRED', 'card has no mandate')
        const epoch = c.plan_epoch + 1; const planId = `plan-${randomUUID().slice(0, 12)}`; const definition = text(req.body?.definitionOfDone, 8000) || c.definition_of_done; const deadline = iso(req.body?.deadline, 'deadline', false) ?? c.governance_deadline
        await client.query(`UPDATE governance_card_plans SET state='SUPERSEDED',updated_at=NOW() WHERE card_id=$1 AND state='ACTIVE'`, [cardId])
        await client.query(`INSERT INTO governance_card_plans (id,company_id,card_id,version,epoch,goal,definition_of_done,input_version_refs,steps,action_specs,budget_allocation,deadline,risk_summary,review_policy,shipping_contract_revision,created_by,approved_by,state)
          VALUES ($1,$2,$3,$4,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13::jsonb,$14,$15,$15,'ACTIVE')`, [planId, companyId, cardId, epoch, text(req.body?.goal, 4000) || c.title, definition, JSON.stringify(req.body?.inputVersionRefs ?? []), JSON.stringify(req.body?.steps ?? []), JSON.stringify(req.body?.actionSpecs ?? []), JSON.stringify(req.body?.budgetAllocation ?? {}), deadline, text(req.body?.riskSummary, 4000), JSON.stringify(req.body?.reviewPolicy ?? c.review_policy), req.body?.shippingContractRevision ?? null, userId])
        await client.query(`UPDATE governance_actions SET state='SUPERSEDED',terminal_reason=$1,version=version+1,updated_at=NOW() WHERE card_id=$2 AND plan_epoch=$3 AND state NOT IN ('COMPLETED','CANCELLED','SUPERSEDED','FAILED')`, [reason, cardId, c.plan_epoch])
        await client.query(`UPDATE governance_action_attempts SET state='CANCELLED',ended_at=NOW(),version=version+1 WHERE action_id IN (SELECT id FROM governance_actions WHERE card_id=$1 AND plan_epoch=$2) AND state IN ('RUNNING','WAITING_HUMAN','STOPPING')`, [cardId, c.plan_epoch])
        await client.query(`UPDATE governance_approvals SET state='INVALIDATED',version=version+1 WHERE card_id=$1 AND plan_epoch=$2 AND state IN ('PENDING','APPROVED')`, [cardId, c.plan_epoch]); await client.query(`UPDATE governance_interventions SET state='INVALIDATED',version=version+1 WHERE card_id=$1 AND plan_epoch=$2 AND state='OPEN'`, [cardId, c.plan_epoch]); await client.query(`UPDATE governance_submissions SET state='SUPERSEDED',version=version+1 WHERE card_id=$1 AND plan_epoch=$2 AND state='PENDING_REVIEW'`, [cardId, c.plan_epoch])
        await client.query(`UPDATE governance_mandates SET status='REVOKED',state_version=state_version+1,updated_at=NOW() WHERE id=$1 AND mandate_version=$2`, [currentMandate.id, currentMandate.mandate_version]); const nextMandateVersion = currentMandate.mandate_version + 1
        await client.query(`INSERT INTO governance_mandates (id,mandate_version,company_id,card_id,role_id,sponsor_user_id,sponsor_assignment_id,agent_id,grants,data_resource_ids,tool_ids,budget_account_id,budget_limit_microusd,model_call_limit,valid_from,valid_until,max_delegation_depth,allowed_delegatee_ids,autonomy_policy,policy_version,status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,NOW(),$15,$16,$17::jsonb,$18::jsonb,$19,'ACTIVE')`, [currentMandate.id, nextMandateVersion, companyId, cardId, c.accountable_role_id, userId, assignment.id, currentMandate.agent_id, JSON.stringify(currentMandate.grants), JSON.stringify(currentMandate.data_resource_ids), JSON.stringify(currentMandate.tool_ids), currentMandate.budget_account_id, currentMandate.budget_limit_microusd, currentMandate.model_call_limit, deadline, currentMandate.max_delegation_depth, JSON.stringify(currentMandate.allowed_delegatee_ids), JSON.stringify(currentMandate.autonomy_policy), currentMandate.policy_version])
        await client.query(`UPDATE board_cards SET governance_state='READY',governance_version=governance_version+1,plan_epoch=$1,active_plan_id=$2,accepted_submission_id=NULL,definition_of_done=$3,review_policy=$4::jsonb,governance_deadline=$5,updated_at=NOW() WHERE id=$6`, [epoch, planId, definition, JSON.stringify(req.body?.reviewPolicy ?? c.review_policy), deadline, cardId])
        const eventId = await event(client, { companyId, aggregateType: 'CARD', aggregateId: cardId, aggregateVersion: c.governance_version + 1, eventType: 'CARD_PLAN_ACTIVATED', actorType: 'HUMAN', actorId: userId, cardId, planEpoch: epoch, mandateId: currentMandate.id, mandateVersion: nextMandateVersion, payload: { previousEpoch: c.plan_epoch, planId, reason } }); await client.query('COMMIT'); res.status(201).json({ cardId, state: 'READY', version: c.governance_version + 1, planEpoch: epoch, planId, mandateId: currentMandate.id, mandateVersion: nextMandateVersion, eventId })
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    } catch (e) { errorResponse(res, e) }
  })

  router.post('/cards/:cardId/mandates', async (req, res) => {
    try {
      const { userId, companyId } = await deps.requireCompany(req as Request & AuthedRequest); const cardId = id(req.params.cardId, 'cardId'); const agentId = id(req.body?.agentId, 'agentId')
      const expectedVersion = int(req.body?.expectedVersion, 'expectedVersion'); const expectedEpoch = int(req.body?.expectedEpoch, 'expectedEpoch', 1)
      const requestedGrants = grants(req.body?.grants ?? []); const deadline = iso(req.body?.validUntil, 'validUntil')!
      const client = await pool.connect()
      try {
        await client.query('BEGIN'); const c = await card(client, companyId, cardId, true)
        if (c.governance_mode !== 'GOVERNED') throw new GovernanceError(409, 'GOVERNANCE_REQUIRED', 'card is not governed')
        if (c.governance_version !== expectedVersion) throw new GovernanceError(409, 'VERSION_CONFLICT', 'card version changed')
        if (c.plan_epoch !== expectedEpoch) throw new GovernanceError(409, 'STALE_EPOCH', 'card epoch changed')
        const assignment = await primaryAssignment(client, companyId, c.accountable_role_id, userId)
        const role = (await client.query<any>(`SELECT * FROM governance_roles WHERE id=$1 AND company_id=$2 AND status='ACTIVE'`, [c.accountable_role_id, companyId])).rows[0]
        if (!subset(requestedGrants, role.grantable_grants ?? [])) throw new GovernanceError(403, 'GRANT_NOT_ALLOWED', 'mandate exceeds role grantable scope')
        if (!(await client.query(`SELECT 1 FROM participants WHERE id=$1 AND company_id=$2 AND kind='agent' AND departed_at IS NULL`, [agentId, companyId])).rows[0]) throw new GovernanceError(404, 'AGENT_NOT_FOUND', 'agent not found or inactive')
        if (deadline > new Date(c.governance_deadline)) throw new GovernanceError(409, 'MANDATE_DEADLINE_EXCEEDED', 'mandate cannot outlive the card deadline')
        const budget = (await client.query<any>('SELECT * FROM governance_budget_accounts WHERE id=$1 AND company_id=$2 FOR SHARE', [c.budget_account_id, companyId])).rows[0]
        const mandateId = `mandate-${randomUUID().slice(0, 12)}`
        await client.query(`INSERT INTO governance_mandates (id,mandate_version,company_id,card_id,role_id,sponsor_user_id,sponsor_assignment_id,agent_id,grants,data_resource_ids,tool_ids,budget_account_id,budget_limit_microusd,model_call_limit,valid_from,valid_until,max_delegation_depth,allowed_delegatee_ids,autonomy_policy,status)
          VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,NOW(),$14,$15,$16::jsonb,$17::jsonb,'ACTIVE')`, [mandateId, companyId, cardId, c.accountable_role_id, userId, assignment.id, agentId, JSON.stringify(requestedGrants), JSON.stringify(req.body?.dataResourceIds ?? []), JSON.stringify(req.body?.toolIds ?? []), budget.id, budget.limit_microusd, budget.model_call_limit, deadline, int(req.body?.maxDelegationDepth ?? 0, 'maxDelegationDepth', 0, 1), JSON.stringify(req.body?.allowedDelegateeIds ?? []), JSON.stringify(req.body?.autonomyPolicy ?? {})])
        await client.query('UPDATE board_cards SET governance_version=governance_version+1,updated_at=NOW() WHERE id=$1', [cardId])
        const eventId = await event(client, { companyId, aggregateType: 'MANDATE', aggregateId: mandateId, aggregateVersion: 1, eventType: 'MANDATE_ACTIVATED', actorType: 'HUMAN', actorId: userId, actingRoleId: c.accountable_role_id, sponsorUserId: userId, sponsorAssignmentId: assignment.id, mandateId, mandateVersion: 1, cardId, planEpoch: c.plan_epoch, payload: { agentId, grants: requestedGrants } })
        await client.query('COMMIT'); res.status(201).json({ id: mandateId, mandateVersion: 1, agentId, cardId, planEpoch: c.plan_epoch, cardVersion: c.governance_version + 1, eventId })
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    } catch (e) { errorResponse(res, e) }
  })

  router.post('/cards/:cardId/claim', async (req, res) => {
    try {
      const { companyId } = await deps.requireCompany(req as Request & AuthedRequest); const cardId = id(req.params.cardId, 'cardId'); const agentId = id(req.body?.agentId, 'agentId'); const expectedEpoch = int(req.body?.expectedEpoch, 'expectedEpoch', 1); const client = await pool.connect()
      try { await client.query('BEGIN'); const c = await card(client, companyId, cardId, true); if (c.governance_mode !== 'GOVERNED' || !['READY','IN_PROGRESS'].includes(c.governance_state)) throw new GovernanceError(409, 'CARD_NOT_CLAIMABLE', 'card is not claimable'); if (c.plan_epoch !== expectedEpoch) throw new GovernanceError(409, 'STALE_EPOCH', 'card epoch changed'); await mandate(client, companyId, id(req.body?.mandateId, 'mandateId'), agentId, true); const current = (await client.query<any>(`SELECT * FROM governance_card_claims WHERE card_id=$1 AND released_at IS NULL FOR UPDATE`, [cardId])).rows[0]; if (current && new Date(current.lease_expires_at).getTime() > Date.now()) throw new GovernanceError(409, 'CARD_ALREADY_CLAIMED', 'card already has an active claim'); let generation = 1; if (current) { generation = current.generation + 1; await client.query(`UPDATE governance_card_claims SET released_at=NOW(),version=version+1 WHERE id=$1`, [current.id]) } const claimId = `claim-${randomUUID().slice(0, 12)}`; await client.query(`INSERT INTO governance_card_claims (id,company_id,card_id,holder_type,holder_id,lease_expires_at,generation) VALUES ($1,$2,$3,'AGENT',$4,NOW()+INTERVAL '5 minutes',$5)`, [claimId, companyId, cardId, agentId, generation]); await client.query('COMMIT'); res.status(201).json({ id: claimId, cardId, holderId: agentId, generation }) } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    } catch (e) { errorResponse(res, e) }
  })

  router.post('/claims/:claimId/renew', async (req, res) => {
    try { const { companyId } = await deps.requireCompany(req as Request & AuthedRequest); const claimId = id(req.params.claimId, 'claimId'); const generation = int(req.body?.generation, 'generation', 1); const renewed = await pool.query<any>(`UPDATE governance_card_claims cl SET lease_expires_at=NOW()+INTERVAL '5 minutes',version=version+1 FROM board_cards c WHERE cl.id=$1 AND cl.company_id=$2 AND cl.generation=$3 AND cl.released_at IS NULL AND cl.lease_expires_at>NOW() AND c.id=cl.card_id AND c.governance_state IN ('READY','IN_PROGRESS') RETURNING cl.*`, [claimId, companyId, generation]); if (!renewed.rows[0]) throw new GovernanceError(409, 'CLAIM_INVALID', 'claim is stale or expired'); res.json({ id: claimId, generation, leaseExpiresAt: renewed.rows[0].lease_expires_at }) } catch (e) { errorResponse(res, e) }
  })

  router.post('/claims/:claimId/release', async (req, res) => {
    try { const { companyId } = await deps.requireCompany(req as Request & AuthedRequest); const claimId = id(req.params.claimId, 'claimId'); const generation = int(req.body?.generation, 'generation', 1); const released = await pool.query(`UPDATE governance_card_claims SET released_at=NOW(),version=version+1 WHERE id=$1 AND company_id=$2 AND generation=$3 AND released_at IS NULL`, [claimId, companyId, generation]); if (!released.rowCount) throw new GovernanceError(409, 'CLAIM_INVALID', 'claim is stale or already released'); res.json({ id: claimId, released: true }) } catch (e) { errorResponse(res, e) }
  })

  router.post('/cards/:cardId/actions', async (req, res) => {
    try {
      const { userId, companyId } = await deps.requireCompany(req as Request & AuthedRequest)
      const cardId = id(req.params.cardId, 'cardId')
      const agentId = id(req.body?.agentId, 'agentId')
      const objective = text(req.body?.objective, 8000)
      if (!objective) throw new GovernanceError(400, 'OBJECTIVE_REQUIRED', 'objective is required')
      const purpose = ['PRODUCE', 'COORDINATE', 'VERIFY'].includes(req.body?.purpose) ? req.body.purpose : 'PRODUCE'
      const requestedGrants = grants(req.body?.grants ?? [])
      const expectedVersion = int(req.body?.expectedVersion, 'expectedVersion')
      const expectedEpoch = int(req.body?.expectedEpoch, 'expectedEpoch', 1)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const c = await card(client, companyId, cardId, true)
        if (c.governance_version !== expectedVersion) throw new GovernanceError(409, 'VERSION_CONFLICT', 'card version changed')
        if (c.plan_epoch !== expectedEpoch) throw new GovernanceError(409, 'STALE_EPOCH', 'card plan epoch changed')
        if (c.governance_mode !== 'GOVERNED') throw new GovernanceError(409, 'GOVERNANCE_REQUIRED', 'card is not governed')
        if (!['READY', 'IN_PROGRESS'].includes(c.governance_state)) throw new GovernanceError(409, 'CARD_NOT_EXECUTABLE', 'card is not executable in its current state')
        const m = await mandate(client, companyId, id(req.body?.mandateId, 'mandateId'), agentId, true)
        if (m.card_id !== cardId || m.mandate_version !== int(req.body?.mandateVersion ?? m.mandate_version, 'mandateVersion', 1)) throw new GovernanceError(409, 'MANDATE_MISMATCH', 'mandate does not match this card')
        if (!subset(requestedGrants, m.grants ?? [])) throw new GovernanceError(403, 'MANDATE_SCOPE_EXCEEDED', 'action grants exceed the receiving agent mandate')
        const parent = req.body?.parentActionId ? await client.query<any>(`SELECT * FROM governance_actions WHERE id=$1 AND company_id=$2 FOR UPDATE`, [id(req.body.parentActionId, 'parentActionId'), companyId]) : null
        if (parent && !parent.rows[0]) throw new GovernanceError(404, 'PARENT_ACTION_NOT_FOUND', 'parent action not found')
        if (parent) {
          if (parent.rows[0].card_id !== cardId || parent.rows[0].plan_epoch !== c.plan_epoch) throw new GovernanceError(409, 'STALE_EPOCH', 'parent action is from an old epoch')
          if (parent.rows[0].remaining_delegation_depth <= 0) throw new GovernanceError(403, 'DELEGATION_DENIED', 'delegation depth is exhausted')
          if (!subset(requestedGrants, parent.rows[0].permission_snapshot)) throw new GovernanceError(403, 'GRANT_NOT_ATTENUATED', 'child grants exceed parent grants')
          if (Array.isArray(m.allowed_delegatee_ids) && m.allowed_delegatee_ids.length > 0 && !m.allowed_delegatee_ids.includes(agentId)) throw new GovernanceError(403, 'DELEGATEE_DENIED', 'agent is not an allowed delegatee')
        }
        const agent = await client.query(`SELECT id FROM participants WHERE id=$1 AND company_id=$2 AND kind='agent' AND departed_at IS NULL`, [agentId, companyId])
        if (!agent.rows[0]) throw new GovernanceError(404, 'AGENT_NOT_FOUND', 'agent not found')
        const actionId = `act-${randomUUID().slice(0, 12)}`
        const depth = parent ? 0 : Math.min(1, Number(m.max_delegation_depth))
        let actionBudgetId = m.budget_account_id
        if (parent) {
          const amount = int(req.body?.budgetMicrousd, 'budgetMicrousd')
          const calls = int(req.body?.modelCallLimit, 'modelCallLimit')
          const parentBudget = (await client.query<any>('SELECT * FROM governance_budget_accounts WHERE id=$1 AND company_id=$2 FOR UPDATE', [parent.rows[0].budget_account_id, companyId])).rows[0]
          if (!parentBudget || BigInt(parentBudget.spent_microusd) + BigInt(parentBudget.reserved_microusd) + BigInt(amount) > BigInt(parentBudget.limit_microusd) || Number(parentBudget.model_calls_spent) + Number(parentBudget.model_calls_reserved) + calls > Number(parentBudget.model_call_limit)) throw new GovernanceError(409, 'BUDGET_EXCEEDED', 'child allocation exceeds parent remaining budget')
          actionBudgetId = `gbudget-${randomUUID().slice(0, 12)}`
          await client.query(`INSERT INTO governance_budget_accounts (id,company_id,card_id,parent_account_id,limit_microusd,model_call_limit) VALUES ($1,$2,$3,$4,$5,$6)`, [actionBudgetId, companyId, cardId, parentBudget.id, amount, calls])
          await client.query(`UPDATE governance_budget_accounts SET reserved_microusd=reserved_microusd+$1,model_calls_reserved=model_calls_reserved+$2,version=version+1,updated_at=NOW() WHERE id=$3`, [amount, calls, parentBudget.id])
          await client.query(`INSERT INTO governance_budget_reservations (id,company_id,parent_account_id,child_account_id,amount_microusd,model_calls) VALUES ($1,$2,$3,$4,$5,$6)`, [`bres-${randomUUID().slice(0, 12)}`, companyId, parentBudget.id, actionBudgetId, amount, calls])
        }
        await client.query(
          `INSERT INTO governance_actions
             (id,company_id,card_id,plan_epoch,parent_action_id,purpose,objective,input_version_refs,
              expected_output,definition_of_done,permission_snapshot,authorization_chain_refs,budget_account_id,
              deadline,remaining_delegation_depth,assigned_agent_id,state,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'[]'::jsonb,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,'READY',$16)`,
          [actionId, companyId, cardId, c.plan_epoch, parent?.rows[0]?.id ?? null, purpose, objective,
            text(req.body?.expectedOutput, 4000) || null, text(req.body?.definitionOfDone, 8000) || c.definition_of_done,
            JSON.stringify(requestedGrants), JSON.stringify([{ mandateId: m.id, mandateVersion: m.mandate_version }]),
            actionBudgetId, m.valid_until, depth, agentId, userId],
        )
        if (parent) await client.query(`UPDATE governance_budget_reservations SET action_id=$1 WHERE child_account_id=$2 AND action_id IS NULL`, [actionId, actionBudgetId])
        await event(client, { companyId, aggregateType: 'ACTION', aggregateId: actionId, aggregateVersion: 1,
          eventType: parent ? 'CHILD_ACTION_CREATED' : 'ACTION_CREATED', actorType: 'HUMAN', actorId: userId,
          cardId, actionId, mandateId: m.id, mandateVersion: m.mandate_version, planEpoch: c.plan_epoch, payload: { parentActionId: parent?.rows[0]?.id ?? null } })
        await client.query(`UPDATE board_cards SET governance_state='IN_PROGRESS', governance_version=governance_version+1, updated_at=NOW() WHERE id=$1`, [cardId])
        await client.query('COMMIT')
        res.status(201).json({ id: actionId, cardId, planEpoch: c.plan_epoch, state: 'READY', assignedAgentId: agentId })
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
    } catch (error) { errorResponse(res, error) }
  })

  router.post('/actions/:actionId/cancel', async (req, res) => {
    try {
      const { userId, companyId } = await deps.requireCompany(req as Request & AuthedRequest)
      const actionId = id(req.params.actionId, 'actionId')
      const client = await pool.connect(); try { await client.query('BEGIN'); const { rows } = await client.query<any>(`SELECT * FROM governance_actions WHERE id=$1 AND company_id=$2 FOR UPDATE`, [actionId, companyId]); const a = rows[0]; if (!a) throw new GovernanceError(404, 'ACTION_NOT_FOUND', 'action not found'); if (!STATES.has(a.state) || ['COMPLETED', 'CANCELLED', 'SUPERSEDED', 'FAILED'].includes(a.state)) throw new GovernanceError(409, 'ACTION_TERMINAL', 'action is terminal'); await client.query(`UPDATE governance_actions SET state='CANCELLED', version=version+1, terminal_reason=$1, updated_at=NOW() WHERE id=$2`, [text(req.body?.reason, 1000) || 'cancelled by human', actionId]); await client.query(`UPDATE governance_action_attempts SET state='CANCELLED',ended_at=NOW(),version=version+1 WHERE action_id=$1 AND state IN ('RUNNING','WAITING_HUMAN','STOPPING')`, [actionId]); const eventId = await event(client, { companyId, aggregateType: 'ACTION', aggregateId: actionId, aggregateVersion: a.version + 1, eventType: 'ACTION_CANCELLED', actorType: 'HUMAN', actorId: userId, cardId: a.card_id, actionId, planEpoch: a.plan_epoch, payload: { reason: text(req.body?.reason, 1000) } }); await client.query('COMMIT'); res.json({ id: actionId, state: 'CANCELLED', cancelledBy: userId, eventId }) } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    } catch (error) { errorResponse(res, error) }
  })

  router.post('/actions/:actionId/attempts', async (req, res) => {
    try {
      const { companyId } = await deps.requireCompany(req as Request & AuthedRequest)
      const actionId = id(req.params.actionId, 'actionId'); const runtimeAssignmentId = id(req.body?.runtimeAssignmentId, 'runtimeAssignmentId')
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const a = (await client.query<any>('SELECT * FROM governance_actions WHERE id=$1 AND company_id=$2 FOR UPDATE', [actionId, companyId])).rows[0]
        if (!a) throw new GovernanceError(404, 'ACTION_NOT_FOUND', 'action not found')
        if (a.plan_epoch !== int(req.body?.planEpoch, 'planEpoch', 1)) throw new GovernanceError(409, 'STALE_EPOCH', 'action belongs to an old plan epoch')
        if (a.state === 'RUNNING') {
          const expired = (await client.query<any>(`SELECT * FROM governance_action_attempts WHERE action_id=$1 AND state IN ('RUNNING','WAITING_HUMAN','STOPPING') AND lease_expires_at<=NOW() FOR UPDATE`, [actionId])).rows[0]
          if (expired) { await client.query(`UPDATE governance_action_attempts SET state='LOST',ended_at=NOW(),version=version+1 WHERE id=$1`, [expired.id]); a.state = 'READY' }
        }
        if (a.state !== 'READY') throw new GovernanceError(409, 'ACTION_NOT_READY', 'action is not ready')
        const m = await mandate(client, companyId, id(req.body?.mandateId, 'mandateId'), a.assigned_agent_id, true)
        if (m.mandate_version !== int(req.body?.mandateVersion, 'mandateVersion', 1)) throw new GovernanceError(409, 'MANDATE_MISMATCH', 'mandate version mismatch')
        if (!a.parent_action_id) {
          const claim = (await client.query(`SELECT 1 FROM governance_card_claims WHERE card_id=$1 AND holder_type='AGENT' AND holder_id=$2 AND released_at IS NULL AND lease_expires_at>NOW() FOR UPDATE`, [a.card_id, a.assigned_agent_id])).rows[0]
          if (!claim) throw new GovernanceError(409, 'CLAIM_REQUIRED', 'root action requires an active card claim')
        }
        const { resolveAgentHost, isByoaKind } = await import('../agents/computer/registry.js')
        const placement = await resolveAgentHost(a.assigned_agent_id, client)
        if (placement.status !== 'found' || placement.tier === 'free' || isByoaKind(placement.kind)) throw new GovernanceError(409, 'RUNTIME_NOT_GOVERNANCE_CAPABLE', 'governed execution requires paid managed-cloud placement with hard budget support')
        const runtime = (await client.query<any>(`SELECT p.runtime_assignment_id,p.engine,c.kind AS computer_kind,c.revoked_at
          FROM participants p LEFT JOIN computers c ON c.id=p.computer_id AND c.company_id=p.company_id
          WHERE p.id=$1 AND p.company_id=$2`, [a.assigned_agent_id, companyId])).rows[0]
        if (!runtime || runtime.runtime_assignment_id !== runtimeAssignmentId || (runtime.computer_kind && runtime.computer_kind !== 'cloud') || (runtime.engine && runtime.engine !== 'managed') || runtime.revoked_at) throw new GovernanceError(409, 'RUNTIME_NOT_GOVERNANCE_CAPABLE', 'runtime cannot provide governed isolation and budget guarantees')
        const attemptId = `attempt-${randomUUID().slice(0, 12)}`
        const leaseGeneration = Number((await client.query(`SELECT COALESCE(MAX(lease_generation),0)+1 AS generation FROM governance_action_attempts WHERE action_id=$1`, [actionId])).rows[0].generation)
        await client.query(`INSERT INTO governance_action_attempts
          (id,company_id,action_id,agent_id,mandate_id,mandate_version,sponsor_user_id,sponsor_assignment_id,runtime_assignment_id,runtime_ref,model_ref,lease_generation,lease_expires_at,last_heartbeat_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW()+INTERVAL '5 minutes',NOW())`,
          [attemptId, companyId, actionId, a.assigned_agent_id, m.id, m.mandate_version, m.sponsor_user_id, m.sponsor_assignment_id, runtimeAssignmentId, text(req.body?.runtimeRef, 500) || null, text(req.body?.modelRef, 500) || null, leaseGeneration])
        await client.query(`UPDATE governance_actions SET state='RUNNING',active_attempt_id=$2,version=version+1,updated_at=NOW() WHERE id=$1`, [actionId, attemptId])
        await event(client, { companyId, aggregateType: 'ACTION', aggregateId: actionId, aggregateVersion: a.version + 1, eventType: 'ATTEMPT_STARTED', actorType: 'AGENT', actorId: a.assigned_agent_id, cardId: a.card_id, actionId, attemptId, mandateId: m.id, mandateVersion: m.mandate_version, planEpoch: a.plan_epoch })
        await client.query('COMMIT')
        if (process.env.NODE_ENV !== 'test') void import('../agents/scheduler.js').then(({ wakeAgent }) => wakeAgent(a.assigned_agent_id, 'manual', null, null, {
          governanceAttemptId: attemptId,
          backgroundBrief: { title: `Governed action: ${a.objective}`, body: `Execute Action ${actionId} under Attempt ${attemptId}. Use only the granted scope and publish immutable evidence before finishing.`, source: 'governance.action' },
        })).catch((error) => console.warn('[governance] governed attempt wake failed', error instanceof Error ? error.message : error))
        res.status(201).json({ id: attemptId, actionId, state: 'RUNNING', planEpoch: a.plan_epoch, leaseGeneration })
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    } catch (e) { errorResponse(res, e) }
  })

  router.post('/attempts/:attemptId/heartbeat', async (req, res) => {
    try {
      const { companyId } = await deps.requireCompany(req as Request & AuthedRequest); const attemptId = id(req.params.attemptId, 'attemptId'); const generation = int(req.body?.leaseGeneration, 'leaseGeneration', 1)
      const result = await pool.query<any>(`UPDATE governance_action_attempts at SET last_heartbeat_at=NOW(),lease_expires_at=NOW()+INTERVAL '5 minutes',version=at.version+1
        FROM governance_actions a,board_cards c,governance_mandates m
        WHERE at.id=$1 AND at.company_id=$2 AND at.action_id=a.id AND a.card_id=c.id
          AND at.mandate_id=m.id AND at.mandate_version=m.mandate_version
          AND at.lease_generation=$3 AND at.state IN ('RUNNING','WAITING_HUMAN')
          AND c.plan_epoch=a.plan_epoch AND c.governance_state NOT IN ('PAUSED','CANCELLED','DONE')
          AND m.status='ACTIVE' AND m.valid_until>NOW()
          AND EXISTS (SELECT 1 FROM governance_role_assignments ra JOIN company_members cm ON cm.company_id=ra.company_id AND cm.user_id=ra.human_user_id WHERE ra.id=m.sponsor_assignment_id AND ra.status='ACTIVE' AND ra.assignment_type='PRIMARY' AND ra.valid_from<=NOW() AND (ra.valid_until IS NULL OR ra.valid_until>NOW()))
        RETURNING at.version,at.lease_expires_at`, [attemptId, companyId, generation])
      if (!result.rows[0]) throw new GovernanceError(409, 'LEASE_INVALID', 'attempt lease, mandate, or epoch is no longer valid')
      res.json({ id: attemptId, leaseGeneration: generation, version: result.rows[0].version, leaseExpiresAt: result.rows[0].lease_expires_at })
    } catch (e) { errorResponse(res, e) }
  })

  router.post('/attempts/:attemptId/finish', async (req, res) => {
    try {
      const { companyId } = await deps.requireCompany(req as Request & AuthedRequest); const attemptId = id(req.params.attemptId, 'attemptId'); const generation = int(req.body?.leaseGeneration, 'leaseGeneration', 1); const outcome = req.body?.outcome === 'SUCCEEDED' ? 'SUCCEEDED' : req.body?.outcome === 'CANCELLED' ? 'CANCELLED' : 'FAILED'; const client = await pool.connect()
      try { await client.query('BEGIN'); const at = (await client.query<any>(`SELECT at.*,a.card_id,a.plan_epoch,a.version AS action_version FROM governance_action_attempts at JOIN governance_actions a ON a.id=at.action_id WHERE at.id=$1 AND at.company_id=$2 FOR UPDATE OF at,a`, [attemptId, companyId])).rows[0]; if (!at) throw new GovernanceError(404, 'ATTEMPT_NOT_FOUND', 'attempt not found'); if (at.lease_generation !== generation || !['RUNNING','WAITING_HUMAN','STOPPING'].includes(at.state)) throw new GovernanceError(409, 'LEASE_INVALID', 'attempt is no longer executable'); const actionState = outcome === 'SUCCEEDED' ? 'COMPLETED' : outcome === 'CANCELLED' ? 'CANCELLED' : 'FAILED'; await client.query(`UPDATE governance_action_attempts SET state=$1,result_ref=$2,failure_class=$3,ended_at=NOW(),version=version+1 WHERE id=$4`, [outcome, text(req.body?.resultRef, 500) || null, outcome === 'FAILED' ? text(req.body?.failureClass, 200) || 'UNKNOWN' : null, attemptId]); await client.query(`UPDATE governance_actions SET state=$1,terminal_reason=$2,version=version+1,updated_at=NOW() WHERE id=$3`, [actionState, text(req.body?.reason, 1000) || null, at.action_id]); await event(client, { companyId, aggregateType: 'ACTION', aggregateId: at.action_id, aggregateVersion: at.action_version + 1, eventType: `ATTEMPT_${outcome}`, actorType: 'AGENT', actorId: at.agent_id, cardId: at.card_id, actionId: at.action_id, attemptId, mandateId: at.mandate_id, mandateVersion: at.mandate_version, planEpoch: at.plan_epoch }); await client.query('COMMIT'); res.json({ id: attemptId, state: outcome, actionState }) } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    } catch (e) { errorResponse(res, e) }
  })

  router.post('/actions/:actionId/reserve-budget', async (req, res) => {
    try {
      const { userId, companyId } = await deps.requireCompany(req as Request & AuthedRequest); const actionId = id(req.params.actionId, 'actionId')
      const amount = int(req.body?.amountMicrousd ?? 0, 'amountMicrousd'); const calls = int(req.body?.modelCalls ?? 0, 'modelCalls'); const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const a = (await client.query<any>('SELECT * FROM governance_actions WHERE id=$1 AND company_id=$2 FOR UPDATE', [actionId, companyId])).rows[0]; if (!a) throw new GovernanceError(404, 'ACTION_NOT_FOUND', 'action not found')
        const b = (await client.query<any>('SELECT * FROM governance_budget_accounts WHERE id=$1 AND company_id=$2 FOR UPDATE', [a.budget_account_id, companyId])).rows[0]; if (!b) throw new GovernanceError(404, 'BUDGET_NOT_FOUND', 'budget account not found')
        if (BigInt(b.spent_microusd) + BigInt(b.reserved_microusd) + BigInt(amount) > BigInt(b.limit_microusd) || Number(b.model_calls_spent) + Number(b.model_calls_reserved) + calls > Number(b.model_call_limit)) throw new GovernanceError(409, 'BUDGET_EXCEEDED', 'reservation exceeds available budget')
        const reservationId = `bres-${randomUUID().slice(0, 12)}`
        await client.query('INSERT INTO governance_budget_reservations (id,company_id,parent_account_id,action_id,amount_microusd,model_calls) VALUES ($1,$2,$3,$4,$5,$6)', [reservationId, companyId, b.id, actionId, amount, calls])
        await client.query(`UPDATE governance_budget_accounts SET reserved_microusd=reserved_microusd+$1,model_calls_reserved=model_calls_reserved+$2,version=version+1,updated_at=NOW() WHERE id=$3`, [amount, calls, b.id])
        await event(client, { companyId, aggregateType: 'ACTION', aggregateId: actionId, aggregateVersion: a.version, eventType: 'BUDGET_RESERVED', actorType: 'HUMAN', actorId: userId, cardId: a.card_id, actionId, planEpoch: a.plan_epoch, payload: { reservationId, amount, calls } })
        await client.query('COMMIT'); res.status(201).json({ id: reservationId, amountMicrousd: amount, modelCalls: calls, state: 'RESERVED' })
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    } catch (e) { errorResponse(res, e) }
  })

  router.post('/attempts/:attemptId/model-calls/authorize', async (req, res) => {
    try {
      const { companyId } = await deps.requireCompany(req as Request & AuthedRequest)
      const attemptId = id(req.params.attemptId, 'attemptId')
      const providerCallId = id(req.body?.providerCallId, 'providerCallId')
      const leaseGeneration = int(req.body?.leaseGeneration, 'leaseGeneration', 1)
      const model = id(req.body?.model, 'model')
      const maxInputTokens = int(req.body?.maxInputTokens, 'maxInputTokens')
      const maxOutputTokens = int(req.body?.maxOutputTokens, 'maxOutputTokens')
      const rate = priceFor(model)
      if (rate.verified !== true) throw new GovernanceError(409, 'UNVERIFIED_MODEL_RATE', 'governed model calls require an operator-supplied rate snapshot')
      const maxInputRate = Math.max(rate.inPer1M, rate.cachedInPer1M, rate.cacheWritePer1M)
      const amount = Math.ceil(maxInputTokens * maxInputRate + maxOutputTokens * rate.outPer1M)
      if (!Number.isSafeInteger(amount)) throw new GovernanceError(400, 'INVALID_NUMBER', 'maximum call cost is too large')
      const snapshot = { model, maxInputTokens, maxOutputTokens, ...rate }
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const duplicate = (await client.query<any>('SELECT * FROM governance_budget_reservations WHERE company_id=$1 AND provider_call_id=$2 FOR UPDATE', [companyId, providerCallId])).rows[0]
        if (duplicate) {
          const duplicateRate = duplicate.rate_snapshot as { model?: string; maxInputTokens?: number; maxOutputTokens?: number }
          if (duplicate.parent_account_id !== (await client.query<any>('SELECT a.budget_account_id FROM governance_action_attempts at JOIN governance_actions a ON a.id=at.action_id WHERE at.id=$1 AND at.company_id=$2', [attemptId, companyId])).rows[0]?.budget_account_id || duplicateRate.model !== model || duplicateRate.maxInputTokens !== maxInputTokens || duplicateRate.maxOutputTokens !== maxOutputTokens) throw new GovernanceError(409, 'IDEMPOTENCY_CONFLICT', 'providerCallId was used for a different model call')
          await client.query('COMMIT')
          res.json({ id: duplicate.id, providerCallId, amountMicrousd: Number(duplicate.amount_microusd), state: duplicate.state }); return
        }
        const at = (await client.query<any>(`SELECT at.*,a.card_id,a.plan_epoch,a.budget_account_id,c.plan_epoch AS current_epoch,c.governance_state,m.status AS mandate_status,m.valid_until
          FROM governance_action_attempts at JOIN governance_actions a ON a.id=at.action_id JOIN board_cards c ON c.id=a.card_id
          JOIN governance_mandates m ON m.id=at.mandate_id AND m.mandate_version=at.mandate_version
          WHERE at.id=$1 AND at.company_id=$2 FOR UPDATE OF at,a,c,m`, [attemptId, companyId])).rows[0]
        if (!at) throw new GovernanceError(404, 'ATTEMPT_NOT_FOUND', 'attempt not found')
        if (at.lease_generation !== leaseGeneration || !['RUNNING', 'WAITING_HUMAN'].includes(at.state) || (at.lease_expires_at && new Date(at.lease_expires_at) <= new Date()) || at.plan_epoch !== at.current_epoch || ['PAUSED', 'CANCELLED', 'DONE'].includes(at.governance_state) || at.mandate_status !== 'ACTIVE' || new Date(at.valid_until) <= new Date()) throw new GovernanceError(409, 'LEASE_INVALID', 'attempt, mandate, or epoch is no longer executable')
        const budget = (await client.query<any>('SELECT * FROM governance_budget_accounts WHERE id=$1 AND company_id=$2 FOR UPDATE', [at.budget_account_id, companyId])).rows[0]
        if (!budget || budget.status !== 'ACTIVE') throw new GovernanceError(409, 'BUDGET_UNAVAILABLE', 'budget account is not active')
        if (BigInt(budget.spent_microusd) + BigInt(budget.reserved_microusd) + BigInt(amount) > BigInt(budget.limit_microusd) || Number(budget.model_calls_spent) + Number(budget.model_calls_reserved) + 1 > Number(budget.model_call_limit)) throw new GovernanceError(409, 'BUDGET_EXCEEDED', 'model call exceeds the remaining hard budget')
        const reservationId = `bres-${randomUUID().slice(0, 12)}`
        await client.query(`INSERT INTO governance_budget_reservations (id,company_id,parent_account_id,action_id,amount_microusd,model_calls,provider_call_id,model_ref,rate_snapshot)
          VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8::jsonb)`, [reservationId, companyId, budget.id, at.action_id, amount, providerCallId, model, JSON.stringify(snapshot)])
        await client.query('UPDATE governance_budget_accounts SET reserved_microusd=reserved_microusd+$1,model_calls_reserved=model_calls_reserved+1,version=version+1,updated_at=NOW() WHERE id=$2', [amount, budget.id])
        await event(client, { companyId, aggregateType: 'BUDGET_RESERVATION', aggregateId: reservationId, aggregateVersion: 1, eventType: 'MODEL_CALL_AUTHORIZED', actorType: 'AGENT', actorId: at.agent_id, cardId: at.card_id, actionId: at.action_id, attemptId, mandateId: at.mandate_id, mandateVersion: at.mandate_version, planEpoch: at.plan_epoch, payload: { reservationId, providerCallId, model, amountMicrousd: amount } })
        await client.query('COMMIT')
        res.status(201).json({ id: reservationId, providerCallId, amountMicrousd: amount, state: 'RESERVED' })
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    } catch (e) { errorResponse(res, e) }
  })

  router.post('/attempts/:attemptId/model-calls/:providerCallId/settle', async (req, res) => {
    try {
      const { companyId } = await deps.requireCompany(req as Request & AuthedRequest)
      const attemptId = id(req.params.attemptId, 'attemptId'); const providerCallId = id(req.params.providerCallId, 'providerCallId')
      const usageCallId = id(req.body?.usageCallId, 'usageCallId')
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const reservation = (await client.query<any>(`SELECT r.*,at.agent_id,at.mandate_id,at.mandate_version,a.id AS bound_action_id,a.card_id,a.plan_epoch,a.version AS action_version
          FROM governance_budget_reservations r JOIN governance_actions a ON a.id=r.action_id JOIN governance_action_attempts at ON at.action_id=a.id
          WHERE r.company_id=$1 AND r.provider_call_id=$2 AND at.id=$3 FOR UPDATE OF r`, [companyId, providerCallId, attemptId])).rows[0]
        if (!reservation) throw new GovernanceError(404, 'RESERVATION_NOT_FOUND', 'model-call reservation not found')
        const usage = {
          inputTokens: int(req.body?.inputTokens ?? 0, 'inputTokens'), cachedInputTokens: int(req.body?.cachedInputTokens ?? 0, 'cachedInputTokens'),
          cacheCreationTokens: int(req.body?.cacheCreationTokens ?? 0, 'cacheCreationTokens'), outputTokens: int(req.body?.outputTokens ?? 0, 'outputTokens'),
        }
        const rate = reservation.rate_snapshot as { inPer1M: number; cachedInPer1M: number; cacheWritePer1M: number; outPer1M: number }
        const actual = Math.ceil(usage.inputTokens * rate.inPer1M + usage.cachedInputTokens * rate.cachedInPer1M + usage.cacheCreationTokens * rate.cacheWritePer1M + usage.outputTokens * rate.outPer1M)
        if (!Number.isSafeInteger(actual)) throw new GovernanceError(400, 'INVALID_NUMBER', 'actual call cost is too large')
        if (reservation.state === 'CONSUMED') {
          if (reservation.usage_call_id !== usageCallId || Number(reservation.actual_amount_microusd) !== actual) throw new GovernanceError(409, 'IDEMPOTENCY_CONFLICT', 'model call was already settled with different usage')
          await client.query('COMMIT'); res.json({ id: reservation.id, providerCallId, actualAmountMicrousd: actual, state: 'CONSUMED' }); return
        }
        if (reservation.state !== 'RESERVED') throw new GovernanceError(409, 'RESERVATION_NOT_ACTIVE', 'model-call reservation is not active')
        const budget = (await client.query<any>('SELECT * FROM governance_budget_accounts WHERE id=$1 AND company_id=$2 FOR UPDATE', [reservation.parent_account_id, companyId])).rows[0]
        const nextSpent = BigInt(budget.spent_microusd) + BigInt(actual)
        const freeze = nextSpent > BigInt(budget.limit_microusd) || Number(budget.model_calls_spent) + 1 > Number(budget.model_call_limit) || actual > Number(reservation.amount_microusd)
        await client.query(`UPDATE governance_budget_reservations SET state='CONSUMED',actual_amount_microusd=$1,usage_call_id=$2,settled_at=NOW() WHERE id=$3`, [actual, usageCallId, reservation.id])
        await client.query(`UPDATE governance_budget_accounts SET reserved_microusd=reserved_microusd-$1,model_calls_reserved=model_calls_reserved-1,spent_microusd=spent_microusd+$2,model_calls_spent=model_calls_spent+1,status=CASE WHEN $3 THEN 'FROZEN' ELSE status END,version=version+1,updated_at=NOW() WHERE id=$4`, [reservation.amount_microusd, actual, freeze, budget.id])
        await event(client, { companyId, aggregateType: 'BUDGET_RESERVATION', aggregateId: reservation.id, aggregateVersion: 2, eventType: freeze ? 'MODEL_CALL_SETTLED_AND_FROZEN' : 'MODEL_CALL_SETTLED', actorType: 'AGENT', actorId: reservation.agent_id, cardId: reservation.card_id, actionId: reservation.bound_action_id, attemptId, mandateId: reservation.mandate_id, mandateVersion: reservation.mandate_version, planEpoch: reservation.plan_epoch, payload: { reservationId: reservation.id, providerCallId, usageCallId, actualAmountMicrousd: actual, freeze } })
        await client.query('COMMIT'); res.json({ id: reservation.id, providerCallId, actualAmountMicrousd: actual, state: 'CONSUMED', budgetFrozen: freeze })
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    } catch (e) { errorResponse(res, e) }
  })

  router.post('/cards/:cardId/approvals', async (req, res) => {
    try {
      const { userId, companyId } = await deps.requireCompany(req as Request & AuthedRequest); const cardId = id(req.params.cardId, 'cardId'); const c = await card(pool as unknown as PoolClient, companyId, cardId)
      if (c.governance_mode !== 'GOVERNED' || !c.accountable_role_id) throw new GovernanceError(409, 'GOVERNANCE_REQUIRED', 'approval requires a governed card')
      const approvalId = `approval-${randomUUID().slice(0, 12)}`; const expires = iso(req.body?.expiresAt, 'expiresAt')!; const operationType = id(req.body?.operationType, 'operationType'); const idem = text(req.get('Idempotency-Key') || req.body?.idempotencyKey, 200)
      if (!APPROVAL_OPERATIONS.has(operationType)) throw new GovernanceError(400, 'UNKNOWN_OPERATION', 'unsupported approval operation')
      if (!idem) throw new GovernanceError(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required')
      const requestHash = hash({ cardId, operationType, request: req.body?.request ?? {} })
      const previous = (await pool.query<any>('SELECT * FROM governance_approvals WHERE company_id=$1 AND requested_by=$2 AND operation_type=$3 AND idempotency_key=$4', [companyId, userId, operationType, idem])).rows[0]
      if (previous) {
        if (previous.normalized_request_hash !== requestHash) throw new GovernanceError(409, 'IDEMPOTENCY_CONFLICT', 'idempotency key was used with a different request')
        res.status(200).json({ id: previous.id, state: previous.state, planEpoch: previous.plan_epoch, requestHash }); return
      }
      await pool.query(`INSERT INTO governance_approvals (id,company_id,card_id,plan_epoch,operation_type,normalized_request_hash,resource_version_refs,policy_version,designated_approver_role_id,requested_by,expires_at,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,'[]'::jsonb,1,$7,$8,$9,$10)`, [approvalId, companyId, cardId, c.plan_epoch ?? 1, operationType, requestHash, c.accountable_role_id, userId, expires, idem])
      res.status(201).json({ id: approvalId, state: 'PENDING', planEpoch: c.plan_epoch, requestHash })
    } catch (e) { errorResponse(res, e) }
  })

  router.post('/approvals/:approvalId/resolve', async (req, res) => {
    try {
      const { userId, companyId } = await deps.requireCompany(req as Request & AuthedRequest); const approvalId = id(req.params.approvalId, 'approvalId'); const decision = req.body?.decision === 'APPROVE' ? 'APPROVED' : req.body?.decision === 'REJECT' ? 'REJECTED' : null; if (!decision) throw new GovernanceError(400, 'INVALID_DECISION', 'decision must be APPROVE or REJECT')
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const a = (await client.query<any>('SELECT * FROM governance_approvals WHERE id=$1 AND company_id=$2 FOR UPDATE', [approvalId, companyId])).rows[0]
        if (!a) throw new GovernanceError(404, 'APPROVAL_NOT_FOUND', 'approval not found')
        if (a.state !== 'PENDING' || new Date(a.expires_at).getTime() <= Date.now()) throw new GovernanceError(409, 'APPROVAL_EXPIRED', 'approval is no longer pending')
        const current = await card(client, companyId, a.card_id, true)
        if (a.plan_epoch !== current.plan_epoch) {
          await client.query(`UPDATE governance_approvals SET state='INVALIDATED',version=version+1 WHERE id=$1`, [approvalId])
          await event(client, { companyId, aggregateType: 'APPROVAL', aggregateId: approvalId, aggregateVersion: a.version + 1, eventType: 'APPROVAL_INVALIDATED', actorType: 'SERVICE', actorId: 'governance-epoch', cardId: a.card_id, planEpoch: a.plan_epoch, payload: { currentEpoch: current.plan_epoch } })
          await client.query('COMMIT')
          throw new GovernanceError(409, 'STALE_EPOCH', 'approval belongs to an old card epoch')
        }
        await primaryAssignment(client, companyId, a.designated_approver_role_id, userId)
        await client.query('UPDATE governance_approvals SET state=$1,decided_by=$2,decided_at=NOW(),decision_comment=$3,version=version+1 WHERE id=$4', [decision, userId, text(req.body?.comment, 2000), approvalId])
        const eventId = await event(client, { companyId, aggregateType: 'APPROVAL', aggregateId: approvalId, aggregateVersion: a.version + 1, eventType: `APPROVAL_${decision}`, actorType: 'HUMAN', actorId: userId, cardId: a.card_id, planEpoch: a.plan_epoch })
        await client.query('COMMIT'); res.json({ id: approvalId, state: decision, eventId })
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    } catch (e) { errorResponse(res, e) }
  })

  router.post('/cards/:cardId/interventions', async (req, res) => {
    try {
      const { userId, companyId } = await deps.requireCompany(req as Request & AuthedRequest); const cardId = id(req.params.cardId, 'cardId'); const c = await card(pool as unknown as PoolClient, companyId, cardId)
      if (c.governance_mode !== 'GOVERNED') throw new GovernanceError(409, 'GOVERNANCE_REQUIRED', 'card is not governed')
      const requestType = ['CLARIFICATION','PLAN_REVIEW','PERMISSION','APPROVAL','ARTIFACT_REVIEW','ARBITRATION','TAKEOVER'].includes(req.body?.requestType) ? req.body.requestType : null; if (!requestType) throw new GovernanceError(400, 'INVALID_REQUEST_TYPE', 'invalid intervention type')
      const interventionId = `intervention-${randomUUID().slice(0, 12)}`; const expires = iso(req.body?.expiresAt, 'expiresAt')!
      if (expires.getTime() <= Date.now()) throw new GovernanceError(400, 'INVALID_TIME', 'expiresAt must be in the future')
      const client = await pool.connect()
      try {
        await client.query('BEGIN'); const current = await card(client, companyId, cardId, true)
        if (current.plan_epoch !== c.plan_epoch) throw new GovernanceError(409, 'STALE_EPOCH', 'card epoch changed')
        const actionId = req.body?.actionId ? id(req.body.actionId, 'actionId') : null
        if (actionId && !(await client.query('SELECT 1 FROM governance_actions WHERE id=$1 AND company_id=$2 AND card_id=$3 AND plan_epoch=$4', [actionId, companyId, cardId, current.plan_epoch])).rows[0]) throw new GovernanceError(409, 'ACTION_MISMATCH', 'action is not in the current card epoch')
        await client.query(`INSERT INTO governance_interventions (id,company_id,card_id,action_id,plan_epoch,request_type,requested_by,responsible_role_id,designated_user_id,context_refs,proposed_action,risks,options,expires_at,approval_id,submission_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16)`, [interventionId, companyId, cardId, actionId, current.plan_epoch, requestType, userId, current.accountable_role_id, req.body?.designatedUserId || current.human_sponsor_user_id, JSON.stringify(req.body?.contextRefs ?? []), req.body?.proposedAction ? JSON.stringify(req.body.proposedAction) : null, JSON.stringify(req.body?.risks ?? []), JSON.stringify(req.body?.options ?? []), expires, req.body?.approvalId || null, req.body?.submissionId || null])
        const eventId = await event(client, { companyId, aggregateType: 'INTERVENTION', aggregateId: interventionId, aggregateVersion: 1, eventType: 'INTERVENTION_OPENED', actorType: 'HUMAN', actorId: userId, cardId, actionId, planEpoch: current.plan_epoch })
        await client.query('COMMIT'); res.status(201).json({ id: interventionId, state: 'OPEN', planEpoch: current.plan_epoch, expiresAt: expires, eventId })
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    } catch (e) { errorResponse(res, e) }
  })

  router.get('/interventions', async (req, res) => {
    try {
      const { companyId } = await deps.requireCompany(req as Request & AuthedRequest); const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const expired = await client.query<any>(`UPDATE governance_interventions SET state='EXPIRED',resolved_at=NOW(),resolution='{"reason":"HUMAN_TIMEOUT"}'::jsonb,version=version+1 WHERE company_id=$1 AND state='OPEN' AND expires_at<=NOW() RETURNING *`, [companyId])
        for (const item of expired.rows) await event(client, { companyId, aggregateType: 'INTERVENTION', aggregateId: item.id, aggregateVersion: item.version, eventType: 'INTERVENTION_EXPIRED', actorType: 'SERVICE', actorId: 'governance-timeout', cardId: item.card_id, actionId: item.action_id, planEpoch: item.plan_epoch })
        const params: unknown[] = [companyId]; const where = ['company_id=$1']
        if (typeof req.query.cardId === 'string' && req.query.cardId) { params.push(id(req.query.cardId, 'cardId')); where.push(`card_id=$${params.length}`) }
        if (typeof req.query.state === 'string' && req.query.state) { params.push(req.query.state.toUpperCase()); where.push(`state=$${params.length}`) }
        const rows = (await client.query<any>(`SELECT * FROM governance_interventions WHERE ${where.join(' AND ')} ORDER BY created_at DESC`, params)).rows
        await client.query('COMMIT'); res.json(rows)
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    } catch (e) { errorResponse(res, e) }
  })

  router.post('/interventions/:interventionId/resolve', async (req, res) => {
    try {
      const { userId, companyId } = await deps.requireCompany(req as Request & AuthedRequest); const interventionId = id(req.params.interventionId, 'interventionId'); const decision = req.body?.decision === 'RESOLVE' ? 'RESOLVED' : req.body?.decision === 'REJECT' ? 'REJECTED' : null; if (!decision) throw new GovernanceError(400, 'INVALID_DECISION', 'decision must be RESOLVE or REJECT'); const client = await pool.connect()
      try { await client.query('BEGIN'); const i = (await client.query<any>('SELECT * FROM governance_interventions WHERE id=$1 AND company_id=$2 FOR UPDATE', [interventionId, companyId])).rows[0]; if (!i) throw new GovernanceError(404, 'INTERVENTION_NOT_FOUND', 'intervention not found'); const c = await card(client, companyId, i.card_id, true); if (i.state !== 'OPEN' || i.plan_epoch !== c.plan_epoch || new Date(i.expires_at).getTime() <= Date.now()) throw new GovernanceError(409, 'INTERVENTION_STALE', 'intervention is stale or expired'); const assignment = await primaryAssignment(client, companyId, i.responsible_role_id, userId); await client.query(`UPDATE governance_interventions SET state=$1,resolved_by=$2,resolved_at=NOW(),resolution=$3::jsonb,resume_token_hash=$4,version=version+1 WHERE id=$5`, [decision, userId, JSON.stringify(req.body?.resolution ?? {}), decision === 'RESOLVED' ? hash({ interventionId, version: i.version + 1, assignmentId: assignment.id }) : null, interventionId]); const eventId = await event(client, { companyId, aggregateType: 'INTERVENTION', aggregateId: interventionId, aggregateVersion: i.version + 1, eventType: `INTERVENTION_${decision}`, actorType: 'HUMAN', actorId: userId, cardId: i.card_id, actionId: i.action_id, planEpoch: i.plan_epoch }); await client.query('COMMIT'); res.json({ id: interventionId, state: decision, eventId }) } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    } catch (e) { errorResponse(res, e) }
  })

  router.post('/actions/:actionId/operations', async (req, res) => {
    try {
      const { companyId } = await deps.requireCompany(req as Request & AuthedRequest); const actionId = id(req.params.actionId, 'actionId'); const operationType = id(req.body?.operationType, 'operationType')
      if (!APPROVAL_OPERATIONS.has(operationType)) throw new GovernanceError(400, 'UNKNOWN_OPERATION', 'unsupported operation')
      const idempotencyKey = text(req.get('Idempotency-Key') || req.body?.idempotencyKey, 200); if (!idempotencyKey) throw new GovernanceError(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required')
      const client = await pool.connect()
      try {
        await client.query('BEGIN'); await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [JSON.stringify([companyId, actionId, operationType, idempotencyKey])])
        const existing = (await client.query<any>('SELECT * FROM governance_operations WHERE company_id=$1 AND action_id=$2 AND operation_type=$3 AND idempotency_key=$4', [companyId, actionId, operationType, idempotencyKey])).rows[0]
        const a = (await client.query<any>(`SELECT a.*,c.plan_epoch AS current_epoch,c.governance_state FROM governance_actions a JOIN board_cards c ON c.id=a.card_id WHERE a.id=$1 AND a.company_id=$2 FOR UPDATE OF a,c`, [actionId, companyId])).rows[0]; if (!a) throw new GovernanceError(404, 'ACTION_NOT_FOUND', 'action not found')
        const requestHash = hash({ cardId: a.card_id, operationType, request: req.body?.request ?? {} })
        if (existing) { if (existing.request_hash !== requestHash) throw new GovernanceError(409, 'IDEMPOTENCY_CONFLICT', 'key was used with different operation parameters'); await client.query('COMMIT'); res.json({ id: existing.id, state: existing.state, replayed: true }); return }
        if (a.plan_epoch !== a.current_epoch || !['RUNNING','WAITING_HUMAN'].includes(a.state)) throw new GovernanceError(409, 'STALE_EPOCH', 'action is not executable')
        const attempt = (await client.query<any>(`SELECT * FROM governance_action_attempts WHERE id=$1 AND action_id=$2 AND state IN ('RUNNING','WAITING_HUMAN') AND lease_generation=$3 AND (lease_expires_at IS NULL OR lease_expires_at>NOW()) FOR UPDATE`, [id(req.body?.attemptId, 'attemptId'), actionId, int(req.body?.leaseGeneration, 'leaseGeneration', 1)])).rows[0]; if (!attempt) throw new GovernanceError(409, 'LEASE_INVALID', 'attempt lease is invalid')
        const approval = (await client.query<any>(`SELECT * FROM governance_approvals WHERE id=$1 AND company_id=$2 FOR UPDATE`, [id(req.body?.approvalId, 'approvalId'), companyId])).rows[0]
        if (!approval || approval.state !== 'APPROVED' || approval.card_id !== a.card_id || approval.plan_epoch !== a.plan_epoch || approval.operation_type !== operationType || approval.normalized_request_hash !== requestHash || new Date(approval.expires_at).getTime() <= Date.now()) throw new GovernanceError(409, 'APPROVAL_INVALID', 'approval is missing, stale, consumed, or bound to different content')
        const operationId = `gop-${randomUUID().slice(0, 12)}`
        await client.query(`INSERT INTO governance_operations (id,company_id,card_id,action_id,attempt_id,plan_epoch,operation_type,request_hash,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [operationId, companyId, a.card_id, actionId, attempt.id, a.plan_epoch, operationType, requestHash, idempotencyKey])
        await client.query(`UPDATE governance_approvals SET state='CONSUMED',consumed_by_operation_id=$1,version=version+1 WHERE id=$2`, [operationId, approval.id])
        await event(client, { companyId, aggregateType: 'OPERATION', aggregateId: operationId, aggregateVersion: 1, eventType: 'OPERATION_PREPARED', actorType: 'AGENT', actorId: attempt.agent_id, cardId: a.card_id, actionId, attemptId: attempt.id, mandateId: attempt.mandate_id, mandateVersion: attempt.mandate_version, planEpoch: a.plan_epoch, idempotencyKey, payload: { operationType, requestHash } })
        await client.query('COMMIT'); res.status(201).json({ id: operationId, state: 'PREPARED', requestHash })
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    } catch (e) { errorResponse(res, e) }
  })

  router.post('/operations/:operationId/result', async (req, res) => {
    try {
      const { companyId } = await deps.requireCompany(req as Request & AuthedRequest); const operationId = id(req.params.operationId, 'operationId'); const state = ['DISPATCHED','SUCCEEDED','FAILED','UNKNOWN','CANCELLED'].includes(req.body?.state) ? req.body.state : null; if (!state) throw new GovernanceError(400, 'INVALID_STATE', 'invalid operation state')
      const result = await pool.query<any>(`UPDATE governance_operations SET state=$1,provider_receipt=$2::jsonb,updated_at=NOW() WHERE id=$3 AND company_id=$4 AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED') RETURNING *`, [state, JSON.stringify(req.body?.providerReceipt ?? null), operationId, companyId]); if (!result.rows[0]) throw new GovernanceError(409, 'OPERATION_TERMINAL', 'operation is missing or terminal'); res.json({ id: operationId, state })
    } catch (e) { errorResponse(res, e) }
  })

  router.post('/artifacts', async (req, res) => {
    try {
      const { userId, companyId } = await deps.requireCompany(req as Request & AuthedRequest)
      const cardId = id(req.body?.cardId, 'cardId'); const contentHash = text(req.body?.contentHash, 64)
      if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new GovernanceError(400, 'INVALID_HASH', 'contentHash must be lowercase SHA256')
      const kind = req.body?.kind === 'EVIDENCE' ? 'EVIDENCE' : 'DELIVERABLE'; const retention = iso(req.body?.retentionUntil, 'retentionUntil')!
      if (retention.getTime() < Date.now() + 365 * 24 * 60 * 60_000) throw new GovernanceError(400, 'RETENTION_TOO_SHORT', 'governed artifacts must be retained for at least 365 days')
      const artifactId = id(req.body?.artifactId ?? `artifact-${randomUUID().slice(0, 12)}`, 'artifactId'); const versionId = `av-${randomUUID().slice(0, 12)}`
      const client = await pool.connect()
      try {
        await client.query('BEGIN'); const c = await card(client, companyId, cardId, true)
        if (c.governance_mode !== 'GOVERNED') throw new GovernanceError(409, 'GOVERNANCE_REQUIRED', 'formal artifacts require a governed card')
        const sourceActionId = req.body?.sourceActionId ? id(req.body.sourceActionId, 'sourceActionId') : null
        const sourceAttemptId = req.body?.sourceAttemptId ? id(req.body.sourceAttemptId, 'sourceAttemptId') : null
        let producers = [userId]; let humanOperationId: string | null = text(req.body?.sourceHumanOperationId, 200) || `human-${randomUUID().slice(0, 12)}`
        if (sourceActionId) {
          if (!sourceAttemptId) throw new GovernanceError(400, 'ATTEMPT_REQUIRED', 'agent-produced artifacts require sourceAttemptId')
          const source = (await client.query<any>(`SELECT a.assigned_agent_id,a.plan_epoch,at.state FROM governance_actions a JOIN governance_action_attempts at ON at.action_id=a.id WHERE a.id=$1 AND at.id=$2 AND a.company_id=$3 AND a.card_id=$4`, [sourceActionId, sourceAttemptId, companyId, cardId])).rows[0]
          if (!source || source.plan_epoch !== c.plan_epoch || !['RUNNING','WAITING_HUMAN','SUCCEEDED'].includes(source.state)) throw new GovernanceError(409, 'ARTIFACT_SOURCE_INVALID', 'artifact source is not a current valid attempt')
          producers = [source.assigned_agent_id]; humanOperationId = null
        }
        await client.query(`INSERT INTO governance_artifact_versions
        (version_id,artifact_id,company_id,card_id,content_hash,media_type,byte_size,storage_object_id,external_source_ref,producer_principal_ids,source_action_id,source_attempt_id,source_human_operation_id,sensitivity,retention_until,kind)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16)`,
        [versionId, artifactId, companyId, cardId, contentHash, text(req.body?.mediaType, 200) || 'application/octet-stream', int(req.body?.byteSize ?? 0, 'byteSize'), text(req.body?.storageObjectId, 500) || null, req.body?.externalSourceRef ? JSON.stringify(req.body.externalSourceRef) : null, JSON.stringify(producers), sourceActionId, sourceAttemptId, humanOperationId, SENSITIVITY.has(req.body?.sensitivity) ? req.body.sensitivity : 'INTERNAL', retention, kind])
        await event(client, { companyId, aggregateType: 'ARTIFACT', aggregateId: versionId, aggregateVersion: 1, eventType: 'ARTIFACT_PUBLISHED', actorType: 'HUMAN', actorId: userId, cardId, actionId: sourceActionId, attemptId: sourceAttemptId, planEpoch: c.plan_epoch, payload: { artifactId, contentHash, kind, producers } })
        await client.query('COMMIT'); res.status(201).json({ versionId, artifactId, cardId, kind, governanceMode: c.governance_mode, producerPrincipalIds: producers })
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    } catch (e) { errorResponse(res, e) }
  })

  router.get('/artifacts/:versionId', async (req, res) => {
    try {
      const { userId, companyId } = await deps.requireCompany(req as Request & AuthedRequest); const versionId = id(req.params.versionId, 'versionId'); const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const artifact = (await client.query<any>('SELECT * FROM governance_artifact_versions WHERE version_id=$1 AND company_id=$2', [versionId, companyId])).rows[0]
        if (!artifact) throw new GovernanceError(404, 'ARTIFACT_NOT_FOUND', 'artifact version not found')
        const current = await card(client, companyId, artifact.card_id)
        await event(client, { companyId, aggregateType: 'ARTIFACT', aggregateId: versionId, aggregateVersion: 1, eventType: 'ARTIFACT_ACCESSED', actorType: 'HUMAN', actorId: userId, cardId: artifact.card_id, planEpoch: current.plan_epoch })
        await client.query('COMMIT'); res.json(artifact)
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    } catch (e) { errorResponse(res, e) }
  })

  router.post('/cards/:cardId/submissions', async (req, res) => {
    try {
      const { userId, companyId } = await deps.requireCompany(req as Request & AuthedRequest); const cardId = id(req.params.cardId, 'cardId')
      const idempotencyKey = text(req.get('Idempotency-Key') || req.body?.idempotencyKey, 200); if (!idempotencyKey) throw new GovernanceError(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required')
      const requestHash = hash({ cardId, body: req.body ?? {} })
      const expectedVersion = int(req.body?.expectedVersion, 'expectedVersion')
      const expectedEpoch = int(req.body?.expectedEpoch, 'expectedEpoch', 1)
      const client = await pool.connect()
      try {
        await client.query('BEGIN'); await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [JSON.stringify([companyId, userId, 'submit_deliverable', idempotencyKey])])
        const prior = (await client.query<any>(`SELECT request_hash,result FROM governance_idempotency WHERE company_id=$1 AND actor_type='HUMAN' AND actor_id=$2 AND command_name='submit_deliverable' AND idempotency_key=$3`, [companyId, userId, idempotencyKey])).rows[0]
        if (prior) { if (prior.request_hash !== requestHash) throw new GovernanceError(409, 'IDEMPOTENCY_CONFLICT', 'idempotency key was used with a different request'); await client.query('COMMIT'); res.json(prior.result); return }
        const c = await card(client, companyId, cardId, true)
        if (c.governance_version !== expectedVersion) throw new GovernanceError(409, 'VERSION_CONFLICT', 'card version changed')
        if (c.plan_epoch !== expectedEpoch) throw new GovernanceError(409, 'STALE_EPOCH', 'card plan epoch changed')
        if (c.governance_mode !== 'GOVERNED') throw new GovernanceError(409, 'GOVERNANCE_REQUIRED', 'card is not governed')
        const refs = array(req.body?.artifactVersionRefs, 'artifactVersionRefs', 100); if (!refs.length) throw new GovernanceError(400, 'ARTIFACT_REQUIRED', 'artifactVersionRefs is required')
        if (refs.some((x) => typeof x !== 'string')) throw new GovernanceError(400, 'INVALID_ARTIFACT_REF', 'artifactVersionRefs must contain version ids')
        const artifacts = await client.query<any>('SELECT version_id,producer_principal_ids FROM governance_artifact_versions WHERE company_id=$1 AND card_id=$2 AND version_id=ANY($3::text[])', [companyId, cardId, refs])
        if (artifacts.rows.length !== new Set(refs).size) throw new GovernanceError(409, 'ARTIFACT_MISMATCH', 'all artifact versions must belong to this card')
        const producers = [...new Set(artifacts.rows.flatMap((artifact) => artifact.producer_principal_ids ?? []))]
        const revision = Number((await client.query('SELECT COALESCE(MAX(revision),0)+1 AS n FROM governance_submissions WHERE card_id=$1 AND plan_epoch=$2', [cardId, c.plan_epoch])).rows[0].n)
        const submissionId = `sub-${randomUUID().slice(0, 12)}`
        const actionId = req.body?.actionId ? id(req.body.actionId, 'actionId') : null
        if (actionId) {
          const action = (await client.query('SELECT 1 FROM governance_actions WHERE id=$1 AND company_id=$2 AND card_id=$3 AND plan_epoch=$4', [actionId, companyId, cardId, c.plan_epoch])).rows[0]
          if (!action) throw new GovernanceError(409, 'ACTION_MISMATCH', 'action does not belong to the current card epoch')
        }
        const contract = c.shipping_feature_id ? (await client.query<any>('SELECT contract_revision FROM shipping_features WHERE id=$1', [c.shipping_feature_id])).rows[0]?.contract_revision : null
        await client.query(`INSERT INTO governance_submissions (id,company_id,card_id,action_id,human_operation_id,plan_epoch,revision,artifact_version_refs,producer_principal_ids,definition_of_done_snapshot,review_policy_snapshot,shipping_contract_revision,completion_summary,submitted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb,$12,$13,$14)`, [submissionId, companyId, cardId, actionId, actionId ? null : userId, c.plan_epoch, revision, JSON.stringify(refs), JSON.stringify(producers), c.definition_of_done, JSON.stringify(c.review_policy ?? {}), contract, text(req.body?.completionSummary, 8000) || 'submitted', userId])
        if (actionId) await client.query(`UPDATE governance_actions SET state='SUBMITTED',version=version+1,updated_at=NOW() WHERE id=$1`, [actionId])
        await client.query(`UPDATE board_cards SET governance_state='IN_REVIEW',governance_version=governance_version+1,updated_at=NOW() WHERE id=$1`, [cardId])
        const eventId = await event(client, { companyId, aggregateType: 'SUBMISSION', aggregateId: submissionId, aggregateVersion: 1, eventType: 'SUBMISSION_CREATED', actorType: 'HUMAN', actorId: userId, cardId, planEpoch: c.plan_epoch, idempotencyKey, payload: { revision } })
        const result = { id: submissionId, revision, state: 'PENDING_REVIEW', planEpoch: c.plan_epoch, eventId }
        await client.query(`INSERT INTO governance_idempotency (company_id,actor_type,actor_id,command_name,idempotency_key,request_hash,result,event_id) VALUES ($1,'HUMAN',$2,'submit_deliverable',$3,$4,$5::jsonb,$6)`, [companyId, userId, idempotencyKey, requestHash, JSON.stringify(result), eventId])
        await client.query('COMMIT'); res.status(201).json(result)
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    } catch (e) { errorResponse(res, e) }
  })

  router.post('/submissions/:submissionId/reviews', async (req, res) => {
    try {
      const { userId, companyId } = await deps.requireCompany(req as Request & AuthedRequest); const submissionId = id(req.params.submissionId, 'submissionId')
      const stage = 'INDEPENDENT_CHECK'; const decision = ['ACCEPT','REQUEST_CHANGES','REJECT'].includes(req.body?.decision) ? req.body.decision : null
      if (!decision) throw new GovernanceError(400, 'INVALID_DECISION', 'decision is required')
      const client = await pool.connect()
      try {
        await client.query('BEGIN'); const s = (await client.query<any>('SELECT * FROM governance_submissions WHERE id=$1 AND company_id=$2 FOR UPDATE', [submissionId, companyId])).rows[0]; if (!s) throw new GovernanceError(404, 'SUBMISSION_NOT_FOUND', 'submission not found')
        if (s.state !== 'PENDING_REVIEW') throw new GovernanceError(409, 'SUBMISSION_NOT_PENDING', 'submission is not pending review')
        if ((s.producer_principal_ids ?? []).includes(userId)) throw new GovernanceError(409, 'REVIEWER_NOT_INDEPENDENT', 'a producer cannot independently review this submission')
        const current = await card(client, companyId, s.card_id, true); if (current.plan_epoch !== s.plan_epoch) throw new GovernanceError(409, 'STALE_EPOCH', 'submission belongs to an old epoch')
        const reviewId = `review-${randomUUID().slice(0, 12)}`
        await client.query(`INSERT INTO governance_reviews (id,company_id,submission_id,stage,decision,reviewer_type,reviewer_id,plan_epoch,policy_version,comment) VALUES ($1,$2,$3,$4,$5,'HUMAN',$6,$7,$8,$9)`, [reviewId, companyId, submissionId, stage, decision, userId, s.plan_epoch, Number(s.version), text(req.body?.comment, 4000)])
        if (decision !== 'ACCEPT') {
          await client.query(`UPDATE governance_submissions SET state=$1,version=version+1 WHERE id=$2`, [decision === 'REJECT' ? 'REJECTED' : 'CHANGES_REQUESTED', submissionId])
          await client.query(`UPDATE board_cards SET governance_state='IN_PROGRESS',governance_version=governance_version+1,updated_at=NOW() WHERE id=$1`, [s.card_id])
        } else await client.query(`UPDATE governance_submissions SET version=version+1 WHERE id=$1`, [submissionId])
        await event(client, { companyId, aggregateType: 'SUBMISSION', aggregateId: submissionId, aggregateVersion: s.version + 1, eventType: `REVIEW_${decision}`, actorType: 'HUMAN', actorId: userId, cardId: s.card_id, planEpoch: s.plan_epoch, payload: { reviewId, stage } })
        await client.query('COMMIT'); res.status(201).json({ id: reviewId, submissionId, stage, decision })
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    } catch (e) { errorResponse(res, e) }
  })

  router.post('/cards/:cardId/finalize', async (req, res) => {
    try {
      const { userId, companyId } = await deps.requireCompany(req as Request & AuthedRequest); const cardId = id(req.params.cardId, 'cardId'); const client = await pool.connect()
      const idempotencyKey = text(req.get('Idempotency-Key') || req.body?.idempotencyKey, 200)
      if (!idempotencyKey) throw new GovernanceError(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required')
      const requestHash = hash({ cardId, submissionId: req.body?.submissionId, comment: req.body?.comment ?? '' })
      const expectedVersion = int(req.body?.expectedVersion, 'expectedVersion')
      const expectedEpoch = int(req.body?.expectedEpoch, 'expectedEpoch', 1)
      try {
        await client.query('BEGIN')
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [JSON.stringify([companyId, userId, 'finalize_submission', idempotencyKey])])
        const prior = (await client.query<any>(`SELECT request_hash,result FROM governance_idempotency WHERE company_id=$1 AND actor_type='HUMAN' AND actor_id=$2 AND command_name='finalize_submission' AND idempotency_key=$3`, [companyId, userId, idempotencyKey])).rows[0]
        if (prior) {
          if (prior.request_hash !== requestHash) throw new GovernanceError(409, 'IDEMPOTENCY_CONFLICT', 'idempotency key was used with a different request')
          await client.query('COMMIT'); res.json(prior.result); return
        }
        const c = await card(client, companyId, cardId, true); if (c.governance_mode !== 'GOVERNED') throw new GovernanceError(409, 'GOVERNANCE_REQUIRED', 'card is not governed')
        if (c.governance_version !== expectedVersion) throw new GovernanceError(409, 'VERSION_CONFLICT', 'card version changed')
        if (c.plan_epoch !== expectedEpoch) throw new GovernanceError(409, 'STALE_EPOCH', 'card plan epoch changed')
        const assignment = await primaryAssignment(client, companyId, c.accountable_role_id, userId)
        const s = (await client.query<any>('SELECT * FROM governance_submissions WHERE id=$1 AND card_id=$2 AND state=\'PENDING_REVIEW\' FOR UPDATE', [id(req.body?.submissionId, 'submissionId'), cardId])).rows[0]; if (!s || s.plan_epoch !== c.plan_epoch) throw new GovernanceError(409, 'STALE_EPOCH', 'submission is not current')
        if ((s.producer_principal_ids ?? []).includes(userId)) throw new GovernanceError(409, 'FINAL_REVIEWER_NOT_INDEPENDENT', 'a producer cannot finally accept this submission')
        const reviews = (await client.query<any>('SELECT * FROM governance_reviews WHERE submission_id=$1', [s.id])).rows; const independent = reviews.find((r) => r.stage === 'INDEPENDENT_CHECK' && r.decision === 'ACCEPT' && !(s.producer_principal_ids ?? []).includes(r.reviewer_id))
        if (!independent) throw new GovernanceError(409, 'REVIEW_GATE_FAILED', 'an independent acceptance review is required')
        if (c.shipping_feature_id) {
          const shipping = (await client.query<any>(`SELECT f.status,f.contract_revision,
            COUNT(*) FILTER (WHERE v.required) AS required_count,
            COUNT(*) FILTER (WHERE v.required AND r.decision IN ('PASSED','WAIVED') AND r.contract_revision=f.contract_revision AND r.plan_epoch=$2 AND r.artifact_version_refs=$3::jsonb) AS passing_count
            FROM shipping_features f LEFT JOIN shipping_verifications v ON v.feature_id=f.id
            LEFT JOIN shipping_verification_results r ON r.id=v.latest_result_id
            WHERE f.id=$1 GROUP BY f.id`, [c.shipping_feature_id, c.plan_epoch, JSON.stringify(s.artifact_version_refs)])).rows[0]
          if (!shipping || Number(shipping.contract_revision) !== Number(s.shipping_contract_revision) || Number(shipping.required_count) !== Number(shipping.passing_count) || !['ready','releasing','watching','learned'].includes(shipping.status)) throw new GovernanceError(409, 'SHIPPING_GATE_FAILED', 'current contract and candidate have not passed required Shipping verification')
        }
        const open = await client.query(`SELECT 1 FROM governance_actions WHERE card_id=$1 AND plan_epoch=$2 AND state NOT IN ('COMPLETED','CANCELLED','SUPERSEDED','FAILED','SUBMITTED')
          UNION ALL SELECT 1 FROM governance_action_attempts at JOIN governance_actions a ON a.id=at.action_id WHERE a.card_id=$1 AND a.plan_epoch=$2 AND at.state IN ('RUNNING','WAITING_HUMAN','STOPPING')
          UNION ALL SELECT 1 FROM governance_operations WHERE card_id=$1 AND plan_epoch=$2 AND state IN ('PREPARED','DISPATCHED','UNKNOWN')
          UNION ALL SELECT 1 FROM governance_interventions WHERE card_id=$1 AND plan_epoch=$2 AND state='OPEN' LIMIT 1`, [cardId, c.plan_epoch])
        if (open.rows[0]) throw new GovernanceError(409, 'EXECUTION_NOT_SETTLED', 'actions and external operations must be settled before acceptance')
        const finalReviewId = `review-${randomUUID().slice(0, 12)}`
        await client.query(`INSERT INTO governance_reviews (id,company_id,submission_id,stage,decision,reviewer_type,reviewer_id,basis_refs,plan_epoch,policy_version,comment) VALUES ($1,$2,$3,'FINAL_ACCEPTANCE','ACCEPT','HUMAN',$4,$5::jsonb,$6,$7,$8)`, [finalReviewId, companyId, s.id, userId, JSON.stringify([independent.id]), c.plan_epoch, Number(s.version), text(req.body?.comment, 4000)])
        const manifestPayload = { cardId, planEpoch: c.plan_epoch, goal: c.title, definitionOfDone: s.definition_of_done_snapshot, submissionId: s.id, artifacts: s.artifact_version_refs, evidence: s.evidence_version_refs, independentReviewId: independent.id, finalReviewId, finalReviewerId: userId, finalAssignmentId: assignment.id, knownLimitations: s.known_limitations, unresolvedRisks: s.unresolved_risks, completedAt: new Date().toISOString() }; const manifestId = `manifest-${randomUUID().slice(0, 12)}`
        await client.query('INSERT INTO governance_manifests (id,company_id,card_id,plan_epoch,submission_id,payload,content_hash) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)', [manifestId, companyId, cardId, c.plan_epoch, s.id, JSON.stringify(manifestPayload), hash(manifestPayload)])
        await client.query(`UPDATE governance_submissions SET state='ACCEPTED',version=version+1 WHERE id=$1`, [s.id])
        await client.query(`UPDATE board_cards SET governance_state='DONE',accepted_submission_id=$1,governance_version=governance_version+1,updated_at=NOW() WHERE id=$2`, [s.id, cardId])
        const eventId = await event(client, { companyId, aggregateType: 'CARD', aggregateId: cardId, aggregateVersion: c.governance_version + 1, eventType: 'CARD_FINALIZED', actorType: 'HUMAN', actorId: userId, cardId, planEpoch: c.plan_epoch, payload: { submissionId: s.id, manifestId } })
        const result = { cardId, state: 'DONE', manifestId, eventId }
        await client.query(`INSERT INTO governance_idempotency (company_id,actor_type,actor_id,command_name,idempotency_key,request_hash,result,event_id) VALUES ($1,'HUMAN',$2,'finalize_submission',$3,$4,$5::jsonb,$6)`, [companyId, userId, idempotencyKey, requestHash, JSON.stringify(result), eventId])
        await client.query('COMMIT'); res.json(result)
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    } catch (e) { errorResponse(res, e) }
  })

  router.get('/cards/:cardId/timeline', async (req, res) => {
    try {
      const { companyId } = await deps.requireCompany(req as Request & AuthedRequest)
      const cardId = id(req.params.cardId, 'cardId')
      await card(pool as unknown as PoolClient, companyId, cardId)
      const { rows } = await pool.query(`SELECT * FROM governance_events WHERE company_id=$1 AND card_id=$2 ORDER BY occurred_at,id`, [companyId, cardId])
      res.json(rows)
    } catch (error) { errorResponse(res, error) }
  })

  return router
}
