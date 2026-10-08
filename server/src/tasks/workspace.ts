import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { TaskError, requireLiveGrant } from './contracts.js'
import type { TaskService, TaskPrincipal } from './service.js'
import { env } from '../env.js'

export class TaskWorkspaceService {
  constructor(readonly tasks: TaskService) {}

  async admit(principal: TaskPrincipal, input: { computerId: string; engine: string; binaryHash: string; verificationRef: string; checks: Record<string, unknown>; modelProvider?: 'server' | 'codex-login' }): Promise<void> {
    const required = ['filesystem', 'environment', 'process', 'network', 'freshSession', 'stoppedChildren']
    if (input.engine !== 'codex' || !/^[a-f0-9]{64}$/.test(input.binaryHash) || !input.verificationRef?.trim() || input.verificationRef.length > 2000 || required.some(key => input.checks?.[key] !== true)) throw new TaskError('RUNTIME_CAPABILITY_UNQUALIFIED',400)
    if (input.modelProvider !== undefined && !['server', 'codex-login'].includes(input.modelProvider)) throw new TaskError('LOCAL_MODEL_PROVIDER_NOT_ADMITTED', 400)
    await this.tasks.transaction(principal.companyId,async client=>{
      await this.tasks.administrator(client,principal)
      const device=await client.query(`SELECT 1 FROM computers WHERE company_id=$1 AND id=$2 AND kind<>'cloud' AND revoked_at IS NULL FOR SHARE`,[principal.companyId,input.computerId])
      if(!device.rowCount) throw new TaskError('RUNTIME_CAPABILITY_UNQUALIFIED',403)
      const live=await client.query(`SELECT 1 FROM task_dispatches d JOIN task_execution_contexts x ON x.id=d.context_id WHERE d.company_id=$1 AND x.computer_id=$2 AND d.stopped_at IS NULL AND d.state IN('CLAIMED','UNKNOWN','COMPLETED','BLOCKED')`,[principal.companyId,input.computerId])
      if(live.rowCount) throw new TaskError('EXECUTOR_NOT_STOPPED')
      await client.query(`INSERT INTO task_runtime_admissions(company_id,computer_id,protocol_version,engine,capabilities,verified_by,verification_ref)
        VALUES($1,$2,1,'codex',$3,$4,$5) ON CONFLICT(company_id,computer_id,engine) DO UPDATE SET capabilities=EXCLUDED.capabilities,verified_by=EXCLUDED.verified_by,verification_ref=EXCLUDED.verification_ref,revoked_at=NULL`,[principal.companyId,input.computerId,{platform:'linux',isolation:'bubblewrap',binaryHash:input.binaryHash,checks:input.checks,modelProvider:input.modelProvider ?? 'server'},principal.id,input.verificationRef])
      await client.query(`UPDATE task_execution_contexts SET revoked_at=NOW() WHERE company_id=$1 AND computer_id=$2`,[principal.companyId,input.computerId])
      await client.query(`UPDATE task_dispatches SET state='CANCELLED' WHERE company_id=$1 AND state='PENDING' AND context_id IN(SELECT id FROM task_execution_contexts WHERE company_id=$1 AND computer_id=$2)`,[principal.companyId,input.computerId])
    })
  }

  async reconcileExecutor(principal:TaskPrincipal,input:{ dispatchId:string; generation:number; proof:string }):Promise<void> {
    if(!Number.isInteger(input.generation) || !input.proof?.trim() || input.proof.length>2000) throw new TaskError('EXECUTOR_STOP_PROOF_REQUIRED',400)
    await this.tasks.transaction(principal.companyId,async client=>{
      await this.tasks.administrator(client,principal)
      const dispatch=(await client.query(`SELECT * FROM task_dispatches WHERE company_id=$1 AND id=$2 AND claim_generation=$3 FOR UPDATE`,[principal.companyId,input.dispatchId,input.generation])).rows[0]
      if(!dispatch || dispatch.stopped_at || !['UNKNOWN','BLOCKED','COMPLETED','CLAIMED'].includes(dispatch.state)) throw new TaskError('STALE_CLAIM')
      if(dispatch.state==='CLAIMED' && new Date(dispatch.lease_expires_at).getTime()>Date.now()) throw new TaskError('EXECUTOR_STILL_LEASED')
      await client.query(`UPDATE task_dispatches SET stopped_at=NOW(),state=CASE WHEN state IN('UNKNOWN','CLAIMED') THEN 'BLOCKED' ELSE state END WHERE id=$1`,[dispatch.id])
      await client.query(`UPDATE task_execution_contexts SET revoked_at=NOW() WHERE id=$1`,[dispatch.context_id])
      await client.query(`UPDATE agent_runs SET status='failed',error='EXECUTOR_STOP_CONFIRMED',finished_at=NOW() WHERE task_context_id=$1 AND status='running'`,[dispatch.context_id])
      await client.query(`INSERT INTO task_authorization_events(id,company_id,task_id,principal_id,operation,outcome,references_json) VALUES($1,$2,$3,$4,'executor.reconcile','STOP_CONFIRMED',$5)`,[randomUUID(),principal.companyId,dispatch.task_id,principal.id,{generation:input.generation,proof:input.proof}])
    })
  }

  async automation(principal:TaskPrincipal,input:{ channelId:string; bindingId:string; reason:string; grantIds:string[]; key:string }):Promise<void> {
    if(!['manual','idle','background_scan','poll.updated'].includes(input.reason) || !input.key?.trim() || input.key.length>120) throw new TaskError('INVALID_AUTOMATION',400)
    await this.tasks.transaction(principal.companyId,async client=>{
      await this.tasks.administrator(client,principal)
      await this.tasks.member(client,principal,input.channelId)
      const binding=await this.tasks.binding(client,principal.companyId,input.channelId,input.bindingId)
      const grants=await client.query(`SELECT * FROM access_grants WHERE company_id=$1 AND conversation_id=$2 AND id=ANY($3::text[]) FOR SHARE`,[principal.companyId,input.channelId,input.grantIds])
      if(grants.rows.length!==new Set(input.grantIds).size) throw new TaskError('GRANT_NOT_FOUND',403)
      for(const row of grants.rows){requireLiveGrant(row,row.version);if(row.caller_principal_id!==principal.id) throw new TaskError('GRANT_CALLER_DENIED',403)}
      const grant=await client.query(`SELECT 1 FROM access_grants WHERE company_id=$1 AND id=ANY($2::text[]) AND caller_principal_id=$3 AND rule->'actions' @> $4::jsonb`,[principal.companyId,input.grantIds,principal.id,JSON.stringify([`automate:${input.reason}`])])
      if(!grant.rowCount) throw new TaskError('AUTOMATION_AUTHORITY_REQUIRED',403)
      const settings=(await client.query(`SELECT policy FROM task_workspace_settings WHERE company_id=$1 FOR UPDATE`,[principal.companyId])).rows[0]
      if(!settings) throw new TaskError('PREPARATION_REQUIRED')
      const policies=Array.isArray(settings.policy?.automations)?settings.policy.automations:[]
      const item={...input,principalId:principal.id,agentId:binding.agent_id}
      await client.query(`UPDATE task_workspace_settings SET policy=jsonb_set(policy,'{automations}',$2::jsonb),updated_at=NOW() WHERE company_id=$1`,[principal.companyId,JSON.stringify([...policies.filter((policy:{key:string})=>policy.key!==input.key),item])])
    })
  }

  async gc(principal:TaskPrincipal):Promise<number> {
    return this.tasks.transaction(principal.companyId,async client=>{
      await this.tasks.administrator(client,principal)
      const removed=await client.query(`DELETE FROM artifact_versions a WHERE a.company_id=$1 AND a.retention_until<=NOW() AND a.governance_version_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM channel_tasks t WHERE t.id=a.task_id AND t.status IN('OPEN','BLOCKED'))
        AND NOT EXISTS(SELECT 1 FROM artifact_handoffs h WHERE h.company_id=a.company_id AND h.version_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM task_deliveries d WHERE d.company_id=a.company_id AND (d.artifact_ids @> jsonb_build_array(a.id) OR d.evidence_ids @> jsonb_build_array(a.id)))
        AND NOT EXISTS(SELECT 1 FROM knowledge_entries k WHERE k.company_id=a.company_id AND k.provenance->'sources' @> jsonb_build_array(jsonb_build_object('kind','ARTIFACT','id',a.id)))
        AND NOT EXISTS(SELECT 1 FROM task_inputs i WHERE i.company_id=a.company_id AND (i.reference_id=a.id OR i.provenance->'sources' @> jsonb_build_array(jsonb_build_object('kind','ARTIFACT','id',a.id)))) RETURNING id`,[principal.companyId])
      return removed.rowCount??0
    })
  }

  async readiness(client: PoolClient, companyId: string): Promise<string[]> {
    const failures: string[] = []
    const schema=await client.query(`SELECT MAX(version) AS version FROM schema_migrations`)
    if(Number(schema.rows[0].version)<19) return ['TASK_SCHEMA_MIGRATION_REQUIRED']
    const running = await client.query(`SELECT 1 FROM agent_runs WHERE company_id=$1 AND status='running' AND finished_at IS NULL LIMIT 1`, [companyId])
    if (running.rowCount) failures.push('LEGACY_OR_TASK_EXECUTOR_RUNNING')
    const convene=await client.query(`SELECT 1 FROM convene_sessions WHERE company_id=$1 AND state='live' LIMIT 1`,[companyId])
    if(convene.rowCount)failures.push('LEGACY_CONVENE_RUNNING')
    const unknown = await client.query(`SELECT 1 FROM task_dispatches WHERE company_id=$1 AND stopped_at IS NULL AND state IN('CLAIMED','UNKNOWN','COMPLETED','BLOCKED') LIMIT 1`, [companyId])
    if (unknown.rowCount) failures.push('EXECUTOR_NOT_STOPPED')
    const operations = await client.query(`SELECT 1 FROM task_operation_records WHERE company_id=$1 AND state IN('DISPATCHED','UNKNOWN') LIMIT 1`, [companyId])
    if (operations.rowCount) failures.push('EXTERNAL_OPERATION_UNKNOWN')
    const channels = await client.query(`SELECT c.id FROM conversations c WHERE c.company_id=$1 AND EXISTS(
      SELECT 1 FROM conversation_members m JOIN participants p ON p.id=m.participant_id AND p.company_id=m.company_id
      WHERE m.conversation_id=c.id AND p.kind='agent' AND p.departed_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM channel_agent_bindings b WHERE b.company_id=c.company_id AND b.conversation_id=c.id AND b.status='ACTIVE' AND b.is_default)`, [companyId])
    if (channels.rowCount) failures.push('CHANNEL_DEFAULT_MISSING')
    const local = await client.query(`SELECT p.id FROM participants p LEFT JOIN computers c ON c.id=p.computer_id AND c.company_id=p.company_id
      WHERE p.company_id=$1 AND p.kind='agent' AND p.departed_at IS NULL AND p.computer_id IS NOT NULL AND
      (c.id IS NULL OR c.revoked_at IS NOT NULL OR (c.kind='cloud' AND p.engine IS NOT NULL AND p.engine<>'managed') OR (c.kind<>'cloud' AND NOT EXISTS(SELECT 1 FROM task_runtime_admissions a WHERE a.company_id=p.company_id AND a.computer_id=p.computer_id AND a.engine=p.engine AND a.revoked_at IS NULL)))`, [companyId])
    const unassigned=await client.query(`SELECT 1 FROM participants WHERE company_id=$1 AND kind='agent' AND departed_at IS NULL AND computer_id IS NULL AND engine IS NOT NULL AND engine<>'managed' LIMIT 1`,[companyId])
    if (local.rowCount || unassigned.rowCount) failures.push('RUNTIME_CAPABILITY_UNQUALIFIED')
    if (env.LOCAL_ONLY) {
      const server = await client.query(`SELECT 1 FROM participants p LEFT JOIN computers c ON c.id=p.computer_id AND c.company_id=p.company_id
        LEFT JOIN task_runtime_admissions a ON a.company_id=p.company_id AND a.computer_id=p.computer_id AND a.engine=p.engine AND a.revoked_at IS NULL
        WHERE p.company_id=$1 AND p.kind='agent' AND p.departed_at IS NULL AND
          (c.id IS NULL OR c.kind='cloud' OR a.capabilities->>'modelProvider' IS DISTINCT FROM 'codex-login') LIMIT 1`, [companyId])
      if (server.rowCount) failures.push('SERVER_MODEL_UNAVAILABLE')
    }
    return failures
  }

  async activate(principal: TaskPrincipal): Promise<void> {
    await this.tasks.transaction(principal.companyId, async (client) => {
      await this.tasks.administrator(client, principal)
      const settings = await client.query<{ mode: string }>('SELECT mode FROM task_workspace_settings WHERE company_id=$1 FOR UPDATE', [principal.companyId])
      if (settings.rows[0]?.mode !== 'PREPARING') throw new TaskError('PREPARATION_REQUIRED')
      const failures = await this.readiness(client, principal.companyId)
      if (failures.length) throw new TaskError(`WORKSPACE_NOT_READY:${failures.join(',')}`)
      await client.query(`UPDATE task_workspace_settings SET mode='TASK',generation=generation+1,policy=policy||'{"taskEstablished":true}'::jsonb,updated_at=NOW() WHERE company_id=$1`, [principal.companyId])
    })
  }

  async stop(principal: TaskPrincipal): Promise<void> {
    await this.tasks.transaction(principal.companyId, async (client) => {
      await this.tasks.administrator(client, principal)
      // PREPARING pauses task execution. Resuming LEGACY requires proof all task executors/operations stopped.
      await client.query(`UPDATE task_workspace_settings SET mode='PREPARING',generation=generation+1,updated_at=NOW() WHERE company_id=$1`, [principal.companyId])
      await client.query(`UPDATE task_execution_contexts SET revoked_at=NOW() WHERE company_id=$1`, [principal.companyId])
      await client.query(`UPDATE task_dispatches SET state=CASE WHEN state='PENDING' THEN 'CANCELLED' ELSE 'UNKNOWN' END WHERE company_id=$1 AND state IN('PENDING','CLAIMED')`, [principal.companyId])
    })
  }

  async rollback(principal: TaskPrincipal): Promise<void> {
    await this.tasks.transaction(principal.companyId, async (client) => {
      await this.tasks.administrator(client, principal)
      const failures = (await this.readiness(client, principal.companyId)).filter((code) => ['EXECUTOR_NOT_STOPPED', 'EXTERNAL_OPERATION_UNKNOWN', 'LEGACY_OR_TASK_EXECUTOR_RUNNING','LEGACY_CONVENE_RUNNING','TASK_SCHEMA_MIGRATION_REQUIRED'].includes(code))
      if (failures.length) throw new TaskError(`ROLLBACK_NOT_READY:${failures.join(',')}`)
      await client.query(`UPDATE task_workspace_settings SET mode='LEGACY',generation=generation+1,updated_at=NOW() WHERE company_id=$1 AND mode='PREPARING'`, [principal.companyId])
    })
  }
}
