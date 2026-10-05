/// <reference lib="dom" />
// This cross-runtime regression also imports the browser's download helper.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { collectCodexResponse } from '../tasks/codex-login-model.js'
import { taskContentHash, downloadTaskArtifact } from '../../../src/lib/task-artifacts.js'

test('LAN-compatible artifact hashes match SHA-256 for Unicode, empty and multi-block text', () => {
  for (const content of ['', 'abc', '中文产物\n🛠️', 'a'.repeat(10000)]) assert.equal(taskContentHash(content), createHash('sha256').update(content).digest('hex'))
})

test('artifact hash mismatch rejects a download before accessing browser APIs', () => {
  assert.throws(() => downloadTaskArtifact('wrong', { content: 'tampered', mediaType: 'text/plain', hash: taskContentHash('original') }), /产物内容校验失败/)
})

test('Codex SSE collects complete output items when completion output is empty, including split CRLF/UTF8', async () => {
  const item = { type: 'message', id: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已验证 42' }] }
  const data = [{ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'response', status: 'completed', output: [], usage: { input_tokens: 4, output_tokens: 6 } } }].map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('')
  const bytes = new TextEncoder().encode(data)
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } })
  const response = await collectCodexResponse(stream, AbortSignal.timeout(1000))
  assert.deepEqual(response.output, [item]); assert.deepEqual(response.usage, { input_tokens: 4, output_tokens: 6 })
})

test('Codex failed/incomplete streams never return partial output or provider error details', async () => {
  for (const data of ['data: {"type":"response.failed","response":{"error":{"message":"PROVIDER_SECRET"}}}\n\n', 'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message"}}\n\n']) {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(data)); controller.close() } })
    await assert.rejects(collectCodexResponse(stream, AbortSignal.timeout(1000)), error => error instanceof Error && /CODEX_MODEL_FAILED|CODEX_MODEL_INCOMPLETE/.test(error.message) && !error.message.includes('PROVIDER_SECRET'))
  }
})
