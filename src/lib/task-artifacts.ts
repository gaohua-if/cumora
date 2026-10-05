import { digest } from 'lib0/hash/sha256'

/** lib0 also works on LAN HTTP, where Web Crypto's subtle API is unavailable. */
export function taskContentHash(content: string): string {
  return Array.from(digest(new TextEncoder().encode(content)), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function downloadTaskArtifact(id: string, artifact: { content: string; mediaType: string; hash: string }): void {
  if (taskContentHash(artifact.content) !== artifact.hash) throw new Error('产物内容校验失败')
  const url = URL.createObjectURL(new Blob([artifact.content], { type: artifact.mediaType }))
  const link = document.createElement('a')
  link.href = url
  link.download = `task-${id}.txt`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
