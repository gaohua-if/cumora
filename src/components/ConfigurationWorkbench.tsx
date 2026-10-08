import { useState, useEffect, useRef, type ReactNode } from 'react'
import { api, http } from '@/api/client'
import { TaskSettings } from './TaskSettings'
import {
  bundleDefaults,
  groupDefaults,
  languageLabels,
  resolveConfiguration,
  type WorkbenchData,
  type EffectiveConfiguration,
  type Published,
  type SkillBody,
} from '../../shared/configuration'
import { newCreationRequestId } from '@/lib/create-idempotency'
import './ConfigurationWorkbench.css'

type Category = 'agents' | 'skills' | 'bundles' | 'channels' | 'execution'
type Draft = Record<string, any>
type Dialog =
  | { kind: 'unsaved'; target: { category: Category; id?: string } }
  | { kind: 'skills'; member?: string; refs: string[]; returnTo?: Dialog }
  | {
      kind: 'import'
      name: string
      content: string
      returnTo?: Extract<Dialog, { kind: 'skills' }>
    }
  | { kind: 'upgrade'; title: string; apply: () => void }
  | { kind: 'members'; ids: string[] }
  | { kind: 'bundles'; ids: string[] }
const categories: Record<Category, string> = {
  agents: 'Agent',
  bundles: 'Access Bundles',
  channels: '群聊',
  skills: 'Skill 库',
  execution: '工作区执行',
}
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const latest = <T,>(items: Published<T>[], objectId: string) =>
  items.find((x) => x.objectId === objectId)
function Field({
  label,
  value,
  change,
  options,
  multiline = false,
  type = 'text',
  id,
}: {
  label: string
  value: any
  change: (value: string) => void
  options?: [string, string][]
  multiline?: boolean
  type?: string
  id?: string
}) {
  return (
    <label className="cwb-field">
      {label}
      {options ? (
        <select
          id={id}
          aria-label={label}
          value={value ?? ''}
          onChange={(e) => change(e.target.value)}
        >
          {options.map(([v, title]) => (
            <option key={v} value={v}>
              {title}
            </option>
          ))}
        </select>
      ) : multiline ? (
        <textarea
          id={id}
          aria-label={label}
          value={value ?? ''}
          onChange={(e) => change(e.target.value)}
        />
      ) : (
        <input
          id={id}
          aria-label={label}
          type={type}
          value={value ?? ''}
          onChange={(e) => change(e.target.value)}
        />
      )}
    </label>
  )
}
const languages = Object.entries(languageLabels) as [string, string][]
const models: [string, string][] = [
  ['inherit', '继承默认'],
  ['快速', '快速'],
  ['均衡', '均衡'],
  ['深入', '深入'],
]
function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="cwb-card">
      <h3>{title}</h3>
      {children}
    </section>
  )
}
function Button({
  children,
  onClick,
  primary = false,
  disabled = false,
}: {
  children: ReactNode
  onClick: () => void
  primary?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`cwb-btn ${primary ? 'primary' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

export function ConfigurationWorkbench({
  companyId,
  channelId,
}: {
  companyId: string
  channelId?: string
}) {
  const [data, setData] = useState<WorkbenchData | null>(null)
  const [category, setCategory] = useState<Category>(channelId ? 'channels' : 'agents')
  const [selected, setSelected] = useState(channelId ?? '')
  const [tab, setTab] = useState('概览')
  const [draft, setDraft] = useState<Draft>({})
  const [original, setOriginal] = useState<Draft>({})
  const [search, setSearch] = useState('')
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [previewAgent, setPreviewAgent] = useState('')
  const revision = useRef(0)
  const dirty = JSON.stringify(draft) !== JSON.stringify(original)
  const request = <T,>(path: string, options?: RequestInit) =>
    http<T>('/tasks/workbench' + path, {
      ...options,
      headers: { ...options?.headers, 'x-company-id': companyId },
    })
  const load = async () => {
    const next = await request<WorkbenchData>('')
    setData(next)
    return next
  }
  const commit = async (operation: Draft) => {
    const result = await request<{ revision: number; id?: string }>('', {
      method: 'PATCH',
      body: JSON.stringify({ ...operation, revision: revision.current }),
    })
    revision.current = result.revision
    return result
  }
  const options = (next: WorkbenchData, kind: Category) =>
    kind === 'agents'
      ? next.agents.map((a) => ({
          id: a.id,
          name: a.name,
          subtitle: `${a.role} ${a.isAida ? '· 默认 Aida' : ''}`,
        }))
      : kind === 'channels'
        ? next.channels
            .filter((c) => c.kind === 'group')
            .map((c) => ({
              id: c.id,
              name: c.title,
              subtitle: `${c.members.length} Agent · ${c.bundleVersionIds.length} 资源包`,
            }))
        : kind === 'skills'
          ? next.skills
              .filter((s, i, all) => all.findIndex((x) => x.objectId === s.objectId) === i)
              .map((s) => ({ id: s.objectId, name: s.body.name, subtitle: 'v' + s.version }))
          : kind === 'bundles'
            ? next.bundles
                .filter((s, i, all) => all.findIndex((x) => x.objectId === s.objectId) === i)
                .map((s) => ({ id: s.objectId, name: s.body.name, subtitle: 'v' + s.version }))
            : []
  function open(next: WorkbenchData, kind: Category, id?: string) {
    const selectedId = options(next, kind).some((x) => x.id === id)
      ? id!
      : (options(next, kind)[0]?.id ?? '')
    let editor: Draft = {}
    if (kind === 'agents') {
      const a = next.agents.find((x) => x.id === selectedId)
      if (a) {
        const def = latest(next.definitions, a.definitionId)
        editor = {
          ...(def?.body ?? {
            name: a.name,
            role: a.isAida ? 'COORDINATOR' : 'WORK',
            instructions: a.prompt || `你是 ${a.name}，处理当前任务。`,
            skills: [],
            language: 'inherit',
            model: 'inherit',
            description: a.description,
          }),
          objectId: a.definitionId,
          computerId: a.computerId ?? '',
          engine: a.engine ?? 'codex',
        }
      }
    }
    if (kind === 'skills') {
      const item = latest(next.skills, selectedId)
      if (item) editor = { ...item.body, objectId: item.objectId }
    }
    if (kind === 'bundles') {
      const item = latest(next.bundles, selectedId)
      if (item) editor = { ...item.body, objectId: item.objectId }
    }
    if (kind === 'channels') {
      const c = next.channels.find((c) => c.id === selectedId)
      if (c) editor = { ...clone(c), name: c.title }
    }
    setCategory(kind)
    setSelected(selectedId)
    setTab('概览')
    setSearch('')
    setDraft(clone(editor))
    setOriginal(clone(editor))
    revision.current = next.revision
    setPreviewAgent(
      editor.bindings?.find((b: any) => b.isDefault)?.agentId ?? editor.members?.[0] ?? '',
    )
    setError('')
    setNotice('')
  }
  useEffect(() => {
    let active = true
    void request<WorkbenchData>('')
      .then((next) => {
        if (active) {
          setData(next)
          open(next, channelId ? 'channels' : 'agents', channelId)
        }
      })
      .catch((e) => {
        if (active) setError(String(e))
      })
    return () => {
      active = false
    }
  }, [companyId])
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])
  const patch = (key: string, value: any) => setDraft((d) => ({ ...d, [key]: value }))
  const go = (kind: Category, id?: string) => {
    if (!data) return
    if (dirty) setDialog({ kind: 'unsaved', target: { category: kind, id } })
    else open(data, kind, id)
  }
  const report = (e: unknown) =>
    setError(
      String(e).includes('CONFIGURATION_REVISION_CONFLICT')
        ? '其他人已更新配置。你的草稿已保留，请重新载入后核对并再次编辑。'
        : e instanceof Error
          ? e.message
          : String(e),
    )
  async function save(): Promise<boolean> {
    if (!data || busy || !dirty) return !dirty
    setBusy(true)
    setError('')
    setNotice('')
    try {
      let resultId = selected
      if (category === 'skills' || category === 'bundles') {
        const { objectId, isNew, ...body } = draft
        await commit({
          action: category === 'skills' ? 'publish-skill' : 'publish-bundle',
          objectId,
          body,
        })
        resultId = objectId
      } else if (category === 'agents') {
        const { objectId, computerId, engine, isNew, requestId, ...body } = draft
        if (isNew) {
          if (!computerId) throw new Error('请选择本地计算机')
          resultId = (
            await api.createAgent({
              requestId,
              name: body.name,
              role: body.role,
              systemPrompt: body.instructions,
              bio: body.description,
              computerId,
              engine: engine as 'codex' | 'claude',
              inherit: false,
            })
          ).id
        }
        const a = data.agents.find((a) => a.id === resultId)
        if (!isNew && a && (a.computerId !== computerId || a.engine !== engine)) {
          if (!computerId) throw new Error('请选择本地计算机')
          await api.assignAgentComputer(resultId, computerId, engine as 'codex' | 'claude', false)
        }
        await commit({
          action: 'publish-definition',
          objectId: isNew ? `cumora.agent:${resultId}` : objectId,
          body,
        })
      } else if (category === 'channels') {
        if (draft.isNew)
          resultId = (await api.createGroup({ title: draft.name, members: draft.members })).id
        else {
          const c = data.channels.find((c) => c.id === selected)!
          for (const id of draft.members)
            if (!c.members.includes(id)) await api.addMember(selected, id)
          if (draft.members.some((id: string) => !c.members.includes(id)))
            await api.initializeGroupAida(selected)
        }
        await commit({
          action: 'save-channel',
          channelId: resultId,
          title: draft.name,
          configuration: draft.configuration,
          bundleVersionIds: draft.bundleVersionIds,
        })
        if (!draft.isNew)
          for (const b of [...draft.bindings].sort(
            (a, b) => Number(b.isDefault) - Number(a.isDefault),
          )) {
            const before = original.bindings?.find((x: any) => x.id === b.id)
            if (JSON.stringify(b) !== JSON.stringify(before))
              await commit({
                action: 'save-binding',
                channelId: resultId,
                agentId: b.agentId,
                definitionVersionId: b.definitionVersionId,
                alias: b.alias,
                isDefault: b.isDefault,
                configuration: b.configuration,
              })
          }
      }
      const next = await load()
      open(next, category, resultId)
      setNotice('已保存到工作区，固定引用保持原版本')
      return true
    } catch (e) {
      report(e)
      return false
    } finally {
      setBusy(false)
    }
  }
  function create() {
    if (!data || category === 'execution') return
    if (dirty) {
      setError('请先保存或撤销当前更改，再新建配置。')
      return
    }
    const objectId = newCreationRequestId()
    let d: Draft =
      category === 'skills'
        ? {
            name: '新 Skill',
            slug: 'skill-' + objectId.slice(0, 8),
            description: '',
            content: '# 新 Skill\n\n描述使用场景与工作方法。',
            objectId,
          }
        : category === 'bundles'
          ? { ...clone(bundleDefaults), name: '新资源包', objectId }
          : category === 'agents'
            ? {
                name: '新 Agent',
                role: 'WORK',
                instructions: '处理当前群聊的专业工作。',
                description: '',
                skills: [],
                language: 'inherit',
                model: 'inherit',
                computerId: data.computers[0]?.id ?? '',
                engine: 'codex',
                objectId,
                requestId: objectId,
              }
            : {
                name: '新群聊',
                members: [],
                bindings: [],
                configuration: clone(groupDefaults),
                bundleVersionIds: [],
              }
    d = { ...d, isNew: true }
    setSelected('__new__')
    setDraft(d)
    setOriginal({})
    setTab('概览')
    setError('')
  }
  function updateBinding(id: string, key: string, value: any) {
    patch(
      'bindings',
      draft.bindings.map((b: any) => (b.id === id ? { ...b, [key]: value } : b)),
    )
  }
  function updateMember(id: string, key: string, value: any) {
    const b = draft.bindings.find((b: any) => b.id === id)
    updateBinding(id, 'configuration', { ...b.configuration, [key]: value })
  }
  function memberRefs(member: string) {
    const b = draft.bindings.find((b: any) => b.id === member),
      def = data!.definitions.find((d) => d.id === b.definitionVersionId)
    const ids = new Map<string, string>()
    for (const ref of def?.body.skills ?? []) {
      const s = data!.skills.find((s) => s.id === ref)
      if (s && !(b.configuration.disabledSkills ?? []).includes(s.objectId))
        ids.set(s.objectId, ref)
    }
    for (const ref of b.configuration.skills ?? []) {
      const s = data!.skills.find((s) => s.id === ref)
      if (s) ids.set(s.objectId, ref)
    }
    return [...ids.values()]
  }
  async function importSkill(m: Extract<Dialog, { kind: 'import' }>) {
    if (!m.name.trim() || !m.content.trim()) {
      setError('请填写 Skill 名称和内容')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await commit({
        action: 'publish-skill',
        objectId: newCreationRequestId(),
        body: {
          name: m.name,
          slug: 'skill-' + newCreationRequestId().slice(0, 8),
          description: '导入的工作说明',
          content: m.content,
        },
      })
      await load()
      setDialog(m.returnTo ? { ...m.returnTo, refs: [...m.returnTo.refs, result.id!] } : null)
      setNotice('已发布 Skill；确认选择后绑定到当前配置')
    } catch (e) {
      report(e)
    } finally {
      setBusy(false)
    }
  }
  function skillPickerConfirm(m: Extract<Dialog, { kind: 'skills' }>) {
    if (!m.member) patch('skills', m.refs)
    else {
      const b = draft.bindings.find((b: any) => b.id === m.member),
        def = data!.definitions.find((d) => d.id === b.definitionVersionId),
        base = def?.body.skills ?? []
      const disabled = base
        .filter(
          (id) =>
            !m.refs.some(
              (ref) =>
                data!.skills.find((s) => s.id === ref)?.objectId ===
                data!.skills.find((s) => s.id === id)?.objectId,
            ),
        )
        .map((id) => data!.skills.find((s) => s.id === id)!.objectId)
      updateBinding(m.member, 'configuration', {
        ...b.configuration,
        skills: m.refs.filter((id) => !base.includes(id)),
        disabledSkills: disabled,
      })
    }
    setDialog(null)
  }
  function projection(): EffectiveConfiguration | null {
    if (!data || category !== 'channels') return null
    const b =
      draft.bindings?.find((b: any) => b.agentId === previewAgent) ??
      draft.bindings?.find((b: any) => b.isDefault)
    const def = data.definitions.find((d) => d.id === b?.definitionVersionId)
    if (!b || !def) return null
    return resolveConfiguration({
      definition: def,
      binding: b.configuration,
      group: draft.configuration,
      workspaceLanguage: data.language,
      skills: data.skills,
      bundles: data.bundles.filter((b) => draft.bundleVersionIds.includes(b.id)),
    })
  }
  const selectedSkillRows = (refs: string[]) =>
    refs
      .map((id) => data!.skills.find((s) => s.id === id))
      .filter(Boolean) as Published<SkillBody>[]
  function skillRows(refs: string[], member?: string) {
    return (
      <>
        {selectedSkillRows(refs).map((s) => {
          const newest = latest(data!.skills, s.objectId)!
          return (
            <div key={s.id} className="cwb-row">
              <div className="cwb-grow">
                <strong>{s.body.name}</strong> <span className="cwb-pill">当前 v{s.version}</span>
                {newest.id !== s.id && <span className="cwb-pill new">最新 v{newest.version}</span>}
              </div>
              {newest.id !== s.id && (
                <Button
                  onClick={() =>
                    setDialog({
                      kind: 'upgrade',
                      title: `升级 ${s.body.name} 到 v${newest.version}？`,
                      apply: () => {
                        const updated = refs.map((id) => (id === s.id ? newest.id : id))
                        if (!member) patch('skills', updated)
                        else {
                          const b = draft.bindings.find((b: any) => b.id === member)
                          updateBinding(member, 'configuration', {
                            ...b.configuration,
                            skills: [
                              ...(b.configuration.skills ?? []).filter(
                                (id: string) =>
                                  data!.skills.find((s) => s.id === id)?.objectId !== s.objectId,
                              ),
                              newest.id,
                            ],
                          })
                        }
                      },
                    })
                  }
                >
                  升级 Skill
                </Button>
              )}
            </div>
          )
        })}
        <Button onClick={() => setDialog({ kind: 'skills', member, refs: [...refs] })}>
          选择 Skills
        </Button>
      </>
    )
  }
  function panel(): ReactNode {
    if (!data) return <p>正在读取工作区配置…</p>
    if (category === 'execution')
      return <TaskSettings companyId={companyId} channelId={channelId} />
    if (!Object.keys(draft).length) return <div className="cwb-empty">暂无配置对象，请新建。</div>
    if (category === 'skills')
      return (
        <Card title={tab === 'SKILL.md' ? 'Skill 内容' : 'Skill 信息'}>
          {tab === 'SKILL.md' ? (
            <>
              <Field
                label="SKILL.md"
                multiline
                value={draft.content}
                change={(v) => patch('content', v)}
              />
              <label className="cwb-field">
                导入 Markdown
                <input
                  type="file"
                  accept=".md,text/plain,text/markdown"
                  onChange={async (e) => {
                    const file = e.target.files?.[0]
                    e.target.value = ''
                    if (file) {
                      if (file.size > 100000) {
                        setError('文件大小需小于 100 KB')
                        return
                      }
                      patch('content', await file.text())
                    }
                  }}
                />
              </label>
            </>
          ) : (
            <>
              <Field label="显示名称" value={draft.name} change={(v) => patch('name', v)} />
              <Field label="Skill 标识" value={draft.slug} change={(v) => patch('slug', v)} />
              <Field
                label="使用场景"
                value={draft.description}
                change={(v) => patch('description', v)}
              />
              <p className="cwb-note">保存发布新版本，已有引用保持原版本。</p>
            </>
          )}
        </Card>
      )
    if (category === 'agents')
      return tab === 'Skills' ? (
        <Card title="固定版本 Skills">{skillRows(draft.skills ?? [])}</Card>
      ) : tab === '提示词' ? (
        <>
          <Card title="基础提示词">
            <Field
              label="职责与工作方式"
              multiline
              value={draft.instructions}
              change={(v) => patch('instructions', v)}
            />
          </Card>
          <Card title="回复偏好">
            <Field
              label="Agent 默认语言"
              value={draft.language ?? 'inherit'}
              options={languages}
              change={(v) => patch('language', v)}
            />
            <Field
              label="Agent 默认模型"
              value={draft.model ?? 'inherit'}
              options={models}
              change={(v) => patch('model', v)}
            />
          </Card>
        </>
      ) : tab === '运行配置' ? (
        <Card title="本地执行位置">
          <Field
            label="本地计算机"
            value={draft.computerId}
            options={[
              ['', '选择本地计算机'],
              ...data.computers.map((c) => [c.id, `${c.name} · ${c.status}`] as [string, string]),
            ]}
            change={(v) => patch('computerId', v)}
          />
          <Field
            label="引擎"
            value={draft.engine}
            options={[
              ['codex', 'Codex'],
              ['claude', 'Claude Code'],
            ]}
            change={(v) => patch('engine', v)}
          />
          <p className="cwb-note">更换计算机或引擎会改变执行资格；本地准入在工作区执行页面管理。</p>
        </Card>
      ) : (
        <Card title="Agent 基本信息">
          <Field label="名称" value={draft.name} change={(v) => patch('name', v)} />
          <Field
            label="职责"
            value={draft.role}
            options={[
              ['COORDINATOR', '协调者'],
              ['WORK', '执行者'],
              ['VERIFY', '验证者'],
            ]}
            change={(v) => patch('role', v)}
          />
          <Field label="简介" value={draft.description} change={(v) => patch('description', v)} />
          <p className="cwb-note">
            发布 Agent 新版本后，已有群聊保持其固定版本；群聊明确升级后用于后续新任务。
          </p>
        </Card>
      )
    if (category === 'bundles') {
      if (tab === '使用说明')
        return (
          <Card title="资源使用说明">
            <Field
              label="使用说明"
              multiline
              value={draft.instructions}
              change={(v) => patch('instructions', v)}
            />
          </Card>
        )
      if (tab === '概览')
        return (
          <Card title="资源包信息">
            <Field label="名称" value={draft.name} change={(v) => patch('name', v)} />
            <Field label="说明" value={draft.description} change={(v) => patch('description', v)} />
            <Field
              label="默认访问身份"
              value={draft.identity}
              change={(v) => patch('identity', v)}
            />
            <p className="cwb-note">
              连接显式指定的身份优先于包默认身份。连接执行尚需准入，保存配置不创建凭证或授权。
            </p>
          </Card>
        )
      const kind = tab === 'MCP' ? 'mcp' : tab === 'Domains' ? 'domains' : 'github'
      const update = (id: string, key: string, value: any) =>
        patch(
          kind,
          draft[kind].map((r: any) => (r.id === id ? { ...r, [key]: value } : r)),
        )
      return (
        <>
          <Card title={tab}>
            <Button
              onClick={() =>
                patch(kind, [
                  ...draft[kind],
                  kind === 'mcp'
                    ? {
                        id: newCreationRequestId(),
                        name: '新连接',
                        url: '',
                        identity: '',
                        tools: ['search'],
                        enabled: true,
                      }
                    : kind === 'domains'
                      ? {
                          id: newCreationRequestId(),
                          host: '',
                          port: 443,
                          purpose: '',
                          enabled: true,
                        }
                      : {
                          id: newCreationRequestId(),
                          repo: '',
                          branch: 'main',
                          path: '/**',
                          identity: '',
                          actions: ['读取代码'],
                          enabled: true,
                        },
                ])
              }
            >
              添加{tab === 'MCP' ? ' MCP' : tab === 'Domains' ? '域名' : '仓库'}
            </Button>
            <p className="cwb-muted">连接状态：未准入外部执行 adapter</p>
          </Card>
          {draft[kind].map((r: any) => (
            <Card key={r.id} title={r.name || r.host || r.repo || '新资源'}>
              {kind === 'mcp' ? (
                <>
                  <Field label="连接名称" value={r.name} change={(v) => update(r.id, 'name', v)} />
                  <Field
                    label="MCP Server URL"
                    value={r.url}
                    change={(v) => update(r.id, 'url', v)}
                  />
                  <Field
                    label="可用工具（逗号分隔）"
                    value={r.tools.join(', ')}
                    change={(v) =>
                      update(
                        r.id,
                        'tools',
                        v
                          .split(/[,，]/)
                          .map((v) => v.trim())
                          .filter(Boolean),
                      )
                    }
                  />
                </>
              ) : kind === 'domains' ? (
                <>
                  <Field label="域名" value={r.host} change={(v) => update(r.id, 'host', v)} />
                  <Field
                    label="端口"
                    type="number"
                    value={r.port}
                    change={(v) => update(r.id, 'port', Number(v))}
                  />
                  <Field
                    label="用途"
                    value={r.purpose}
                    change={(v) => update(r.id, 'purpose', v)}
                  />
                  <p className="cwb-note">域名访问不附带登录凭证。</p>
                </>
              ) : (
                <>
                  <Field label="仓库" value={r.repo} change={(v) => update(r.id, 'repo', v)} />
                  <Field label="分支" value={r.branch} change={(v) => update(r.id, 'branch', v)} />
                  <Field label="路径范围" value={r.path} change={(v) => update(r.id, 'path', v)} />
                  {['读取代码', '创建分支', '创建 PR', '评论 Issue', '合并 PR'].map((action) => (
                    <label className="cwb-choice" key={action}>
                      <input
                        type="checkbox"
                        checked={r.actions.includes(action)}
                        onChange={(e) =>
                          update(
                            r.id,
                            'actions',
                            e.target.checked
                              ? [...r.actions, action]
                              : r.actions.filter((v: string) => v !== action),
                          )
                        }
                      />
                      {action}
                    </label>
                  ))}
                </>
              )}
              {kind !== 'domains' && (
                <Field
                  label="连接身份（留空继承 Bundle 默认）"
                  value={r.identity}
                  change={(v) => update(r.id, 'identity', v)}
                />
              )}
              <div className="cwb-actions">
                <label>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={(e) => update(r.id, 'enabled', e.target.checked)}
                  />{' '}
                  启用配置
                </label>
                <Button
                  onClick={() =>
                    patch(
                      kind,
                      draft[kind].filter((x: any) => x.id !== r.id),
                    )
                  }
                >
                  移除资源
                </Button>
              </div>
            </Card>
          ))}
        </>
      )
    }
    if (category === 'channels') {
      if (tab === 'Agent 成员')
        return (
          <>
            <Card title="Agent 成员">
              <Button onClick={() => setDialog({ kind: 'members', ids: [...draft.members] })}>
                添加 Agent
              </Button>
              <p className="cwb-muted">Aida 为默认群成员。成员移除请使用现有群聊成员管理入口。</p>
            </Card>
            {draft.bindings.map((b: any) => {
              const agent = data.agents.find((a) => a.id === b.agentId),
                def = data.definitions.find((d) => d.id === b.definitionVersionId),
                newest = def && latest(data.definitions, def.objectId)
              return (
                <Card key={b.id} title={agent?.name ?? b.alias}>
                  <div className="cwb-actions">
                    <span className="cwb-pill">当前 Agent v{def?.version}</span>
                    {newest && newest.id !== def?.id && (
                      <>
                        <span className="cwb-pill new">最新 v{newest.version}</span>
                        <Button
                          onClick={() =>
                            setDialog({
                              kind: 'upgrade',
                              title: `升级 ${agent?.name} 到 v${newest.version}？`,
                              apply: () => updateBinding(b.id, 'definitionVersionId', newest.id),
                            })
                          }
                        >
                          升级 Agent
                        </Button>
                      </>
                    )}
                  </div>
                  <Field
                    label={`${agent?.name} 群内别名`}
                    value={b.alias}
                    change={(v) => updateBinding(b.id, 'alias', v)}
                  />
                  <Field
                    label={`${agent?.name} 补充要求`}
                    multiline
                    value={b.configuration.instructions ?? ''}
                    change={(v) => updateMember(b.id, 'instructions', v)}
                  />
                  <Field
                    label={`${agent?.name} 群内语言`}
                    value={b.configuration.language ?? 'inherit'}
                    options={languages}
                    change={(v) => updateMember(b.id, 'language', v)}
                  />
                  <Field
                    label={`${agent?.name} 模型偏好`}
                    value={b.configuration.model ?? 'inherit'}
                    options={models}
                    change={(v) => updateMember(b.id, 'model', v)}
                  />
                  {skillRows(memberRefs(b.id), b.id)}
                  <Field
                    label={`${agent?.name} 访问模式`}
                    value={b.configuration.accessMode ?? 'all'}
                    options={[
                      ['all', '继承群聊全部'],
                      ['subset', '选择部分资源包'],
                      ['none', '不使用外部资源'],
                    ]}
                    change={(v) => updateMember(b.id, 'accessMode', v)}
                  />
                  {b.configuration.accessMode === 'subset' && (
                    <>
                      {data.bundles
                        .filter((v) => draft.bundleVersionIds.includes(v.id))
                        .map((v) => (
                          <label className="cwb-choice" key={v.id}>
                            <input
                              type="checkbox"
                              checked={(b.configuration.bundleIds ?? []).includes(v.objectId)}
                              onChange={(e) =>
                                updateMember(
                                  b.id,
                                  'bundleIds',
                                  e.target.checked
                                    ? [...(b.configuration.bundleIds ?? []), v.objectId]
                                    : (b.configuration.bundleIds ?? []).filter(
                                        (id: string) => id !== v.objectId,
                                      ),
                                )
                              }
                            />
                            {v.body.name} · v{v.version}
                          </label>
                        ))}
                      {!(b.configuration.bundleIds ?? []).length && (
                        <p className="cwb-note">当前未选择资源包</p>
                      )}
                    </>
                  )}
                </Card>
              )
            })}
          </>
        )
      if (tab === 'Access Bundles')
        return (
          <Card title="群聊资源包">
            <Button
              onClick={() => setDialog({ kind: 'bundles', ids: [...draft.bundleVersionIds] })}
            >
              选择资源包
            </Button>
            {data.bundles
              .filter((b) => draft.bundleVersionIds.includes(b.id))
              .map((b) => {
                const newest = latest(data.bundles, b.objectId)!
                return (
                  <div className="cwb-row" key={b.id}>
                    <div className="cwb-grow">
                      <strong>{b.body.name}</strong>{' '}
                      <span className="cwb-pill">当前 v{b.version}</span>
                      {newest.id !== b.id && (
                        <span className="cwb-pill new">最新 v{newest.version}</span>
                      )}
                    </div>
                    {newest.id !== b.id && (
                      <Button
                        onClick={() =>
                          setDialog({
                            kind: 'upgrade',
                            title: `升级 ${b.body.name} 到 v${newest.version}？`,
                            apply: () =>
                              patch(
                                'bundleVersionIds',
                                draft.bundleVersionIds.map((id: string) =>
                                  id === b.id ? newest.id : id,
                                ),
                              ),
                          })
                        }
                      >
                        升级 Bundle
                      </Button>
                    )}
                    <Button
                      onClick={() => {
                        setDraft((d) => ({
                          ...d,
                          bundleVersionIds: d.bundleVersionIds.filter((id: string) => id !== b.id),
                          bindings: d.bindings.map((m: any) => ({
                            ...m,
                            configuration: {
                              ...m.configuration,
                              bundleIds: (m.configuration.bundleIds ?? []).filter(
                                (id: string) => id !== b.objectId,
                              ),
                            },
                          })),
                        }))
                      }}
                    >
                      取消引用
                    </Button>
                  </div>
                )
              })}
            <p className="cwb-note">删除引用仅收缩成员子集；删空保持为空。</p>
          </Card>
        )
      if (tab === '生效配置') {
        let p: EffectiveConfiguration | null = null
        try {
          p = projection()
        } catch (e) {
          return <p role="alert">{String(e)}</p>
        }
        return (
          <>
            <Field
              label="预览 Agent"
              value={previewAgent}
              options={draft.bindings.map((b: any) => [
                b.agentId,
                data.agents.find((a) => a.id === b.agentId)?.name ?? b.alias,
              ])}
              change={setPreviewAgent}
            />
            {p ? (
              <>
                <Card title="提示词与 Skills 来源">
                  {p.sources.map((s, i) => (
                    <div key={i} className="cwb-row">
                      <div className="cwb-grow">
                        <strong>{s.source}</strong>
                        <pre className="cwb-pre">{s.content || '未设置'}</pre>
                      </div>
                    </div>
                  ))}
                </Card>
                <Card title="普通设置">
                  <p>
                    语言：{p.language.value} · 来源：{p.language.source}
                  </p>
                  <p>
                    模型：{p.model} · 并行：{p.settings.parallelism}
                  </p>
                </Card>
                <Card title="实际访问资源">
                  {p.resources.length ? (
                    p.resources.map((r, i) => (
                      <div className="cwb-row" key={i}>
                        <div className="cwb-grow">
                          <strong>{r.name}</strong>
                          <p className="cwb-muted">
                            {r.type.toUpperCase()} · {r.bundleName} v{r.bundleVersion}
                          </p>
                          <p>
                            实际身份：{r.identity} · 来源：{r.identitySource}
                          </p>
                          <pre className="cwb-pre">{JSON.stringify(r.scope, null, 2)}</pre>
                          <span className="cwb-pill">外部执行未准入</span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p>没有生效的外部资源。</p>
                  )}
                </Card>
                <p className="cwb-note">
                  当前群内草稿参与预览，版本内容固定。保存用于新任务，旧任务保留创建时的配置快照。
                </p>
              </>
            ) : (
              <p className="cwb-note">此群聊尚无有效绑定，请初始化 Aida 或为成员配置定义。</p>
            )}
          </>
        )
      }
      return (
        <>
          <Card title="群聊信息">
            <Field label="群聊名称" value={draft.name} change={(v) => patch('name', v)} />
            {!draft.isNew && (
              <Field
                label="默认负责人"
                value={draft.bindings.find((b: any) => b.isDefault)?.id ?? ''}
                options={draft.bindings.map((b: any) => [
                  b.id,
                  data.agents.find((a) => a.id === b.agentId)?.name ?? b.alias,
                ])}
                change={(v) =>
                  patch(
                    'bindings',
                    draft.bindings.map((b: any) => ({ ...b, isDefault: b.id === v })),
                  )
                }
              />
            )}
            <Button
              disabled={busy || draft.isNew || dirty}
              onClick={async () => {
                setBusy(true)
                try {
                  await api.initializeGroupAida(selected)
                  const next = await load()
                  open(next, 'channels', selected)
                } catch (e) {
                  report(e)
                } finally {
                  setBusy(false)
                }
              }}
            >
              初始化默认 Aida
            </Button>
          </Card>
          <Card title="群聊自己的配置">
            <Field
              label="共同工作规则"
              multiline
              value={draft.configuration.rules}
              change={(v) => patch('configuration', { ...draft.configuration, rules: v })}
            />
            <div className="cwb-fields">
              <Field
                label="群聊默认语言"
                options={languages}
                value={draft.configuration.language}
                change={(v) => patch('configuration', { ...draft.configuration, language: v })}
              />
              <Field
                label="群聊默认模型"
                options={models}
                value={draft.configuration.model}
                change={(v) => patch('configuration', { ...draft.configuration, model: v })}
              />
              <Field
                label="输出结构"
                value={draft.configuration.format}
                change={(v) => patch('configuration', { ...draft.configuration, format: v })}
              />
              <Field
                label="响应方式"
                value={draft.configuration.response}
                options={[
                  ['Aida 默认响应', 'Aida 默认响应'],
                  ['仅 @ 时响应', '仅 @ 时响应'],
                ]}
                change={(v) => patch('configuration', { ...draft.configuration, response: v })}
              />
              <Field
                label="并行 Agent 数量"
                value={String(draft.configuration.parallelism)}
                options={[1, 2, 3, 4].map((n) => [String(n), String(n)])}
                change={(v) =>
                  patch('configuration', { ...draft.configuration, parallelism: Number(v) })
                }
              />
              <Field
                label="记忆范围"
                value={draft.configuration.memory}
                options={[
                  ['仅当前群聊', '仅当前群聊'],
                  ['仅当前任务', '仅当前任务'],
                ]}
                change={(v) => patch('configuration', { ...draft.configuration, memory: v })}
              />
            </div>
          </Card>
        </>
      )
    }
    return null
  }
  const tabs =
    category === 'agents'
      ? ['概览', '提示词', 'Skills', '运行配置']
      : category === 'skills'
        ? ['概览', 'SKILL.md']
        : category === 'bundles'
          ? ['概览', 'MCP', 'Domains', 'GitHub', '使用说明']
          : category === 'channels'
            ? ['概览', 'Agent 成员', 'Access Bundles', '生效配置']
            : []
  function modalContent(): ReactNode {
    if (!dialog || !data) return null
    if (dialog.kind === 'unsaved')
      return (
        <>
          <h2>保存当前更改？</h2>
          <p>切换前可以保存、放弃或继续编辑。</p>
          <div className="cwb-dialog-footer">
            <Button onClick={() => setDialog(null)}>继续编辑</Button>
            <Button
              onClick={() => {
                open(data, dialog.target.category, dialog.target.id)
                setDialog(null)
              }}
            >
              放弃并切换
            </Button>
            <Button
              disabled={busy}
              primary
              onClick={async () => {
                const target = dialog.target
                if (await save()) {
                  const next = await load()
                  open(next, target.category, target.id)
                  setDialog(null)
                }
              }}
            >
              保存并切换
            </Button>
          </div>
        </>
      )
    if (dialog.kind === 'upgrade')
      return (
        <>
          <h2>{dialog.title}</h2>
          <p>确认后修改当前草稿，保存后用于新任务；已有任务保持原版本。</p>
          <div className="cwb-dialog-footer">
            <Button onClick={() => setDialog(null)}>取消</Button>
            <Button
              primary
              onClick={() => {
                dialog.apply()
                setDialog(null)
              }}
            >
              确认升级
            </Button>
          </div>
        </>
      )
    if (dialog.kind === 'import')
      return (
        <>
          <h2>导入 Skill</h2>
          <label className="cwb-field">
            SKILL.md 文件
            <input
              type="file"
              accept=".md,text/plain,text/markdown"
              onChange={async (e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (!file) return
                if (file.size > 100000) {
                  setError('文件大小需小于 100 KB')
                  return
                }
                const content = await file.text()
                setDialog((m) =>
                  m?.kind === 'import'
                    ? { ...m, content, name: file.name.replace(/\.md$/i, '') }
                    : m,
                )
              }}
            />
          </label>
          <Field
            label="导入 Skill 名称"
            value={dialog.name}
            change={(name) => setDialog({ ...dialog, name })}
          />
          <Field
            label="导入 Skill 内容"
            multiline
            value={dialog.content}
            change={(content) => setDialog({ ...dialog, content })}
          />
          <div className="cwb-dialog-footer">
            <Button onClick={() => setDialog(dialog.returnTo ?? null)}>取消并返回</Button>
            <Button primary disabled={busy} onClick={() => void importSkill(dialog)}>
              导入 Skill
            </Button>
          </div>
        </>
      )
    if (dialog.kind === 'skills')
      return (
        <>
          <h2>{dialog.member ? '调整成员 Skills' : '选择 Skills'}</h2>
          {data.skills
            .filter((s, i, all) => all.findIndex((v) => v.objectId === s.objectId) === i)
            .map((newest) => {
              const pinned = data.skills.find(
                (s) => dialog.refs.includes(s.id) && s.objectId === newest.objectId,
              )
              return (
                <div className="cwb-choice" key={newest.objectId}>
                  <input
                    type="checkbox"
                    aria-label={`选择 Skill ${newest.body.name}`}
                    checked={!!pinned}
                    onChange={(e) =>
                      setDialog({
                        ...dialog,
                        refs: e.target.checked
                          ? [...dialog.refs, newest.id]
                          : dialog.refs.filter(
                              (id) =>
                                data.skills.find((s) => s.id === id)?.objectId !== newest.objectId,
                            ),
                      })
                    }
                  />
                  <div className="cwb-grow">
                    {newest.body.name}{' '}
                    <span className="cwb-pill">
                      {pinned ? `当前 v${pinned.version}` : `v${newest.version}`}
                    </span>
                    {pinned && pinned.id !== newest.id && (
                      <span className="cwb-pill new">最新 v{newest.version}</span>
                    )}
                  </div>
                  {pinned && pinned.id !== newest.id && (
                    <Button
                      onClick={() =>
                        setDialog({
                          ...dialog,
                          refs: dialog.refs.map((id) => (id === pinned.id ? newest.id : id)),
                        })
                      }
                    >
                      升级 Skill
                    </Button>
                  )}
                </div>
              )
            })}
          <Button
            onClick={() =>
              setDialog({ kind: 'import', name: '', content: '', returnTo: clone(dialog) })
            }
          >
            导入新的 SKILL.md
          </Button>
          <div className="cwb-dialog-footer">
            <Button onClick={() => setDialog(null)}>取消</Button>
            <Button primary onClick={() => skillPickerConfirm(dialog)}>
              确认选择
            </Button>
          </div>
        </>
      )
    if (dialog.kind === 'members')
      return (
        <>
          <h2>添加 Agent</h2>
          {data.agents.map((a) => (
            <label className="cwb-choice" key={a.id}>
              <input
                type="checkbox"
                checked={dialog.ids.includes(a.id)}
                disabled={a.isAida || draft.members.includes(a.id)}
                onChange={(e) =>
                  setDialog({
                    ...dialog,
                    ids: e.target.checked
                      ? [...dialog.ids, a.id]
                      : dialog.ids.filter((id) => id !== a.id),
                  })
                }
              />
              {a.name}
              {a.isAida ? ' · 默认 Aida' : ''}
            </label>
          ))}
          <div className="cwb-dialog-footer">
            <Button onClick={() => setDialog(null)}>取消</Button>
            <Button
              primary
              onClick={() => {
                patch('members', dialog.ids)
                setDialog(null)
              }}
            >
              确认成员
            </Button>
          </div>
        </>
      )
    if (dialog.kind === 'bundles')
      return (
        <>
          <h2>选择 Access Bundle</h2>
          {data.bundles
            .filter((b, i, all) => all.findIndex((v) => v.objectId === b.objectId) === i)
            .map((newest) => {
              const pinned = data.bundles.find(
                (b) => dialog.ids.includes(b.id) && b.objectId === newest.objectId,
              )
              return (
                <label className="cwb-choice" key={newest.objectId}>
                  <input
                    type="checkbox"
                    checked={!!pinned}
                    onChange={(e) =>
                      setDialog({
                        ...dialog,
                        ids: e.target.checked
                          ? [...dialog.ids, newest.id]
                          : dialog.ids.filter(
                              (id) =>
                                data.bundles.find((b) => b.id === id)?.objectId !== newest.objectId,
                            ),
                      })
                    }
                  />
                  <span>
                    {(pinned ?? newest).body.name}{' '}
                    <span className="cwb-pill">
                      {pinned ? `当前 v${pinned.version}` : `v${newest.version}`}
                    </span>
                    {pinned && pinned.id !== newest.id && (
                      <span className="cwb-pill new">最新 v{newest.version}</span>
                    )}
                  </span>
                </label>
              )
            })}
          <div className="cwb-dialog-footer">
            <Button onClick={() => setDialog(null)}>取消</Button>
            <Button
              primary
              onClick={() => {
                const objectIds = data.bundles
                  .filter((b) => dialog.ids.includes(b.id))
                  .map((b) => b.objectId)
                setDraft((d) => ({
                  ...d,
                  bundleVersionIds: dialog.ids,
                  bindings: d.bindings.map((b: any) => ({
                    ...b,
                    configuration: {
                      ...b.configuration,
                      bundleIds: (b.configuration.bundleIds ?? []).filter((id: string) =>
                        objectIds.includes(id),
                      ),
                    },
                  })),
                }))
                setDialog(null)
              }}
            >
              确认引用
            </Button>
          </div>
        </>
      )
    return null
  }
  return (
    <div className="cwb" role="region" aria-label="配置工作台">
      <nav className="cwb-nav" aria-label="配置分类">
        <h1>配置</h1>
        {(Object.keys(categories) as Category[]).map((kind) => (
          <button
            type="button"
            key={kind}
            className={kind === category ? 'active' : ''}
            onClick={() => go(kind)}
          >
            {categories[kind]}
          </button>
        ))}
        <div className="cwb-nav-footer">
          {data && (
            <Field
              label="工作区默认语言"
              value={data.language}
              options={languages.filter(([v]) => v !== 'inherit')}
              change={async (language) => {
                setBusy(true)
                try {
                  await commit({ action: 'save-workspace', language })
                  await load()
                  setNotice('工作区默认语言已保存')
                } catch (e) {
                  report(e)
                } finally {
                  setBusy(false)
                }
              }}
            />
          )}
          <p className="cwb-muted">
            群聊就是 Channel
            <br />
            固定配置版本 · 本地执行
          </p>
        </div>
      </nav>
      <aside className="cwb-list" aria-label="配置对象">
        <div className="cwb-list-head">
          <strong>{categories[category]}</strong>
          {category !== 'execution' && (
            <Button disabled={busy} onClick={create}>
              新建
            </Button>
          )}
        </div>
        <input
          className="cwb-search"
          aria-label="搜索配置对象"
          placeholder="搜索配置…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {data &&
          options(data, category)
            .filter((o) => o.name.toLowerCase().includes(search.toLowerCase()))
            .map((o) => (
              <button
                type="button"
                className={`cwb-list-item ${selected === o.id ? 'active' : ''}`}
                key={o.id}
                onClick={() => go(category, o.id)}
              >
                {o.name}
                <small>{o.subtitle}</small>
              </button>
            ))}
        {selected === '__new__' && (
          <button type="button" className="cwb-list-item active">
            {draft.name}
            <small>未保存的新对象</small>
          </button>
        )}
      </aside>
      <main className="cwb-main">
        {data?.runtime?.mode === 'local-only' && (
          <div className="cwb-runtime" role="status">
            <strong>本地运行模式 · 无需服务端 API Key</strong>
            <p>Agent 需要在线的本地计算机及其 Codex / Claude 登录态。普通群聊请求由 Aida 或群聊默认负责人接收，再决定分工；使用 @成员 指定负责人，@all 通知全组。</p>
            <p>服务端模型推理、生成头像和向量检索当前不可用；记忆仍按置顶和近期内容读取。</p>
          </div>
        )}
        <header>
          <p className="cwb-muted">工作区 / {categories[category]}</p>
          <h2>{draft.name ?? categories[category]}</h2>
          {data && <span className="cwb-pill">修订 {revision.current}</span>}
        </header>
        {error && (
          <div className="cwb-error" role="alert">
            {error}
            <div style={{ marginTop: 10 }}>
              <Button
                disabled={busy}
                onClick={async () => {
                  const next = await load()
                  setNotice('已读取服务端最新配置，草稿保持原样。撤销更改可载入最新版本。')
                  setData(next)
                }}
              >
                重新载入服务端配置
              </Button>
            </div>
          </div>
        )}
        {notice && (
          <p className="cwb-note" role="status">
            {notice}
          </p>
        )}
        {tabs.length > 0 && (
          <div className="cwb-tabs" role="tablist">
            {tabs.map((t) => (
              <button
                type="button"
                className={tab === t ? 'active' : ''}
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
        )}
        {panel()}
        {category !== 'execution' && (
          <footer className="cwb-footer">
            <span className="cwb-muted">
              {busy ? '正在保存…' : dirty ? '有未保存的更改' : '已从服务端载入'}
            </span>
            <div className="cwb-actions">
              <Button
                disabled={busy || !dirty}
                onClick={() => {
                  if (data) open(data, category, selected === '__new__' ? undefined : selected)
                  setDialog(null)
                }}
              >
                撤销更改
              </Button>
              <Button disabled={busy || !dirty} primary onClick={() => void save()}>
                {['agents', 'skills', 'bundles'].includes(category) ? '保存并发布版本' : '保存配置'}
              </Button>
            </div>
          </footer>
        )}
      </main>
      {dialog && (
        <div className="cwb-overlay">
          <section className="cwb-dialog" role="dialog" aria-modal="true" aria-label="配置操作">
            {error && (
              <div className="cwb-error" role="alert">
                {error}
              </div>
            )}
            {modalContent()}
          </section>
        </div>
      )}
    </div>
  )
}
