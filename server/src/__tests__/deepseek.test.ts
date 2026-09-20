/** Unit tests for DeepSeek model-prefix routing. No network access. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type OpenAI from 'openai'
import {
  __setDeepSeekClientOverrideForTesting,
  deepseekClient,
  deepseekResponsesCreate,
  isDeepSeekModel,
  stripDeepSeekPrefix,
} from '../deepseek.js'

function fakeResponsesClient(create: (...args: unknown[]) => unknown): OpenAI {
  return { responses: { create } } as unknown as OpenAI
}

test('isDeepSeekModel / stripDeepSeekPrefix', () => {
  assert.equal(isDeepSeekModel('deepseek/deepseek-flash'), true)
  assert.equal(isDeepSeekModel('deepseek-flash'), false)
  assert.equal(isDeepSeekModel(null), false)
  assert.equal(isDeepSeekModel(undefined), false)
  assert.equal(stripDeepSeekPrefix('deepseek/deepseek-flash'), 'deepseek-flash')
})

test('deepseekResponsesCreate forwards the call with the prefix stripped', async () => {
  let captured: { model?: string; input?: string; max_output_tokens?: number } = {}
  __setDeepSeekClientOverrideForTesting(fakeResponsesClient(async (args: unknown) => {
    captured = args as typeof captured
    return { id: 'resp_1', output_text: '{"ok":true}' }
  }))
  try {
    const result = await deepseekResponsesCreate(
      { model: 'deepseek/deepseek-flash', input: 'hello', max_output_tokens: 50 },
    ) as { output_text: string }

    assert.equal(result.output_text, '{"ok":true}')
    assert.equal(captured.model, 'deepseek-flash')
    assert.equal(captured.input, 'hello')
    assert.equal(captured.max_output_tokens, 50)
  } finally {
    __setDeepSeekClientOverrideForTesting(null)
  }
})

test('deepseekClient uses the test override when set', () => {
  const fake = fakeResponsesClient(() => ({}))
  __setDeepSeekClientOverrideForTesting(fake)
  try {
    assert.equal(deepseekClient(), fake)
  } finally {
    __setDeepSeekClientOverrideForTesting(null)
  }
})
