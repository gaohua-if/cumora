import { useEffect, useState } from 'react'
import { api } from '@/api/client'
import { useAuth } from '@/stores/auth'
import { useConversations } from '@/stores/conversations'
import { useParticipants } from '@/stores/participants'

export function GroupAida({ channelId }: { channelId: string }) {
  const companyId = useAuth(state => state.activeCompanyId)
  const isGroup = useConversations(state => state.list.find(item => item.id === channelId)?.kind === 'group')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let alive = true
    setName(''); setError('')
    if (isGroup) void api.initializeGroupAida(channelId).then(async result => {
      if (!alive) return
      setName(result.defaultName)
      await Promise.all([useParticipants.getState().refresh(), useConversations.getState().reload()])
    }).catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { alive = false }
  }, [channelId, companyId, isGroup, retry])
  if (!isGroup) return null
  return <div className="mb-1 text-xs text-ink-500" aria-label="群聊默认助手">
    {error ? <span role="alert">默认 Aida 初始化失败：{error} <button className="underline" onClick={() => setRetry(value => value + 1)}>重试</button></span>
      : name ? <>默认负责人：<strong>{name}</strong></> : '正在准备默认 Aida…'}
  </div>
}
