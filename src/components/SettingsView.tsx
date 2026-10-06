import { useApp } from '@/stores/app'
import { useAuth } from '@/stores/auth'
import { TaskSettings } from './TaskSettings'
import { ConfigurationWorkbench } from './ConfigurationWorkbench'

export function SettingsView({ desktop = true }: { desktop?: boolean }) {
  const company = useAuth(state => state.companies.find(item => item.id === state.activeCompanyId))
  const channelId = useApp(state => state.selectedConversationId)
  return <section className="h-full overflow-hidden bg-paper" aria-label="配置页面">
    {company && ['owner', 'admin'].includes(company.role)
      ? desktop
        ? <ConfigurationWorkbench key={company.id} companyId={company.id} channelId={channelId ?? undefined} />
        : <TaskSettings companyId={company.id} channelId={channelId ?? undefined} />
      : <p className="p-5 text-sm text-ink-500">请由工作区管理员配置群聊与 Agent。</p>}
  </section>
}
