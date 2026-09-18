import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { pool } from '../db/pool.js'
import { buildApiTestApp, ensureSchemaOnce, resetAllTables, seedUserMembership, teardownAll } from './_helpers.js'
import { createAgentRun } from '../agents/observability.js'
import { authorizeGovernedModelCall, settleGovernedModelCall } from '../governance/runtime-budget.js'

process.env.CUMORA_MODEL_PRICES_JSON = JSON.stringify({
  'governance-test-model': { inPer1M: 1, cachedInPer1M: 0.1, cacheWritePer1M: 1.25, outPer1M: 2 },
})
process.env.NODE_ENV = 'test'

let ownerServer: Server
let reviewerServer: Server
let ownerBase = ''
let reviewerBase = ''

async function start(userId: string): Promise<{ server: Server; base: string }> {
  const app = await buildApiTestApp(userId)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('test server did not bind')
  return { server, base: `http://127.0.0.1:${addr.port}/api` }
}

async function request(base: string, path: string, method = 'GET', body?: unknown, idempotencyKey = `test-${crypto.randomUUID()}`): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const raw = await response.text()
  return { status: response.status, body: raw ? JSON.parse(raw) : null }
}

before(async () => {
  await ensureSchemaOnce()
  const owner = await start('owner-governance')
  const reviewer = await start('reviewer-governance')
  ownerServer = owner.server; ownerBase = owner.base
  reviewerServer = reviewer.server; reviewerBase = reviewer.base
})

beforeEach(async () => { await resetAllTables() })
after(async () => {
  if (ownerServer?.listening) await new Promise<void>((resolve) => ownerServer.close(() => resolve()))
  await teardownAll(reviewerServer)
})

test('governed card closes only through independent review and Primary final acceptance', async () => {
  const companyId = 'company-governance'
  await pool.query(`INSERT INTO companies (id,name,slug,owner_user_id) VALUES ($1,'Governance Test',$1,$2)`, [companyId, 'owner-governance'])
  await seedUserMembership('owner-governance', companyId)
  await seedUserMembership('reviewer-governance', companyId)
  await seedUserMembership('candidate-a', companyId)
  await seedUserMembership('candidate-b', companyId)
  await pool.query(`UPDATE users SET tier='pro' WHERE id=$1`, ['owner-governance'])
  await pool.query(`INSERT INTO participants (id,company_id,kind,name,role,initial,avatar_bg,status,engine)
    VALUES ('agent-governance',$1,'agent','Governance Agent','builder','G','#123456','avail','managed'),
           ('agent-reviewer',$1,'agent','Governance Reviewer','reviewer','R','#654321','avail','managed')`, [companyId])

  const board = await request(ownerBase, '/boards', 'POST', { title: 'Governed delivery' })
  assert.equal(board.status, 201)
  const snapshot = await request(ownerBase, `/boards/${board.body.id}`)
  const todo = snapshot.body.columns.find((column: any) => column.kind === 'todo')
  const done = snapshot.body.columns.find((column: any) => column.kind === 'done')
  const created = await request(ownerBase, `/boards/${board.body.id}/cards`, 'POST', { title: 'Ship governed change', columnId: todo.id })
  assert.equal(created.status, 200)
  const shipping = await request(ownerBase, '/shipping/features', 'POST', {
    title: 'Governed Shipping candidate', problem: 'Candidate must be verified', desiredOutcome: 'All required evidence passes',
    contractSummary: 'Verify exact immutable artifact', boardCardId: created.body.id, builderIds: ['agent-governance'],
  })
  assert.equal(shipping.status, 201)

  const role = await request(ownerBase, '/governance/roles', 'POST', { name: 'Delivery owner', responsibilityScope: 'Accept delivery', grantableGrants: [
    { resourceType: 'CARD', resourceId: created.body.id, operation: 'card.read' },
    { resourceType: 'CARD', resourceId: created.body.id, operation: 'card.action.create' },
    { resourceType: 'CARD', resourceId: created.body.id, operation: 'artifact.publish' },
    { resourceType: 'SHIPPING_FEATURE', resourceId: shipping.body.id, operation: 'shipping.verify' },
  ] })
  assert.equal(role.status, 201)
  const competing = await Promise.all([
    request(ownerBase, `/governance/roles/${role.body.id}/assignments`, 'POST', { humanUserId: 'candidate-a', expectedVersion: 1 }),
    request(ownerBase, `/governance/roles/${role.body.id}/assignments`, 'POST', { humanUserId: 'candidate-b', expectedVersion: 1 }),
  ])
  assert.deepEqual(competing.map((result) => result.status).sort(), [201, 409])
  const assignment = await request(ownerBase, `/governance/roles/${role.body.id}/assignments`, 'POST', { humanUserId: 'owner-governance', expectedVersion: 2 })
  assert.equal(assignment.status, 201)
  const upgrade = await request(ownerBase, `/governance/cards/${created.body.id}/upgrade`, 'POST', {
    accountableRoleId: role.body.id,
    agentId: 'agent-governance',
    definitionOfDone: 'Reviewed immutable artifact is accepted',
    deadline: new Date(Date.now() + 86_400_000).toISOString(),
    budgetLimitMicrousd: 100_000,
    modelCallLimit: 10,
    shippingFeatureId: shipping.body.id,
    expectedVersion: 0,
  })
  assert.equal(upgrade.status, 201)
  const reviewerMandate = await request(ownerBase, `/governance/cards/${created.body.id}/mandates`, 'POST', {
    agentId: 'agent-reviewer', expectedVersion: 1, expectedEpoch: 1,
    validUntil: new Date(Date.now() + 43_200_000).toISOString(),
    grants: [{ resourceType: 'SHIPPING_FEATURE', resourceId: shipping.body.id, operation: 'shipping.verify' }],
  })
  assert.equal(reviewerMandate.status, 201)
  assert.equal((await request(ownerBase, `/shipping/features/${shipping.body.id}/invariants`, 'POST', { title: 'Candidate remains reproducible', required: false })).status, 201)
  assert.equal((await request(ownerBase, `/shipping/features/${shipping.body.id}/transition`, 'POST', { status: 'contract' })).status, 200)
  assert.equal((await request(ownerBase, `/shipping/features/${shipping.body.id}/transition`, 'POST', { status: 'building' })).status, 200)
  for (const verification of shipping.body.verifications) {
    const ownerSet = await request(ownerBase, `/shipping/features/${shipping.body.id}/verifications/${verification.id}`, 'PATCH', { ownerId: 'reviewer-governance' })
    assert.equal(ownerSet.status, 200)
  }
  assert.equal((await request(ownerBase, `/shipping/features/${shipping.body.id}/transition`, 'POST', { status: 'verifying' })).status, 200)

  const approvalBody = { operationType: 'connector.write', request: { target: 'staging' }, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
  const approval = await request(ownerBase, `/governance/cards/${created.body.id}/approvals`, 'POST', approvalBody, 'approval-one')
  assert.equal(approval.status, 201)
  const approvalReplay = await request(ownerBase, `/governance/cards/${created.body.id}/approvals`, 'POST', approvalBody, 'approval-one')
  assert.equal(approvalReplay.status, 200)
  assert.equal(approvalReplay.body.id, approval.body.id)
  const approvalConflict = await request(ownerBase, `/governance/cards/${created.body.id}/approvals`, 'POST', { ...approvalBody, request: { target: 'production' } }, 'approval-one')
  assert.equal(approvalConflict.status, 409)

  const bypass = await request(ownerBase, `/boards/${board.body.id}/cards/${created.body.id}`, 'PATCH', { columnId: done.id })
  assert.equal(bypass.status, 409)

  const action = await request(ownerBase, `/governance/cards/${created.body.id}/actions`, 'POST', {
    agentId: 'agent-governance', mandateId: upgrade.body.mandateId, mandateVersion: 1,
    objective: 'Produce candidate', grants: [], expectedVersion: 2, expectedEpoch: 1,
  })
  assert.equal(action.status, 201)
  const verifyAction = await request(ownerBase, `/governance/cards/${created.body.id}/actions`, 'POST', {
    agentId: 'agent-reviewer', mandateId: reviewerMandate.body.id, mandateVersion: 1, purpose: 'VERIFY',
    objective: 'Independently verify exact candidate', grants: [{ resourceType: 'SHIPPING_FEATURE', resourceId: shipping.body.id, operation: 'shipping.verify' }], expectedVersion: 3, expectedEpoch: 1,
  })
  assert.equal(verifyAction.status, 201)
  const reservations = await Promise.all([
    request(ownerBase, `/governance/actions/${action.body.id}/reserve-budget`, 'POST', { amountMicrousd: 60_000, modelCalls: 6 }),
    request(ownerBase, `/governance/actions/${action.body.id}/reserve-budget`, 'POST', { amountMicrousd: 60_000, modelCalls: 6 }),
  ])
  assert.deepEqual(reservations.map((result) => result.status).sort(), [201, 409])
  const runtimeAssignmentId = (await pool.query<any>(`SELECT runtime_assignment_id FROM participants WHERE id='agent-governance' AND company_id=$1`, [companyId])).rows[0].runtime_assignment_id
  const reviewerRuntimeAssignmentId = (await pool.query<any>(`SELECT runtime_assignment_id FROM participants WHERE id='agent-reviewer' AND company_id=$1`, [companyId])).rows[0].runtime_assignment_id
  const claim = await request(ownerBase, `/governance/cards/${created.body.id}/claim`, 'POST', { agentId: 'agent-governance', mandateId: upgrade.body.mandateId, expectedEpoch: 1 })
  assert.equal(claim.status, 201)
  const attempt = await request(ownerBase, `/governance/actions/${action.body.id}/attempts`, 'POST', {
    runtimeAssignmentId, planEpoch: 1, mandateId: upgrade.body.mandateId, mandateVersion: 1,
  })
  assert.equal(attempt.status, 201)
  const governedRunId = await createAgentRun({ agentId: 'agent-governance', companyId, governanceAttemptId: attempt.body.id })
  const runtimeAuthorization = await authorizeGovernedModelCall(pool, { runId: governedRunId, agentId: 'agent-governance', companyId, providerCallId: 'runtime-provider-call', model: 'governance-test-model', maxInputTokens: 100, maxOutputTokens: 100 })
  assert.ok(runtimeAuthorization)
  const runtimeSettlement = await settleGovernedModelCall(pool, { runId: governedRunId, agentId: 'agent-governance', companyId, providerCallId: 'runtime-provider-call', usage: { inputTokens: 50, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 25 } })
  assert.equal(runtimeSettlement?.actualAmountMicrousd, 100)
  assert.equal(runtimeSettlement?.budgetFrozen, false)
  await pool.query('DELETE FROM company_members WHERE company_id=$1 AND user_id=$2', [companyId, 'owner-governance'])
  await assert.rejects(
    authorizeGovernedModelCall(pool, { runId: governedRunId, agentId: 'agent-governance', companyId, providerCallId: 'runtime-after-sponsor-left', model: 'governance-test-model', maxInputTokens: 10, maxOutputTokens: 10 }),
    (error: any) => error?.code === 'LEASE_INVALID',
  )
  await seedUserMembership('owner-governance', companyId)
  const callAuthorizationBody = {
    providerCallId: 'provider-call-one', leaseGeneration: 1, model: 'governance-test-model',
    maxInputTokens: 1_000, maxOutputTokens: 1_000,
  }
  const callAuthorization = await request(ownerBase, `/governance/attempts/${attempt.body.id}/model-calls/authorize`, 'POST', callAuthorizationBody)
  assert.equal(callAuthorization.status, 201)
  assert.equal(callAuthorization.body.amountMicrousd, 3_250)
  const callAuthorizationReplay = await request(ownerBase, `/governance/attempts/${attempt.body.id}/model-calls/authorize`, 'POST', callAuthorizationBody)
  assert.equal(callAuthorizationReplay.status, 200)
  assert.equal(callAuthorizationReplay.body.id, callAuthorization.body.id)
  const callAuthorizationConflict = await request(ownerBase, `/governance/attempts/${attempt.body.id}/model-calls/authorize`, 'POST', { ...callAuthorizationBody, maxOutputTokens: 2_000 })
  assert.equal(callAuthorizationConflict.status, 409)
  const settlementBody = { usageCallId: 'llm-call-one', inputTokens: 100, cachedInputTokens: 20, cacheCreationTokens: 0, outputTokens: 50 }
  const settlement = await request(ownerBase, `/governance/attempts/${attempt.body.id}/model-calls/provider-call-one/settle`, 'POST', settlementBody)
  assert.equal(settlement.status, 200)
  assert.equal(settlement.body.actualAmountMicrousd, 202)
  assert.equal(settlement.body.budgetFrozen, false)
  const settlementReplay = await request(ownerBase, `/governance/attempts/${attempt.body.id}/model-calls/provider-call-one/settle`, 'POST', settlementBody)
  assert.equal(settlementReplay.status, 200)
  assert.equal(settlementReplay.body.actualAmountMicrousd, 202)
  const artifact = await request(ownerBase, '/governance/artifacts', 'POST', {
    cardId: created.body.id,
    contentHash: 'a'.repeat(64),
    mediaType: 'application/zip', byteSize: 42,
    externalSourceRef: { uri: 'test://candidate/a' },
    sourceActionId: action.body.id, sourceAttemptId: attempt.body.id,
    retentionUntil: new Date(Date.now() + 366 * 86_400_000).toISOString(), kind: 'DELIVERABLE',
  })
  assert.equal(artifact.status, 201)
  const artifactRead = await request(ownerBase, `/governance/artifacts/${artifact.body.versionId}`)
  assert.equal(artifactRead.status, 200)
  assert.equal(artifactRead.body.content_hash, 'a'.repeat(64))
  await assert.rejects(
    pool.query('UPDATE governance_artifact_versions SET media_type=$1 WHERE version_id=$2', ['text/plain', artifact.body.versionId]),
    /governance record is immutable/,
  )
  assert.equal((await request(ownerBase, `/boards/${board.body.id}/cards/${created.body.id}`, 'DELETE')).status, 409)
  assert.equal((await request(ownerBase, `/boards/${board.body.id}/columns/${todo.id}`, 'DELETE')).status, 409)
  assert.equal((await request(ownerBase, `/boards/${board.body.id}`, 'DELETE')).status, 409)
  const heartbeat = await request(ownerBase, `/governance/attempts/${attempt.body.id}/heartbeat`, 'POST', { leaseGeneration: 1 })
  assert.equal(heartbeat.status, 200)
  const intervention = await request(ownerBase, `/governance/cards/${created.body.id}/interventions`, 'POST', {
    actionId: action.body.id, requestType: 'CLARIFICATION', options: ['continue'],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  })
  assert.equal(intervention.status, 201)
  const needsYou = await request(ownerBase, `/governance/interventions?cardId=${created.body.id}&state=OPEN`)
  assert.equal(needsYou.status, 200)
  assert.equal(needsYou.body.length, 1)
  const interventionResolution = await request(ownerBase, `/governance/interventions/${intervention.body.id}/resolve`, 'POST', { decision: 'RESOLVE', resolution: { choice: 'continue' } })
  assert.equal(interventionResolution.status, 200)
  const staleHeartbeat = await request(ownerBase, `/governance/attempts/${attempt.body.id}/heartbeat`, 'POST', { leaseGeneration: 2 })
  assert.equal(staleHeartbeat.status, 409)
  const finished = await request(ownerBase, `/governance/attempts/${attempt.body.id}/finish`, 'POST', { leaseGeneration: 1, outcome: 'SUCCEEDED', resultRef: artifact.body.versionId })
  assert.equal(finished.status, 200)
  assert.equal((await request(ownerBase, `/governance/claims/${claim.body.id}/release`, 'POST', { generation: claim.body.generation })).status, 200)
  const reviewerClaim = await request(ownerBase, `/governance/cards/${created.body.id}/claim`, 'POST', { agentId: 'agent-reviewer', mandateId: reviewerMandate.body.id, expectedEpoch: 1 })
  assert.equal(reviewerClaim.status, 201)
  const verifyAttempt = await request(ownerBase, `/governance/actions/${verifyAction.body.id}/attempts`, 'POST', {
    runtimeAssignmentId: reviewerRuntimeAssignmentId, planEpoch: 1, mandateId: reviewerMandate.body.id, mandateVersion: 1,
  })
  assert.equal(verifyAttempt.status, 201)
  for (const verification of shipping.body.verifications) {
    const verified = await request(reviewerBase, `/shipping/features/${shipping.body.id}/verifications/${verification.id}`, 'PATCH', {
      status: 'passed', evidence: [{ type: 'artifact', versionId: artifact.body.versionId }],
      verificationAttemptId: verifyAttempt.body.id, artifactVersionRefs: [artifact.body.versionId],
      candidateHash: 'a'.repeat(64), contractRevision: shipping.body.contractRevision,
    })
    assert.equal(verified.status, 200)
  }
  assert.equal((await request(ownerBase, `/shipping/features/${shipping.body.id}/transition`, 'POST', { status: 'ready' })).status, 200)
  assert.equal((await request(ownerBase, `/governance/attempts/${verifyAttempt.body.id}/finish`, 'POST', { leaseGeneration: 1, outcome: 'SUCCEEDED', resultRef: artifact.body.versionId })).status, 200)
  const submissionBody = {
    actionId: action.body.id, artifactVersionRefs: [artifact.body.versionId],
    producerPrincipalIds: ['agent-governance'], completionSummary: 'Candidate ready', expectedVersion: 4, expectedEpoch: 1,
  }
  const submission = await request(ownerBase, `/governance/cards/${created.body.id}/submissions`, 'POST', submissionBody, 'submission-one')
  assert.equal(submission.status, 201)
  const submissionReplay = await request(ownerBase, `/governance/cards/${created.body.id}/submissions`, 'POST', submissionBody, 'submission-one')
  assert.equal(submissionReplay.status, 200)
  assert.equal(submissionReplay.body.id, submission.body.id)
  const premature = await request(ownerBase, `/governance/cards/${created.body.id}/finalize`, 'POST', { submissionId: submission.body.id, comment: 'Too early', expectedVersion: 5, expectedEpoch: 1 })
  assert.equal(premature.status, 409)
  const review = await request(reviewerBase, `/governance/submissions/${submission.body.id}/reviews`, 'POST', { decision: 'ACCEPT', comment: 'Verified' })
  assert.equal(review.status, 201)
  const finalKey = 'finalize-one'
  const finalizedBody = { submissionId: submission.body.id, comment: 'Accepted', expectedVersion: 5, expectedEpoch: 1 }
  const finalized = await request(ownerBase, `/governance/cards/${created.body.id}/finalize`, 'POST', finalizedBody, finalKey)
  assert.equal(finalized.status, 200)
  assert.equal(finalized.body.state, 'DONE')
  const replay = await request(ownerBase, `/governance/cards/${created.body.id}/finalize`, 'POST', finalizedBody, finalKey)
  assert.equal(replay.status, 200)
  assert.deepEqual(replay.body, finalized.body)

  const state = await pool.query<any>('SELECT governance_state,accepted_submission_id FROM board_cards WHERE id=$1', [created.body.id])
  assert.equal(state.rows[0].governance_state, 'DONE')
  assert.equal(state.rows[0].accepted_submission_id, submission.body.id)
  assert.equal(Number((await pool.query('SELECT COUNT(*) AS n FROM governance_manifests WHERE card_id=$1', [created.body.id])).rows[0].n), 1)
  const timeline = await request(ownerBase, `/governance/cards/${created.body.id}/timeline`)
  assert.equal(timeline.status, 200)
  assert.ok(timeline.body.some((entry: any) => entry.event_type === 'MODEL_CALL_AUTHORIZED'))
  assert.ok(timeline.body.some((entry: any) => entry.event_type === 'MODEL_CALL_SETTLED'))
  assert.equal(timeline.body.at(-1).event_type, 'CARD_FINALIZED')
})
