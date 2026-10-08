import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

for (const [label, key, mode] of [
  ['absent key', undefined, undefined],
  ['empty key', '', undefined],
  ['whitespace key', '  ', 'false'],
  ['explicit local-only with an old key', 'old-test-credential', 'true'],
] as const) {
  test(`${label} imports and rejects server inference before DB or network`, () => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, DOTENV_CONFIG_PATH: '/tmp/cumora-no-dotenv-for-test',
      REDIS_URL: 'redis://127.0.0.1:16379' }
    delete childEnv.OPENAI_API_KEY; delete childEnv.CUMORA_LOCAL_ONLY
    if (key !== undefined) childEnv.OPENAI_API_KEY = key
    if (mode !== undefined) childEnv.CUMORA_LOCAL_ONLY = mode
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      let requests=0;globalThis.fetch=async()=>{requests++;throw new Error('unexpected model network')};
      const {env}=await import('./server/src/env.ts');assert.equal(env.LOCAL_ONLY,true);
      const {pool}=await import('./server/src/db/pool.ts');
      let queries=0;pool.query=async()=>{queries++;throw new Error('unexpected tenant lookup')};
      const {getLlmClient}=await import('./server/src/llm.ts');
      await assert.rejects(getLlmClient('old-tenant'),e=>e.code==='SERVER_MODEL_UNAVAILABLE'&&e.status===503);
      const {embedText,backfillMemoryEmbeddings}=await import('./server/src/agents/embeddings.ts');
      assert.equal(await embedText('keep this memory'),null);await backfillMemoryEmbeddings();
      assert.equal(requests,0);assert.equal(queries,0);await pool.end();
    `], { env: childEnv, encoding: 'utf8', timeout: 15000 })
    assert.equal(child.status, 0, child.stderr || child.stdout)
  })
}

test('configured server API stays available when local-only is not selected', () => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const {modelCapabilities}=await import('./server/src/model-availability.ts');
    const {default:assert}=await import('node:assert/strict');
    assert.equal(modelCapabilities().mode,'server-api');
  `], { env: { ...process.env, DOTENV_CONFIG_PATH: '/tmp/cumora-no-dotenv-for-test',
    OPENAI_API_KEY: 'test-server-key', CUMORA_LOCAL_ONLY: 'false' }, encoding: 'utf8', timeout: 15000 })
  assert.equal(child.status, 0, child.stderr)
})
