/** Shared root counting for optimistic sends, confirmation and discard. */
import type { Message } from '@/types'

/** Shift a quoted root's local reply count. No-op when the root is not in the
 *  loaded page (an old message the user has not scrolled back to) or when the
 *  message being counted is not a reply at all. Never goes below zero. */
export function applyReplyCountDelta(
  list: Message[],
  rootId: string | null | undefined,
  delta: number,
): Message[] {
  if (!rootId || delta === 0) return list
  let hit = false
  const next = list.map((m) => {
    if (m.id !== rootId) return m
    hit = true
    return { ...m, replyCount: Math.max(0, (m.replyCount ?? 0) + delta) }
  })
  return hit ? next : list
}


/** Quotes provide context; the durable thread identifies the counted root. */
export function replyRootId(message: Pick<Message, 'id' | 'threadId' | 'quotedMessageId'>, list: Message[] = []): string | undefined {
  if (message.threadId) return message.threadId === message.id ? undefined : message.threadId
  if (!message.quotedMessageId) return undefined
  const quoted = list.find(m => m.id === message.quotedMessageId)
  return quoted?.threadId ?? message.quotedMessageId
}

/** Move an optimistic count when confirmation supplies a previously unknown root. */
export function reconcileReplyCount(list: Message[], prior: Message | undefined, confirmed: Message): Message[] {
  const before = prior ? replyRootId(prior, list) : undefined
  const after = replyRootId(confirmed, list)
  if (before === after) return list
  return applyReplyCountDelta(applyReplyCountDelta(list, before, -1), after, 1)
}

export function isChannelMessage(message: Pick<Message, 'id' | 'threadId'>): boolean {
  return !message.threadId || message.threadId === message.id
}
