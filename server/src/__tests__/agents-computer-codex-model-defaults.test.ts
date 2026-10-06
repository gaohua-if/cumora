import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCodexModelDefaults } from '../agents/computer/codex-model-defaults.js'
import type { EngineModelCatalog } from '../agents/computer/model-catalog.js'

const catalog: EngineModelCatalog = {
  source: 'protocol', models: [{ id: 'gpt-6-astra', label: 'Astra' }, { id: 'gpt-6-sol', label: 'Sol' }, { id: 'gpt-6-luna', label: 'Luna' }],
  defaultModel: 'gpt-6-astra', defaultFastModel: 'gpt-6-luna', fastModelScope: 'agent', supportsCustom: true,
}
test('unconfigured Codex Agent receives account defaults instead of inheriting host config', () => {
  assert.deepEqual(resolveCodexModelDefaults({ catalog }), { model: 'gpt-6-astra', fastModel: 'gpt-6-luna' })
})
test('explicit Agent, computer and deployment model choices retain their precedence', () => {
  assert.deepEqual(resolveCodexModelDefaults({ catalog, model: 'agent/model', fastModel: 'agent/fast', computer: { model: 'computer/model', fastModel: 'computer/fast' }, deploymentModel: 'deployment/model' }), { model: 'agent/model', fastModel: 'agent/fast' })
  assert.equal(resolveCodexModelDefaults({ catalog, computer: { model: 'computer/model' }, deploymentModel: 'deployment/model' }).model, 'computer/model')
  assert.equal(resolveCodexModelDefaults({ catalog, deploymentModel: 'deployment/model' }).model, 'deployment/model')
})
test('missing, guessed or inconsistent catalogs do not impose unsupported models', () => {
  assert.deepEqual(resolveCodexModelDefaults({}), { model: null, fastModel: null })
  assert.deepEqual(resolveCodexModelDefaults({ catalog: { ...catalog, source: 'presets' } }), { model: null, fastModel: null })
  assert.deepEqual(resolveCodexModelDefaults({ catalog: { ...catalog, defaultModel: 'gpt-6.1-sol', defaultFastModel: 'missing' } }), { model: null, fastModel: null })
})
test('old daemon preset is replaced by advertised Luna only for an unpinned fast model', () => {
  const stale = { ...catalog, models: [...catalog.models, { id: 'gpt-5.4-mini', label: 'Mini' }], defaultFastModel: 'gpt-5.4-mini' }
  assert.equal(resolveCodexModelDefaults({ catalog: stale }).fastModel, 'gpt-6-luna')
  assert.equal(resolveCodexModelDefaults({ catalog: stale, fastModel: 'operator/fast' }).fastModel, 'operator/fast')
})
