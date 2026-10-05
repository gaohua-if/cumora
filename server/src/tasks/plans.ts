import { checkTaskGovernance } from './governance.js'
import { randomUUID } from 'node:crypto'
import { TaskError, validatePlan, parseProvenance, requireLiveGrant, attenuateRule, hashContent, type TaskPlan } from './contracts.js'
import { TaskService, type TaskRecord } from './service.js'
import { TaskExecutionService, type Claim } from './execution.js'

export class TaskPlanService {
  constructor(readonly tasks: TaskService) {}

  async propose(companyId: string, claim: Claim, proposal: unknown): Promise<string> {
    return this.tasks.transaction(companyId, async (client) => {
      const resolved = await new TaskExecutionService(this.tasks).resolve(client, companyId, claim)
      const root = resolved.task
      if (root.parent_task_id) throw new TaskError('DELEGATION_DEPTH_EXCEEDED', 403)
      const old = await client.query(`SELECT 1 FROM task_plan_versions WHERE company_id=$1 AND task_id=$2 AND (plan->>'scopeRevision')::int=$3`, [companyId, root.id,root.scope_revision])
      if (old.rowCount) throw new TaskError('PLAN_ALREADY_COMMITTED')
      const bindings = await client.query<{ id: string }>(`SELECT id FROM channel_agent_bindings WHERE company_id=$1 AND conversation_id=$2 AND status='ACTIVE'`, [companyId, root.conversation_id])
      const plan = validatePlan(proposal, new Set(bindings.rows.map((row) => row.id)))
      const grantRows = await client.query(`SELECT v.*,g.version AS live_version,g.revoked_at AS live_revoked,g.expires_at AS live_expires
        FROM task_grant_versions v JOIN access_grants g ON g.id=v.source_grant_id AND g.company_id=v.company_id WHERE v.company_id=$1 AND v.task_id=$2 AND v.scope_revision=$3 AND v.revoked_at IS NULL FOR SHARE OF v,g`, [companyId, root.id, root.scope_revision])
      const grants = new Map(grantRows.rows.map((row) => [row.id, row]))
      const revision = (await client.query(`SELECT COALESCE(MAX(revision),0)+1 AS next FROM task_plan_versions WHERE company_id=$1 AND task_id=$2`, [companyId,root.id])).rows[0].next
      const ids = new Map(plan.members.map((member) => [member.key, randomUUID()]))
      for (const member of plan.members) {
        const childBinding=await this.tasks.binding(client, companyId, root.conversation_id, member.bindingId)
        let childAction:string|null=null
        if(root.governance_attempt_id){
          const allowed=await client.query(`SELECT 1 FROM governance_actions a JOIN governance_action_attempts at ON at.id=a.active_attempt_id JOIN governance_mandates m ON m.id=at.mandate_id AND m.mandate_version=at.mandate_version WHERE a.company_id=$1 AND a.id=$2 AND a.remaining_delegation_depth=1 AND m.max_delegation_depth=1 AND m.allowed_delegatee_ids @> $3::jsonb`,[companyId,root.governance_action_id,JSON.stringify([childBinding.agent_id])])
          const action=(await client.query(`SELECT a.id FROM governance_action_attempts at JOIN governance_actions a ON a.id=at.action_id AND a.company_id=at.company_id WHERE at.company_id=$1 AND at.id=$2 AND a.parent_action_id=$3 AND a.card_id=$4 AND a.purpose=$5 AND a.remaining_delegation_depth=0`,[companyId,member.governanceAttemptId??null,root.governance_action_id,root.board_card_id,member.role==='VERIFY'?'VERIFY':'PRODUCE'])).rows[0]
          if(!allowed.rowCount || !action) throw new TaskError('GOVERNANCE_DELEGATION_DENIED',403)
          childAction=action.id
        } else if(member.governanceAttemptId) throw new TaskError('GOVERNANCE_MAPPING_REQUIRED',403)
        if (member.role === 'VERIFY' && member.dependsOn.some((key) => plan.members.find((dependency) => dependency.key === key)?.bindingId === member.bindingId)) throw new TaskError('VERIFIER_MUST_BE_INDEPENDENT', 403)
        const taskId = ids.get(member.key)!
        await client.query(`INSERT INTO channel_tasks(id,company_id,conversation_id,creator_principal_id,accountable_binding_id,parent_task_id,root_task_id,objective,ingress_key,board_card_id,governance_action_id,governance_attempt_id,definition_version_id,configuration)
          VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13)`, [taskId, companyId, root.conversation_id, root.creator_principal_id, member.bindingId, root.id, member.objective, `plan:${root.id}:${revision}:${member.key}`,root.board_card_id,childAction,member.governanceAttemptId??null,childBinding.definition_version_id,{instructions:childBinding.configuration.instructions??childBinding.definition.instructions??'',role:member.role==='VERIFY'?'VERIFY':childBinding.definition.role??null}])
        await client.query(`INSERT INTO task_scope_revisions(company_id,task_id,revision,objective,changed_by) VALUES($1,$2,1,$3,$4)`, [companyId, taskId, member.objective, root.creator_principal_id])
        const child = (await client.query<TaskRecord>(`SELECT * FROM channel_tasks WHERE company_id=$1 AND id=$2`, [companyId, taskId])).rows[0]
        await checkTaskGovernance(client,child,childBinding)
        await this.tasks.addInput(client, { companyId, id: root.creator_principal_id }, child, { text: member.objective })
        for (const input of resolved.inputs) {
          await client.query(`INSERT INTO task_inputs(id,company_id,task_id,kind,content,content_hash,provenance,input_revision) VALUES($1,$2,$3,'TEXT',$4,$5,$6,1)`,
            [randomUUID(), companyId, taskId, input.content, hashContent(input.content), input.provenance])
        }
        for (const grantId of member.grantIds) {
          const parent = grants.get(grantId)
          if (!parent) throw new TaskError('CHILD_GRANT_NOT_IN_ROOT', 403)
          const rule = requireLiveGrant({ ...parent, version: parent.live_version, revoked_at: parent.live_revoked, expires_at: parent.live_expires }, parent.source_version)
          // Verification is read-only on source resources; it may still write its own report artifact.
          const actions = member.role === 'VERIFY' ? rule.actions.filter((action) => action === 'read' || action === 'publish') : rule.actions
          if (!actions.length) throw new TaskError('CHILD_GRANT_NOT_ATTENUATED', 403)
          const childRule = attenuateRule(rule, { ...rule, actions })
          await client.query(`INSERT INTO task_grant_versions(id,company_id,task_id,source_grant_id,source_version,scope_revision,rule,parent_grant_id) VALUES($1,$2,$3,$4,$5,1,$6,$7)`,
            [randomUUID(), companyId, taskId, parent.source_grant_id, parent.source_version, childRule, parent.id])
        }
      }
      for (const member of plan.members) for (const dependency of member.dependsOn) await client.query(`INSERT INTO task_dependencies(company_id,task_id,dependency_task_id) VALUES($1,$2,$3)`, [companyId, ids.get(member.key), ids.get(dependency)])
      const id = randomUUID()
      const stored = { ...plan, members: plan.members.map((member) => ({ ...member, taskId: ids.get(member.key) })), scopeRevision: root.scope_revision }
      await client.query(`INSERT INTO task_plan_versions(id,company_id,task_id,revision,plan,created_by) VALUES($1,$2,$3,$4,$5,$6)`, [id, companyId, root.id,revision, stored, root.creator_principal_id])
      await client.query(`UPDATE channel_tasks SET status='BLOCKED',blocked_code='AWAITING_CHILDREN' WHERE company_id=$1 AND id=$2`, [companyId, root.id])
      await client.query(`UPDATE task_dispatches SET state='UNKNOWN' WHERE company_id=$1 AND id=$2`, [companyId, claim.id])
      return id
    })
  }

  async handoff(companyId: string, producerTaskId: string, consumerTaskId: string): Promise<void> {
    await this.tasks.transaction(companyId, async (client) => {
      const tasks = await client.query<TaskRecord>(`SELECT * FROM channel_tasks WHERE company_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE`, [companyId, [producerTaskId, consumerTaskId]])
      const producer = tasks.rows.find((task) => task.id === producerTaskId)
      const consumer = tasks.rows.find((task) => task.id === consumerTaskId)
      if (!producer || !consumer || producer.status !== 'DELIVERED' || producer.root_task_id !== consumer.root_task_id || producer.conversation_id !== consumer.conversation_id ||
        !['OPEN', 'BLOCKED'].includes(consumer.status)) throw new TaskError('HANDOFF_NOT_READY')
      await this.tasks.binding(client, companyId, consumer.conversation_id, consumer.accountable_binding_id)
      const deliveries = await client.query(`SELECT artifact_ids,scope_revision FROM task_deliveries WHERE company_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 1`, [companyId, producerTaskId])
      if (deliveries.rows[0]?.scope_revision !== producer.scope_revision) throw new TaskError('HANDOFF_SCOPE_STALE')
      const versions = await client.query(`SELECT * FROM artifact_versions WHERE company_id=$1 AND id=ANY($2::text[]) ORDER BY id`, [companyId, deliveries.rows[0].artifact_ids])
      for (const version of versions.rows) {
        if (hashContent(version.content) !== version.content_hash) throw new TaskError('ARTIFACT_HASH_MISMATCH', 403)
        const p = parseProvenance(version.provenance)
        await this.tasks.liveSources(client, p, consumer, 'task-model')
        const inserted = await client.query(`INSERT INTO artifact_handoffs(company_id,version_id,consumer_task_id,consumer_binding_id,content_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING version_id`,
          [companyId, version.id, consumer.id, consumer.accountable_binding_id, version.content_hash])
        if (inserted.rowCount) await client.query(`INSERT INTO task_inputs(id,company_id,task_id,kind,reference_id,content,content_hash,provenance,input_revision) VALUES($1,$2,$3,'ARTIFACT',$4,$5,$6,$7,$8)`,
          [randomUUID(), companyId, consumer.id, version.id, version.content.toString('utf8'), version.content_hash,
            { ...p, sources: [{ kind: 'ARTIFACT', id: version.id, version: 1 }] }, consumer.input_revision])
      }
    })
  }

  async advance(companyId: string, rootTaskId: string): Promise<void> {
    const result = await this.tasks.pool.query(`SELECT p.plan,p.revision AS plan_revision,t.* FROM task_plan_versions p JOIN channel_tasks t ON t.id=p.task_id AND t.company_id=p.company_id
      WHERE p.company_id=$1 AND p.task_id=$2 AND t.status IN('OPEN','BLOCKED') ORDER BY p.revision DESC LIMIT 1`, [companyId, rootTaskId])
    if (!result.rows[0]) return
    const root = result.rows[0]
    const plan = root.plan as Omit<TaskPlan, 'members'> & { scopeRevision: number; members: (TaskPlan['members'][number] & { taskId: string })[] }
    if (plan.scopeRevision !== root.scope_revision) throw new TaskError('PLAN_SCOPE_STALE')
    const children = await this.tasks.pool.query<TaskRecord>(`SELECT * FROM channel_tasks WHERE company_id=$1 AND id=ANY($2::text[])`, [companyId, plan.members.map((member)=>member.taskId)])
    const byId = new Map(children.rows.map((task) => [task.id, task]))
    if (children.rows.some((child) => child.status === 'CANCELLED')) throw new TaskError('PLAN_CHILD_CANCELLED')
    let active = (await this.tasks.pool.query(`SELECT 1 FROM task_dispatches WHERE company_id=$1 AND task_id=ANY($2::text[]) AND state IN('PENDING','CLAIMED','UNKNOWN') AND stopped_at IS NULL`, [companyId, children.rows.map((task) => task.id)])).rowCount ?? 0
    for (const member of plan.members) {
      const child = byId.get(member.taskId)
      if (!child || child.status === 'DELIVERED') continue
      const prior = await this.tasks.pool.query(`SELECT 1 FROM task_dispatches WHERE company_id=$1 AND dispatch_key=$2`, [companyId, `${member.taskId}:plan:${root.plan_revision}`])
      if (prior.rowCount || active >= plan.parallelism) continue
      if (!member.dependsOn.every((key) => byId.get(plan.members.find((dependency) => dependency.key === key)!.taskId)?.status === 'DELIVERED')) continue
      for (const key of member.dependsOn) await this.handoff(companyId, plan.members.find((dependency) => dependency.key === key)!.taskId, member.taskId)
      await this.tasks.drive({ companyId, id: root.creator_principal_id }, member.taskId, `plan:${root.plan_revision}`)
      active++
    }
    if (children.rows.length && children.rows.every((task) => task.status === 'DELIVERED')) {
      for (const child of children.rows) await this.handoff(companyId, child.id, rootTaskId)
      await this.tasks.drive({ companyId, id: root.creator_principal_id }, rootTaskId, `plan:aggregate:${root.plan_revision}`)
    }
  }
}
