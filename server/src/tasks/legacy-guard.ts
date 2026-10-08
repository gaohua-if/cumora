import { pool } from '../db/pool.js'
import { TaskService } from './service.js'
import { TaskError } from './contracts.js'

export const taskService = new TaskService(pool)

export async function agentTaskMode(agentId: string): Promise<boolean> {
  const participants = await pool.query<{ company_id: string }>(`SELECT company_id FROM participants WHERE id=$1 AND kind='agent' AND departed_at IS NULL`, [agentId])
  for (const participant of participants.rows) if (await taskService.protectsLegacy(participant.company_id)) return true
  return false
}

export async function requireLegacyAgent(agentId: string): Promise<void> {
  if (await agentTaskMode(agentId)) throw new TaskError('TASK_CONTEXT_REQUIRED', 403)
}

/** Retained Task messages never become new legacy work after rollback. */
export async function taskMessageIds(ids:string[]):Promise<Set<string>> {
  if(!ids.length)return new Set()
  const table=(await pool.query(`SELECT to_regclass('task_message_links') AS tasks`)).rows[0].tasks
  if(!table)return new Set()
  const linked=await pool.query<{message_id:string}>(`SELECT l.message_id FROM messages m JOIN task_message_links l
    ON l.company_id=m.company_id AND l.message_id=m.id JOIN channel_tasks t ON t.id=l.task_id AND t.company_id=l.company_id
    WHERE m.id=ANY($1::text[]) AND t.execution_kind='TASK'`,[[...new Set(ids)]])
  return new Set(linked.rows.map(row=>row.message_id))
}

export async function withoutTaskMessages<T extends {id:string;quoted_message_id?:string|null;quoted?:unknown}>(rows:T[]):Promise<T[]> {
  const linked=await taskMessageIds(rows.flatMap(row=>[row.id,...(row.quoted_message_id?[row.quoted_message_id]:[])]))
  return rows.filter(row=>{
    if(linked.has(row.id))return false
    if(row.quoted_message_id && linked.has(row.quoted_message_id))row.quoted=null
    return true
  })
}
