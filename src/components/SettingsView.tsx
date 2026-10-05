import { useApp } from '@/stores/app'
import { useAuth } from '@/stores/auth'
import { TaskSettings } from './TaskSettings'

export function SettingsView() {
  const company = useAuth(state => state.companies.find(item => item.id === state.activeCompanyId))
  const channelId = useApp(state => state.selectedConversationId)
  return <section className="h-full overflow-y-auto bg-paper" aria-label="配置页面">
    <header className="border-b border-ink-100 p-5">
      <h1 className="text-xl font-semibold">配置</h1>
      <p className="mt-2 text-sm text-ink-500">{company?.name} · 群聊与 Agent 配置</p>
      <p className="mt-2 text-xs text-ink-500">群聊就是 Channel。Aida 默认加入群聊，其他 Agent 可作为群成员协作。</p>
    </header>
    <div className="mx-auto max-w-3xl pb-10">
      {company && ['owner', 'admin'].includes(company.role)
        ? <TaskSettings key={company.id} companyId={company.id} channelId={channelId ?? undefined} />
        : <p className="p-5 text-sm text-ink-500">请由工作区管理员配置群聊与 Agent。</p>}
    </div>
  </section>
}
