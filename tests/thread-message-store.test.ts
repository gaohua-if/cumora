import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createStore } from 'zustand/vanilla'

// Exercise the real store with controlled HTTP ordering and navigation, without a browser.
const app = createStore<any>(() => ({}))
const harness: any = { app, api: {}, auth: { getMeId: () => 'me' }, tasks: { getState: () => ({ references: {} }) } }
;(globalThis as any).__threadStoreHarness = harness
const bundle = await build({ entryPoints: ['src/stores/messages.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['zustand', 'react'], plugins: [{
  name: 'controlled-io', setup(builder) {
    builder.onResolve({ filter: /^@\/(api\/client|stores\/(auth|app|tasks))$/ }, args => ({ path: args.path, namespace: 'test-io' }))
    builder.onLoad({ filter: /.*/, namespace: 'test-io' }, args => ({ contents: args.path.endsWith('/client')
      ? 'export const api=globalThis.__threadStoreHarness.api; export class ApiError extends Error {constructor(status){super("failed");this.status=status}}; export const ws={};'
      : args.path.endsWith('/auth') ? 'export const getMeId=globalThis.__threadStoreHarness.auth.getMeId;'
        : args.path.endsWith('/tasks') ? 'export const useTaskSelection=globalThis.__threadStoreHarness.tasks;'
          : 'export const useApp=globalThis.__threadStoreHarness.app;', loader: 'js' }))
  },
}] })
const compiled = { exports: {} as any }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), compiled, compiled.exports)
const { useMessages, sendUserMessage, discardFailedMessage, retryFailedMessage } = compiled.exports
const message = (id: string, over: any = {}) => ({ id, conversationId: 'group', authorId: 'me', kind: 'text', body: id, sequence: 1, ...over })
function deferred() { let resolve!: (v: any) => void; let reject!: (e: any) => void; const promise = new Promise((r,j) => { resolve=r; reject=j }); return { promise, resolve, reject } }
const row = (id: string) => useMessages.getState().byConvo.group.find((m: any) => m.id === id)
let opened: string[] = []
beforeEach(() => {
  opened=[]
  app.setState({ view: 'conversations', selectedConversationId: 'group', openThread: null, infoAgentId: null, openDocumentId: null, openBoardId: null, openCalendarEventId: null, composeEmail: null,
    openThreadView: (_: string, id: string) => { opened.push(id); app.setState({ openThread: { convoId: 'group', rootId: id } }) } }, true)
  useMessages.setState({ byConvo: { group: [message('root', { threadId: 'root', replyCount: 2 }), message('child', { threadId: 'root', quotedMessageId: 'root', replyCount: 0 })] }, streaming: {}, typing: {} })
})
for (const ordering of ['http-first', 'ws-first']) test(`nested optimistic reply counts root once (${ordering})`, async () => {
  const response = deferred(); harness.api.sendMessage = () => response.promise
  const pending = sendUserMessage('group', 'nested reply', null, 'child', 'local')
  assert.equal(row('root').replyCount,3); assert.equal(row('child').replyCount,0); assert.equal(row('local').threadId,'root')
  const echo = () => useMessages.getState().applyEvent({ type:'message.new', conversationId:'group', message:message('confirmed', { clientId:'local', threadId:'root', quotedMessageId:'child', sequence:4 }) })
  if (ordering==='ws-first') echo()
  response.resolve({ id:'confirmed', threadId:'root' }); await pending
  echo(); echo()
  assert.equal(row('root').replyCount,3); assert.equal(row('child').replyCount,0)
  assert.equal(useMessages.getState().byConvo.group.filter((m: any) => m.id==='confirmed').length,1)
})
test('authoritative root moves an unknown optimistic quote count', async () => {
  useMessages.setState({ byConvo: { group: [message('root', { threadId:'root', replyCount:0 }), message('child', { replyCount:0 })] } })
  harness.api.sendMessage=async()=>({ id:'confirmed', threadId:'root' })
  await sendUserMessage('group','reply',null,'child','local')
  assert.equal(row('root').replyCount,1); assert.equal(row('child').replyCount,0)
})
test('discard and retry keep nested reply count balanced', async () => {
  harness.api.sendMessage=async()=>{ throw new Error('network interrupted') }
  await sendUserMessage('group','retry me',null,'child','local')
  assert.equal(row('root').replyCount,3)
  discardFailedMessage('group','local'); assert.equal(row('root').replyCount,2)
  await sendUserMessage('group','retry me',null,'child','local')
  harness.api.sendMessage=async()=>({ id:'confirmed', threadId:'root' })
  await retryFailedMessage('group','local'); assert.equal(row('root').replyCount,3); assert.equal(row('child').replyCount,0)
})
for (const navigation of ['channel', 'profile', 'document', 'away-and-back']) test(`delayed send respects ${navigation} navigation`, async () => {
  const response=deferred(); harness.api.sendMessage=()=>response.promise
  const pending=sendUserMessage('group','new task',null,null,'local')
  if(navigation==='channel')app.setState({selectedConversationId:'other'})
  if(navigation==='profile')app.setState({infoAgentId:'agent'})
  if(navigation==='document')app.setState({openDocumentId:'document'})
  if(navigation==='away-and-back'){app.setState({selectedConversationId:'other'});app.setState({selectedConversationId:'group'})}
  response.resolve({id:'new-root',threadId:'new-root'});await pending
  assert.deepEqual(opened,[]);assert.equal(row('new-root').pending,false)
})
test('unchanged sending surface opens the new task thread', async () => {
  harness.api.sendMessage=async()=>({id:'new-root',threadId:'new-root'})
  await sendUserMessage('group','new task',null,null,'local');assert.deepEqual(opened,['new-root'])
})
test('older root page cursor and scroll index ignore cached thread replies', async () => {
  useMessages.setState({ byConvo: { group:[message('root',{threadId:'root',sequence:10}),message('child',{threadId:'root',sequence:2})] }, loaded:new Set(['group']),hasMoreOlder:{group:true},loadingOlder:new Set(),firstItemIndex:{group:100} })
  harness.api.getMessages=async(_: string,opts: any)=>{assert.equal(opts.before,10);assert.equal(opts.view,'channel');return [message('older',{threadId:'older',sequence:5})]}
  await useMessages.getState().loadOlder('group');assert.equal(useMessages.getState().firstItemIndex.group,99)
})
