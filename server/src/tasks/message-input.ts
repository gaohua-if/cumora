import type { StoredAttachment } from '../storage.js'

/** Stable description for attachment-only input; expiring URLs stay in runtime reads. */
export function messageInputText(body: string, attachment?: StoredAttachment | null): string {
  return body.trim() || (attachment ? `用户提供附件：${attachment.name}（${attachment.kind}${attachment.mime ? `，${attachment.mime}` : ''}）。请结合本 thread 的任务处理该附件。` : '')
}
