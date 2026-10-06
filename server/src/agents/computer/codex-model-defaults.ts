import type { EngineModelCatalog } from './model-catalog.js'

/** A discovered account catalog is authoritative for an unpinned Codex Agent.
 * Leaving the model unset lets a resumed thread or host config select a model
 * that the current ChatGPT account cannot use. Explicit operator choices win. */
export function resolveCodexModelDefaults(input: {
  model?: string | null
  fastModel?: string | null
  computer?: { model?: string | null; fastModel?: string | null }
  deploymentModel?: string | null
  catalog?: EngineModelCatalog
}): { model: string | null; fastModel: string | null } {
  const catalog = input.catalog?.source === 'protocol' ? input.catalog : undefined
  const available = new Set(catalog?.models.map(model => model.id))
  const discoveredModel = catalog?.defaultModel && available.has(catalog.defaultModel)
    ? catalog.defaultModel : null
  // Older daemons merged this retired preset into the real account catalog.
  // Prefer the advertised replacement without changing any explicit pin.
  const advertisedFast = catalog?.defaultFastModel === 'gpt-5.4-mini' && available.has('gpt-6-luna')
    ? 'gpt-6-luna' : catalog?.defaultFastModel
  const discoveredFast = advertisedFast && available.has(advertisedFast) ? advertisedFast : null
  return {
    model: input.model ?? input.computer?.model ?? input.deploymentModel ?? discoveredModel,
    fastModel: input.fastModel ?? input.computer?.fastModel ?? discoveredFast,
  }
}
