import { useEffect, useState } from 'react'
import { http } from '@/api/client'
import { useTaskSelection } from '@/stores/tasks'
import { getMeId } from '@/stores/auth'
import { pendingCreateRequestId } from '@/lib/create-idempotency'
import { downloadTaskArtifact } from '@/lib/task-artifacts'
import { ChannelTaskSettings } from './TaskSettings'
import { GroupAida } from './GroupAida'

interface ChannelTask {
  id: string; objective: string; status: string; blocked_code: string | null; creator_principal_id: string
  parent_task_id: string | null
}
interface Delivery { id: string; artifact_ids: string[]; limitations: string[] }

export function TaskContextPanel({ channelId }: { channelId: string }) {
  const reference = useTaskSelection((state) => state.references[channelId] ?? '')
  const select = useTaskSelection((state) => state.select)
  const [tasks, setTasks] = useState<ChannelTask[]>([])
  const [enabled, setEnabled] = useState(false)
  const [error, setError] = useState('')
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    const refresh = async () => {
      try {
        const state = await http<{ mode: string }>(`/tasks/channel-state?channelId=${encodeURIComponent(channelId)}`)
        if (!alive) return
        setEnabled(state.mode === 'TASK' || state.mode === 'PAUSED')
        if (state.mode === 'TASK' || state.mode === 'PAUSED') {
          const rows = await http<ChannelTask[]>(`/tasks?channelId=${encodeURIComponent(channelId)}`)
          if (alive) setTasks(rows.filter((task) => !task.parent_task_id))
        }
      } catch (failure) { if (alive) setError(failure instanceof Error ? failure.message : '任务加载失败') }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [channelId])
  useEffect(() => {
    let alive = true
    setDeliveries([])
    if (reference && reference !== 'new') void http<{ deliveries: Delivery[] }>(`/tasks/${encodeURIComponent(reference)}`).then((task) => {
      if (alive) setDeliveries(task.deliveries)
    }).catch((failure) => { if (alive) setError(String(failure)) })
    return () => { alive = false }
  }, [reference, tasks])
  const selected = tasks.find((task) => task.id === reference)
  const activeCount = tasks.filter((task) => ['OPEN', 'BLOCKED'].includes(task.status)).length
  const act = async (action: 'drive' | 'cancel') => {
    if (!selected || busy) return
    setBusy(true)
    const pending = pendingCreateRequestId(`task:${selected.id}:${action}`, {})
    try {
      await http(`/tasks/${encodeURIComponent(selected.id)}/${action}`, { method: 'POST', body: JSON.stringify(action === 'drive' ? { key: `ui:${pending.requestId}` } : {}) })
      pending.complete()
      setError('')
      setTasks((await http<ChannelTask[]>(`/tasks?channelId=${encodeURIComponent(channelId)}`)).filter(task => !task.parent_task_id))
    } catch (failure) { pending.fail(failure); setError(failure instanceof Error ? failure.message : '操作失败') }
    finally { setBusy(false) }
  }
  const download = async (id: string) => {
    try {
      const artifact = await http<{ content: string; mediaType: string; hash: string }>(`/tasks/artifacts/${encodeURIComponent(id)}`)
      downloadTaskArtifact(id, artifact)
      setError('')
    } catch (failure) { setError(failure instanceof Error ? failure.message : '产物读取失败') }
  }
  return <><GroupAida channelId={channelId} /><ChannelTaskSettings channelId={channelId} />{enabled && <div className="mb-2 rounded-lg border border-ink-100 p-2 text-xs text-ink-700" aria-label="频道任务">
    <label className="flex items-center gap-2">任务
      <select className="min-w-0 flex-1 bg-transparent" value={reference} onChange={(event) => { select(channelId, event.target.value); setError('') }}>
        <option value="">{activeCount > 1 ? '请选择任务后发送' : '自动关联当前任务'}</option>
        <option value="new">创建新任务</option>
        {tasks.map((task) => <option key={task.id} value={task.id}>{task.status === 'BLOCKED' ? '阻塞' : task.status === 'DELIVERED' ? '已交付' : task.status === 'CANCELLED' ? '已取消' : '进行中'} · {task.objective.slice(0, 60)}</option>)}
      </select>
    </label>
    {selected?.status === 'BLOCKED' && selected.blocked_code && <p role="status">阻塞原因：{selected.blocked_code}</p>}
    {selected && selected.creator_principal_id === getMeId() && ['OPEN', 'BLOCKED'].includes(selected.status) && <div className="mt-1 flex gap-3">
      <button type="button" disabled={busy} onClick={() => { void act('drive') }}>继续执行</button>
      <button type="button" disabled={busy} onClick={() => { void act('cancel') }}>取消任务</button>
    </div>}
    {deliveries.map((delivery) => <div key={delivery.id} className="mt-1 flex flex-wrap gap-2">
      {delivery.artifact_ids.map((id, index) => <button type="button" key={id} onClick={() => { void download(id) }}>下载产物 {index + 1}</button>)}
      {delivery.limitations.map((limitation) => <span key={limitation}>{limitation}</span>)}
    </div>)}
    {(error || (!reference && activeCount > 1)) && <p role="alert">{error || '此频道有多个未完成任务，请明确选择任务或创建新任务。'}</p>}
  </div>}</>
}
