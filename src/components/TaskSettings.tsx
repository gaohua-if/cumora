import { useCallback, useEffect, useState } from 'react'
import { http } from '@/api/client'
import { useAuth } from '@/stores/auth'
import { useApp } from '@/stores/app'

interface Definition { id: string; definition_id: string; version: number; body: { name?: string; role?: string; instructions?: string } }
interface Binding { id: string; channel_id: string; agent_id: string; definition_version_id: string; alias: string; is_default: boolean; configuration: { instructions?: string } }
interface Configuration {
  channels: { id: string; title: string | null; kind: string }[]
  agents: { id: string; channel_id: string; name: string; computer_id: string | null; engine: string | null; computer_name: string | null; computer_status: string | null }[]
  definitions: Definition[]; bindings: Binding[]
  computers: { id: string; name: string; kind: string; status: string; engine?: string; capabilities?: { binaryHash?: string; modelProvider?: string }; verification_ref?: string }[]
}
const field = 'w-full rounded border border-ink-100 bg-paper p-2 text-xs'
const button = 'rounded border border-ink-100 px-2 py-1.5 text-xs disabled:opacity-40 hover:bg-cloud'

/** Shared by workspace settings and channel entry, including mobile/LEGACY. */
export function TaskSettings({ channelId, companyId }: { channelId?: string; companyId: string }) {
  const [config, setConfig] = useState<Configuration | null>(null)
  const [workspace, setWorkspace] = useState<{ mode: string; failures: string[] } | null>(null)
  const [channel, setChannel] = useState(channelId ?? '')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [definitionId, setDefinitionId] = useState('aida')
  const [name, setName] = useState('Aida')
  const [role, setRole] = useState('COORDINATOR')
  const [instructions, setInstructions] = useState('负责当前频道任务。需要协作时使用当前频道成员提出一层计划；单 Agent 时直接完成任务。')
  const [computerId, setComputerId] = useState('')
  const request = useCallback(<T,>(path: string, options?: RequestInit) => http<T>(path, { ...options, headers: { ...options?.headers, 'x-company-id': companyId } }), [companyId])
  const load = useCallback(async () => {
    const [configuration, state] = await Promise.all([request<Configuration>('/tasks/configuration'), request<{ mode: string; failures: string[] }>('/tasks/workspace')])
    setConfig(configuration); setWorkspace(state)
    setChannel(current => configuration.channels.some(row => row.id === current) ? current : configuration.channels[0]?.id ?? '')
    setComputerId(current => configuration.computers.some(row => row.id === current && row.kind !== 'cloud') ? current : configuration.computers.find(row => row.kind !== 'cloud')?.id ?? '')
  }, [request])
  useEffect(() => { let alive = true; void load().catch(reason => { if (alive) setError(String(reason)) }); return () => { alive = false } }, [load])
  const mutate = async (path: string, body?: unknown, method = 'POST') => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await request(path, { method, body: JSON.stringify(body ?? {}) }); await load(); setNotice('已保存') }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const local = config?.computers.find(row => row.id === computerId)
  return <section className="space-y-3 border-t border-ink-100 p-4 text-xs text-ink-700" aria-label="任务执行配置">
    <h3 className="font-semibold text-sm">任务执行配置</h3>
    {workspace && <div className="space-y-2">
      <p>执行模式：<strong>{workspace.mode}</strong></p>
      <p className="text-ink-400">准备模式会暂停 Agent 工作。配置所有频道默认负责人和本地执行准入后再启用任务。</p>
      <div className="flex flex-wrap gap-2">
        {workspace.mode === 'LEGACY' && <button className={button} disabled={busy} onClick={() => void mutate('/tasks/workspace/prepare')}>开始准备</button>}
        {workspace.mode === 'PREPARING' && <>
          <button className={button} disabled={busy || workspace.failures.length > 0} onClick={() => void mutate('/tasks/workspace/activate')}>启用任务模式</button>
          <button className={button} disabled={busy} onClick={() => void mutate('/tasks/workspace/rollback')}>恢复聊天模式</button>
        </>}
        {workspace.mode === 'TASK' && <button className={button} disabled={busy} onClick={() => void mutate('/tasks/workspace/stop')}>暂停任务</button>}
        <button className={button} disabled={busy} onClick={() => { setBusy(true); void load().catch(reason => setError(String(reason))).finally(() => setBusy(false)) }}>刷新状态</button>
      </div>
      {workspace.failures.length > 0 && <div aria-label="启用前置条件">待处理：{workspace.failures.join('、')}</div>}
    </div>}
    <details>
      <summary className="cursor-pointer font-semibold">Agent 定义与版本</summary>
      <form className="mt-2 space-y-2" onSubmit={event => { event.preventDefault(); void mutate('/tasks/definitions', { definitionId, name, role, instructions }) }}>
        <label className="block">定义标识<input className={field} value={definitionId} onChange={event => setDefinitionId(event.target.value)} required maxLength={200} /></label>
        <label className="block">定义名称<input className={field} value={name} onChange={event => setName(event.target.value)} required maxLength={200} /></label>
        <label className="block">角色<select className={field} value={role} onChange={event => setRole(event.target.value)}><option value="COORDINATOR">Aida / 协调者</option><option value="WORK">执行者</option><option value="VERIFY">验证者</option>{!['COORDINATOR', 'WORK', 'VERIFY'].includes(role) && <option value={role}>{role}（已有定义）</option>}</select></label>
        <label className="block">定义指令<textarea className={field} value={instructions} onChange={event => setInstructions(event.target.value)} required maxLength={12000} rows={4} /></label>
        <p className="text-ink-400">相同标识发布新版本；已有任务保持原版本，频道需显式选择新版本。</p>
        <button className={button} disabled={busy}>发布定义版本</button>
      </form>
      {config?.definitions.map(row => <button key={row.id} className="block mt-2 text-left underline" onClick={() => { setDefinitionId(row.definition_id); setName(row.body.name ?? row.definition_id); setRole(row.body.role ?? 'WORK'); setInstructions(row.body.instructions ?? '') }}>{row.body.name ?? row.definition_id} · {row.definition_id} · v{row.version}</button>)}
    </details>
    <div className="space-y-2">
      <label className="block font-semibold">频道绑定<select className={field} aria-label="配置频道" value={channel} onChange={event => setChannel(event.target.value)}>
        {config?.channels.map(row => <option key={row.id} value={row.id}>{row.title || '私聊'} · {row.id}</option>)}
      </select></label>
      {config?.agents.filter(agent => agent.channel_id === channel).map(agent => <BindingEditor key={`${channel}:${agent.id}`} agent={agent} definitions={config.definitions} binding={config.bindings.find(row => row.channel_id === channel && row.agent_id === agent.id)} busy={busy} save={mutate} />)}
      {config && !config.agents.some(agent => agent.channel_id === channel) && <p>此频道尚无 Agent 成员。</p>}
    </div>
    <details>
      <summary className="cursor-pointer font-semibold">本地计算机准入与模型连接</summary>
      <div className="mt-2 space-y-2">
        <label className="block">本地计算机<select className={field} value={computerId} onChange={event => setComputerId(event.target.value)}><option value="">选择已配对计算机</option>{config?.computers.filter(row => row.kind !== 'cloud').map(row => <option key={row.id} value={row.id}>{row.name} · {row.status}</option>)}</select></label>
        {local?.capabilities?.binaryHash ? <p>已准入：{local.engine} · {local.capabilities.modelProvider === 'codex-login' ? '本机 Codex 登录态代理' : '服务端模型代理'}<br />验证记录：{local.verification_ref}</p> : <p>尚未准入</p>}
        <p className="text-ink-400">在本地运行 node --import tsx scripts/qualify-local-task.mjs，导入生成的验证记录。Agent 的计算机与引擎在现有 Agent 设置中选择。</p>
        <p className="text-ink-400">使用本机 Codex 登录态时，在命令末尾追加 /tmp/cumora-local-task-admission.json codex-login，再导入生成的记录。</p>
        <label className="block">导入准入记录<input type="file" accept="application/json,.json" disabled={busy || !computerId} className="mt-1 block w-full" onChange={event => {
          const file = event.target.files?.[0]; event.target.value = ''; if (!file) return
          void file.text().then(text => { const record = JSON.parse(text); return mutate('/tasks/workspace/admissions', { computerId, engine: record.engine, binaryHash: record.binaryHash, verificationRef: record.verificationRef, checks: record.checks, modelProvider: record.modelProvider ?? 'server' }) }).catch(reason => setError(String(reason)))
        }} /></label>
      </div>
    </details>
    {error && <p role="alert" className="text-coral-deep">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>
}

function BindingEditor({ agent, definitions, binding, busy, save }: { agent: Configuration['agents'][number]; definitions: Definition[]; binding?: Binding; busy: boolean; save: (path: string, body?: unknown, method?: string) => Promise<void> }) {
  const [version, setVersion] = useState(binding?.definition_version_id ?? definitions[0]?.id ?? '')
  const [alias, setAlias] = useState(binding?.alias ?? agent.name)
  const [isDefault, setDefault] = useState(binding?.is_default ?? false)
  const [override, setOverride] = useState(binding?.configuration.instructions ?? '')
  useEffect(() => { setVersion(binding?.definition_version_id ?? definitions[0]?.id ?? ''); setAlias(binding?.alias ?? agent.name); setDefault(binding?.is_default ?? false); setOverride(binding?.configuration.instructions ?? '') }, [binding, definitions, agent.name])
  return <form className="space-y-2 rounded border border-ink-100 p-3" aria-label={`${agent.name} 任务绑定`} onSubmit={event => {
    event.preventDefault()
    const body = { definitionVersionId: version, alias, isDefault, ...(binding ? { ...(override.trim() ? { instructions: override } : {}) } : { channelId: agent.channel_id, agentId: agent.id }) }
    void save(binding ? `/tasks/bindings/${encodeURIComponent(binding.id)}` : '/tasks/bindings', body, binding ? 'PATCH' : 'POST')
  }}>
    <p className="font-semibold">{agent.name} · {binding ? '已绑定' : '未绑定'}</p>
    <p className="text-ink-400">计算机：{agent.computer_name ?? '未分配'} · 引擎：{agent.engine ?? '未指定'}{agent.computer_status ? ` · ${agent.computer_status}` : ''}</p>
    <label className="block">定义版本<select className={field} value={version} required onChange={event => setVersion(event.target.value)}><option value="">选择定义版本</option>{definitions.map(row => <option value={row.id} key={row.id}>{row.body.name ?? row.definition_id} · v{row.version} · {row.body.role ?? 'WORK'}</option>)}</select></label>
    <label className="block">频道别名<input className={field} value={alias} onChange={event => setAlias(event.target.value)} required maxLength={120} /></label>
    {binding && <label className="block">频道指令覆盖（留空使用定义）<textarea className={field} rows={2} value={override} onChange={event => setOverride(event.target.value)} maxLength={12000} /></label>}
    <label className="flex items-center gap-2"><input type="checkbox" checked={isDefault} onChange={event => setDefault(event.target.checked)} />默认负责人（Aida）</label>
    <button className={button} disabled={busy || !version}>{binding ? '保存绑定' : '创建绑定'}</button>
  </form>
}

export function ChannelTaskSettings({ channelId }: { channelId: string }) {
  const company = useAuth(state => state.companies.find(row => row.id === state.activeCompanyId))
  if (!company || !['owner', 'admin'].includes(company.role)) return null
  return <button type="button" className="mb-1 text-xs text-ink-500 underline" onClick={() => {
    useApp.getState().selectConversation(channelId)
    useApp.getState().setView('settings')
  }}>群聊配置</button>
}
