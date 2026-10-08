import { env } from './env.js'

export class ServerModelUnavailableError extends Error {
  readonly code = 'SERVER_MODEL_UNAVAILABLE'
  readonly status = 503
  constructor() { super('SERVER_MODEL_UNAVAILABLE'); this.name = 'ServerModelUnavailableError' }
}

export function requireServerInference(): void {
  if (env.LOCAL_ONLY) throw new ServerModelUnavailableError()
}

export function modelCapabilities() {
  return { mode: env.LOCAL_ONLY ? 'local-only' as const : 'server-api' as const,
    serverInference: !env.LOCAL_ONLY, embeddings: !env.LOCAL_ONLY && !!env.OPENAI_API_KEY,
    generatedImages: !env.LOCAL_ONLY, routing: 'aida' as const }
}
