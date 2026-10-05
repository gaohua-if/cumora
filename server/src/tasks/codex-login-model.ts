import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { TaskError } from './contracts.js'

const endpoint = 'https://chatgpt.com/backend-api/codex/responses'

/** Runs only in the trusted local supervisor, never inside the Task namespace. */
async function credentials(): Promise<{ accessToken: string; accountId: string }> {
  let file
  try {
    file = await open(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 1024 * 1024 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error()
    const auth = JSON.parse(await file.readFile('utf8'))
    if (auth.auth_mode !== 'chatgpt' || typeof auth.tokens?.access_token !== 'string' || !auth.tokens.access_token || typeof auth.tokens?.account_id !== 'string' || !auth.tokens.account_id) throw new Error()
    return { accessToken: auth.tokens.access_token, accountId: auth.tokens.account_id }
  } catch { throw new TaskError('CODEX_LOGIN_REQUIRED') }
  finally { await file?.close() }
}

/** Codex's native login transport uses SSE; completed.output can be empty. */
export async function collectCodexResponse(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const items = new Map<number, unknown>()
  let buffer = ''; let size = 0; let completed: Record<string, unknown> | undefined
  try {
    while (true) {
      if (signal.aborted) throw new TaskError('CODEX_MODEL_TIMEOUT')
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 20_000_000) throw new TaskError('RUNTIME_OUTPUT_LIMIT')
      buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll('\r\n', '\n')
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data || data === '[DONE]') continue
        let event
        try { event = JSON.parse(data) } catch { throw new TaskError('INVALID_CODEX_MODEL_RESPONSE') }
        if (event.type === 'response.output_item.done') items.set(event.output_index, event.item)
        if (event.type === 'response.completed') completed = event.response
        if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') throw new TaskError('CODEX_MODEL_FAILED')
      }
    }
    if (!completed || completed.status !== 'completed') throw new TaskError('CODEX_MODEL_INCOMPLETE')
    return { ...completed, output: items.size ? [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item) : completed.output }
  } finally { await reader.cancel().catch(() => {}) }
}

export async function codexLoginModel(request: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const auth = await credentials()
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${auth.accessToken}`, 'ChatGPT-Account-Id': auth.accountId, 'Content-Type': 'application/json', Accept: 'text/event-stream', originator: 'cumora_task_supervisor' },
    body: JSON.stringify({ ...request, store: false, stream: true, include: ['reasoning.encrypted_content'] }) })
  if (!response.ok) {
    await response.body?.cancel()
    throw new TaskError(response.status === 401 || response.status === 403 ? 'CODEX_LOGIN_REQUIRED' : response.status === 429 ? 'CODEX_MODEL_RATE_LIMITED' : `CODEX_MODEL_HTTP_${response.status}`)
  }
  if (!response.body) throw new TaskError('CODEX_MODEL_INCOMPLETE')
  return collectCodexResponse(response.body, signal)
}
