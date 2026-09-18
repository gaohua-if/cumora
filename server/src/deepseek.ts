/**
 * DeepSeek LLM provider — model-prefix routing over its OpenAI-compatible
 * Responses API.
 *
 * A caller opts in with a model id prefixed by `deepseek/`, for example
 * `deepseek/deepseek-flash`. The prefix is stripped before the request is sent
 * to DeepSeek. This lets individual auxiliary workloads move independently
 * without replacing the tenant's normal OpenAI/sub2api client.
 */
import OpenAI from 'openai'
import { env } from './env.js'

export const DEEPSEEK_MODEL_PREFIX = 'deepseek/'

export function isDeepSeekModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && model.startsWith(DEEPSEEK_MODEL_PREFIX)
}

export function stripDeepSeekPrefix(model: string): string {
  return model.slice(DEEPSEEK_MODEL_PREFIX.length)
}

let _deepseekClient: OpenAI | null = null
let testDeepSeekClientOverride: OpenAI | null = null

/** Test-only override. Production code never sets this. */
export function __setDeepSeekClientOverrideForTesting(client: OpenAI | null): void {
  testDeepSeekClientOverride = client
}

export function deepseekClient(): OpenAI {
  if (testDeepSeekClientOverride) return testDeepSeekClientOverride
  if (!_deepseekClient) {
    _deepseekClient = new OpenAI({
      // A dedicated key wins, but self-hosted deployments may intentionally
      // place their DeepSeek key in the historically-required OPENAI_API_KEY.
      apiKey: env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY,
      baseURL: env.DEEPSEEK_BASE_URL,
    })
  }
  return _deepseekClient
}

/** DeepSeek supports the Responses API, so forwarding only requires a model
 * prefix strip and a provider-specific base URL/API key. */
export function deepseekResponsesCreate(
  args: { model?: string } & Record<string, unknown>,
  opts?: unknown,
): unknown {
  const { model, ...rest } = args
  return deepseekClient().responses.create(
    { ...rest, model: stripDeepSeekPrefix(model ?? '') } as never,
    opts as never,
  )
}
