import { delimiter, join } from 'node:path'
import { realpath, access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { runLocalSandbox } from './local-sandbox.js'
import { TaskError, hashContent } from './contracts.js'
import type { Claim } from './execution.js'
import { codexLoginModel } from './codex-login-model.js'

export async function resolveLocalCodex(): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const path = join(directory, 'codex')
    try { await access(path, constants.X_OK); return await realpath(path) } catch { /* continue */ }
  }
  throw new TaskError('RUNTIME_CAPABILITY_UNQUALIFIED')
}

export async function runLocalTask(options: { serverUrl: string; token: string; engine: string; signal: AbortSignal }): Promise<boolean> {
  if (options.engine !== 'codex' || process.platform !== 'linux') throw new TaskError('RUNTIME_CAPABILITY_UNQUALIFIED')
  const request = async <T>(path: string, body: unknown, timeout = 20_000): Promise<T> => {
    const response = await fetch(`${options.serverUrl}/runtime/tasks/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.token}` },
      body: JSON.stringify(body), signal: AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) })
    if (!response.ok) {
      const detail=await response.json().catch(()=>null) as {error?:unknown}|null
      const code=typeof detail?.error==='string' && /^[A-Z0-9_:.\-,]+$/.test(detail.error) ? detail.error.slice(0,200):''
      throw new TaskError(`TASK_RUNTIME_HTTP_${response.status}${code?':'+code:''}`)
    }
    return response.json() as Promise<T>
  }
  const { claim } = await request<{ claim: Claim | null }>('claim', {})
  if (!claim) return false
  const abort = new AbortController()
  const cancel = () => abort.abort()
  options.signal.addEventListener('abort', cancel, { once: true })
  let heartbeating = false
  const heartbeat = setInterval(() => {
    if (heartbeating) return
    heartbeating = true
    void request('heartbeat', { claim }).catch(cancel).finally(() => { heartbeating = false })
  }, 15_000)
  try {
    const resolved = await request<{ context: unknown; model: string; binaryHash: string; modelProvider?: string }>('context', { claim })
    const binary = await resolveLocalCodex()
    if (hashContent(await readFile(binary)) !== resolved.binaryHash) throw new TaskError('RUNTIME_BINARY_CHANGED')
    const result = await runLocalSandbox({ binary, binaryHash: resolved.binaryHash, context: resolved.context, model: resolved.model,
      signal: AbortSignal.any([options.signal, abort.signal]), modelCall: async body => {
        if (resolved.modelProvider !== 'codex-login') return request('model', { claim, request: body }, 5 * 60_000)
        const permit = await request<{ permitId: string; request: Record<string, unknown> }>('model/authorize', { claim, request: body })
        const started = Date.now()
        let response: Record<string, unknown>
        try { response = await codexLoginModel(permit.request, AbortSignal.any([options.signal, abort.signal, AbortSignal.timeout(5 * 60_000)])) }
        catch (error) {
          await request('model/receipt', { claim, receipt: { permitId: permit.permitId, status: error instanceof TaskError && error.code === 'CODEX_MODEL_RATE_LIMITED' ? 'rate_limited' : 'failed', latencyMs: Date.now() - started } }).catch(() => {})
          throw error
        }
        // Record usage and revalidate the claim before returning any model result to the namespace.
        await request('model/receipt', { claim, receipt: { permitId: permit.permitId, status: 'ok', usage: response.usage, latencyMs: Date.now() - started } })
        return response
      } })
    if (result.plan !== undefined) {
      // The namespace and all engine children have stopped before delegation commits.
      await request('plan', { claim, plan: result.plan })
      return true
    }
    const artifactIds: string[] = []
    for (const artifact of [...result.artifacts, { content: result.answer, mediaType: 'text/markdown', name: 'answer.md', hash: hashContent(result.answer) }]) {
      if (!artifact.content.trim()) continue
      const version = await request<{ id: string; hash: string }>('artifacts', { claim, content: artifact.content, mediaType: artifact.mediaType })
      if (version.hash !== artifact.hash) throw new TaskError('ARTIFACT_HASH_MISMATCH')
      artifactIds.push(version.id)
    }
    if (!result.answer.trim()) throw new TaskError('LOCAL_ENGINE_EMPTY_RESULT')
    await request('deliver', { claim, delivery: { summary: result.answer, artifactIds } })
    return true
  } catch (error) {
    await request('block', { claim,code:error instanceof TaskError?error.code:'LOCAL_TASK_BLOCKED' }).catch(() => {})
    throw error
  } finally {
    clearInterval(heartbeat)
    options.signal.removeEventListener('abort', cancel)
    // runLocalSandbox waits for namespace/process shutdown before returning or throwing.
    // A failed confirmation leaves a durable UNKNOWN claim rather than permitting another executor.
    await request('stopped', { claim }).catch(() => {})
  }
}
