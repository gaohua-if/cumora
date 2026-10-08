import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EngineSessionStore, sessionIdPreview, nativeThreadSessionScope } from '../agents/computer/session-store.js'

const roots: string[] = []

test('native thread identities isolate every placement dimension and restore after switching or restart', async () => {
  const root = await temporaryRoot()
  const identity = { server: 'http://server', company: 'workspace', channel: 'channel', thread: 'thread-one', agent: 'aida', engine: 'codex' as const, provider: 'login', model: 'account-model', prompt: 'coordinate' }
  const first = nativeThreadSessionScope(identity)
  const second = nativeThreadSessionScope({ ...identity, thread: 'thread-two' })
  const one = new EngineSessionStore(root, identity.agent, 'codex', first)
  const two = new EngineSessionStore(root, identity.agent, 'codex', second)
  await one.save('first-native-session'); await two.save('second-native-session')
  assert.equal(await new EngineSessionStore(root, identity.agent, 'codex', nativeThreadSessionScope(identity)).load(), 'first-native-session')
  assert.equal(await two.load(), 'second-native-session')
  for (const key of ['server', 'company', 'channel', 'thread', 'agent', 'provider', 'model', 'prompt'] as const) assert.notEqual(nativeThreadSessionScope({ ...identity, [key]: identity[key] + '-other' }), first)
  assert.notEqual(nativeThreadSessionScope({ ...identity, engine: 'claude' }), first)
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-session-store-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test('engine stores for one agent use independent paths and values', async () => {
  const root = await temporaryRoot()
  const claude = new EngineSessionStore(root, 'atlas-a745', 'claude')
  const codex = new EngineSessionStore(root, 'atlas-a745', 'codex')

  assert.equal(claude.sessionFile, join(root, 'atlas-a745', 'claude.session'))
  assert.equal(codex.sessionFile, join(root, 'atlas-a745', 'codex.session'))
  await claude.save('claude-session')
  assert.equal(await codex.load(), null)
  await codex.save('codex-session')

  assert.equal(await claude.load(), 'claude-session')
  assert.equal(await codex.load(), 'codex-session')
})

test('switching claude to codex and back preserves each engine session', async () => {
  const root = await temporaryRoot()
  await new EngineSessionStore(root, 'atlas-a745', 'claude').save('claude-before-fallback')
  await new EngineSessionStore(root, 'atlas-a745', 'codex').save('codex-during-fallback')

  assert.equal(await new EngineSessionStore(root, 'atlas-a745', 'claude').load(), 'claude-before-fallback')
})

test('clearing one engine does not remove another engine session', async () => {
  const root = await temporaryRoot()
  const claude = new EngineSessionStore(root, 'atlas-a745', 'claude')
  const codex = new EngineSessionStore(root, 'atlas-a745', 'codex')
  await Promise.all([claude.save('claude-id'), codex.save('codex-id')])
  await claude.save(null)

  assert.equal(await claude.load(), null)
  assert.equal(await codex.load(), 'codex-id')
})

test('missing and empty files load as no session, while whitespace is trimmed', async () => {
  const root = await temporaryRoot()
  const store = new EngineSessionStore(root, 'atlas-a745', 'claude')
  assert.equal(await store.load(), null)

  await mkdir(join(root, 'atlas-a745'), { recursive: true })
  await writeFile(store.sessionFile, '')
  assert.equal(await store.load(), null)
  await writeFile(store.sessionFile, '  session-with-newline  \n')
  assert.equal(await store.load(), 'session-with-newline')
})

test('queued saves retain call order and flush observes the final value', async () => {
  const root = await temporaryRoot()
  const store = new EngineSessionStore(root, 'atlas-a745', 'claude')
  void store.save('old')
  void store.save(null)
  void store.save('new')
  await store.flush()

  assert.equal(await store.load(), 'new')
})

test('session files are private and contain one newline-terminated id', async () => {
  const root = await temporaryRoot()
  const store = new EngineSessionStore(root, 'atlas-a745', 'claude')
  await store.save('private-session')

  assert.equal(await readFile(store.sessionFile, 'utf8'), 'private-session\n')
  assert.equal((await stat(store.sessionFile)).mode & 0o777, 0o600)
})

test('a failed atomic replacement removes its temporary file', async () => {
  const root = await temporaryRoot()
  const store = new EngineSessionStore(root, 'atlas-a745', 'claude')
  await mkdir(store.sessionFile, { recursive: true }) // rename(file, directory) must fail
  await store.save('cannot-replace-directory')
  await store.flush()

  const entries = await readdir(join(root, 'atlas-a745'))
  assert.deepEqual(entries, ['claude.session'])
  assert.equal((await stat(store.sessionFile)).isDirectory(), true)
})

test('legacy session is quarantined without becoming an engine session', async () => {
  const root = await temporaryRoot()
  const legacy = join(root, 'atlas-a745.session')
  await writeFile(legacy, 'unknown-owner\n')
  const store = new EngineSessionStore(root, 'atlas-a745', 'claude')

  assert.equal(await store.quarantineLegacy(), true)
  assert.equal(await store.load(), null)
  const entries = await readdir(root)
  const quarantined = entries.find((entry) => entry.startsWith('atlas-a745.session.legacy-unscoped-'))
  assert.ok(quarantined)
  assert.equal(await readFile(join(root, quarantined), 'utf8'), 'unknown-owner\n')
  assert.equal(await store.quarantineLegacy(), false)
})

test('legacy quarantine leaves an existing engine-scoped session untouched', async () => {
  const root = await temporaryRoot()
  const store = new EngineSessionStore(root, 'atlas-a745', 'claude')
  await store.save('known-claude')
  await writeFile(join(root, 'atlas-a745.session'), 'unknown-owner')

  assert.equal(await store.quarantineLegacy(), true)
  assert.equal(await store.load(), 'known-claude')
})

test('a non-regular legacy path is ignored and never loaded', async () => {
  const root = await temporaryRoot()
  await mkdir(join(root, 'atlas-a745.session'))
  const store = new EngineSessionStore(root, 'atlas-a745', 'claude')

  assert.equal(await store.quarantineLegacy(), false)
  assert.equal(await store.load(), null)
})

test('session log previews never reveal the complete id', () => {
  const id = '01a06f71-1234-5678-9abc-def012345678'
  assert.equal(sessionIdPreview(id), '01a06f71')
  assert.doesNotMatch(sessionIdPreview(id), /1234/)
})
