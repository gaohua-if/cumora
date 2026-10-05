import { randomUUID } from 'node:crypto'
import { TaskError, authorizeTuple, canonicalJson, hashContent, requireLiveGrant, parseProvenance } from './contracts.js'
import { TaskExecutionService, type Claim } from './execution.js'
import { TaskService, type TaskPrincipal } from './service.js'

export interface CheckedOperation {
  key: string; grantId: string; resource: string; action: string; identity: string; destination: string; payload: Record<string, unknown>
}
/** The effect is a qualified adapter, supplied by trusted server code, never model code. */
export class TaskOperationService {
  constructor(readonly tasks: TaskService) {}
  async execute(companyId: string, claim: Claim, request: CheckedOperation, effect: (request: CheckedOperation) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    if (!request.key || request.key.length > 160 || !request.payload || Buffer.byteLength(canonicalJson(request.payload)) > 100000) throw new TaskError('INVALID_OPERATION',400)
    const digest = hashContent(canonicalJson(request))
    const record = await this.tasks.transaction(companyId, async client => {
      const resolved = await new TaskExecutionService(this.tasks).resolve(client,companyId,claim,'artifact')
      if(['COORDINATOR','AIDA','VERIFY'].includes(String(resolved.task.configuration.role)) && !(request.action==='read' || request.action==='publish' && request.resource===`channel:${resolved.task.conversation_id}`))throw new TaskError('TASK_DIRECT_OPERATION_DENIED',403)
      const prior = (await client.query(`SELECT * FROM task_operation_records WHERE company_id=$1 AND task_id=$2 AND operation_key=$3 FOR UPDATE`,[companyId,resolved.task.id,request.key])).rows[0]
      if (prior) {
        if (prior.request_hash !== digest) throw new TaskError('OPERATION_KEY_CONFLICT')
        if (prior.state === 'SUCCEEDED') return prior
        throw new TaskError('EXTERNAL_OPERATION_UNKNOWN')
      }
      const grant = (await client.query(`SELECT g.*,v.rule AS task_rule,v.source_version FROM task_grant_versions v JOIN access_grants g ON g.id=v.source_grant_id AND g.company_id=v.company_id
        WHERE v.company_id=$1 AND v.task_id=$2 AND v.id=$3 AND v.scope_revision=$4 AND v.revoked_at IS NULL FOR SHARE OF v,g`,[companyId,resolved.task.id,request.grantId,resolved.task.scope_revision])).rows[0]
      if (!grant) throw new TaskError('OPERATION_GRANT_REQUIRED',403)
      requireLiveGrant(grant,grant.source_version)
      authorizeTuple([grant.task_rule],{resource:request.resource,action:request.action,identity:request.identity,audience:resolved.provenance.audience,destination:request.destination})
      await this.tasks.liveSources(client,parseProvenance(resolved.provenance),resolved.task,request.destination)
      const id=randomUUID()
      await client.query(`INSERT INTO task_operation_records(id,company_id,task_id,context_id,operation_key,request_hash,request,state) VALUES($1,$2,$3,$4,$5,$6,$7,'DISPATCHED')`,[id,companyId,resolved.task.id,claim.contextId,request.key,digest,request])
      return {id,state:'DISPATCHED',result:null}
    })
    if(record.state==='SUCCEEDED') return record.result
    try {
      const result=await effect(structuredClone(request))
      await this.tasks.pool.query(`UPDATE task_operation_records SET state='SUCCEEDED',result=$3 WHERE company_id=$1 AND id=$2 AND state='DISPATCHED'`,[companyId,record.id,result])
      return result
    } catch(error) {
      await this.tasks.pool.query(`UPDATE task_operation_records SET state='UNKNOWN' WHERE company_id=$1 AND id=$2 AND state='DISPATCHED'`,[companyId,record.id])
      throw new TaskError('EXTERNAL_OPERATION_UNKNOWN')
    }
  }
  async reconcile(principal:TaskPrincipal,id:string,outcome:'SUCCEEDED'|'FAILED',proof:string,result:Record<string,unknown>):Promise<void> {
    if(!proof?.trim() || proof.length>2000) throw new TaskError('OPERATION_STOP_PROOF_REQUIRED',400)
    await this.tasks.transaction(principal.companyId,async client=>{
      await this.tasks.administrator(client,principal)
      const operation=(await client.query(`SELECT * FROM task_operation_records WHERE company_id=$1 AND id=$2 FOR UPDATE`,[principal.companyId,id])).rows[0]
      if(!operation || !['UNKNOWN','DISPATCHED'].includes(operation.state)) throw new TaskError('OPERATION_NOT_UNKNOWN')
      // Administrative reconciliation records observed effect and stopped sender. It never retries it.
      const dispatch=await client.query(`SELECT 1 FROM task_dispatches WHERE company_id=$1 AND context_id=$2 AND stopped_at IS NOT NULL`,[principal.companyId,operation.context_id])
      if(!dispatch.rowCount) throw new TaskError('EXECUTOR_NOT_STOPPED')
      await client.query(`UPDATE task_operation_records SET state=$3,result=$4 WHERE company_id=$1 AND id=$2`,[principal.companyId,id,outcome,result])
      await client.query(`INSERT INTO task_authorization_events(id,company_id,task_id,principal_id,operation,outcome,references_json) VALUES($1,$2,$3,$4,'operation.reconcile',$5,$6)`,[randomUUID(),principal.companyId,operation.task_id,principal.id,outcome,{proof,result}])
    })
  }
}
