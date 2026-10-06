import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const url = process.env.PROTOTYPE_URL ?? 'http://127.0.0.1:5182/configuration-workbench-v2.html'
const artifact = resolve('docs/prototypes/configuration-workbench-v2')
await mkdir(join(artifact, 'screenshots'), { recursive: true })
const profile = await mkdtemp(join(tmpdir(), 'cumora-configuration-v2-'))
const chrome = spawn('google-chrome', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,1000', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
let ws
const checks = [], errors = [], requests = []
try {
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    let output = ''
    chrome.stderr.on('data', chunk => { output += chunk; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) resolveEndpoint(match[1]) })
    chrome.on('error', reject)
    chrome.on('exit', code => reject(new Error('Chrome exited: ' + code)))
  })
  ws = new WebSocket(endpoint)
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }) })
  let sequence = 0
  const pending = new Map()
  ws.addEventListener('message', event => {
    const reply = JSON.parse(event.data)
    if (reply.id) { const p = pending.get(reply.id); if (p) { pending.delete(reply.id); reply.error ? p.reject(new Error(JSON.stringify(reply.error))) : p.resolve(reply.result) } }
    else if (reply.method === 'Runtime.exceptionThrown') errors.push(reply.params.exceptionDetails.exception?.description ?? reply.params.exceptionDetails.text)
    else if (reply.method === 'Network.requestWillBeSent') requests.push(reply.params.request.url)
  })
  const cdp = (method, params = {}, sessionId) => new Promise((resolveCall, reject) => { const id = ++sequence; pending.set(id, { resolve: resolveCall, reject }); ws.send(JSON.stringify({ id, method, params, sessionId })) })
  const target = await cdp('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  await cdp('Page.enable', {}, sessionId)
  await cdp('Runtime.enable', {}, sessionId)
  await cdp('Network.enable', {}, sessionId)
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId)
  const evaluate = async expression => { const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Evaluate failed'); return result.result.value }
  const wait = async expression => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 100)) } throw new Error('Timed out: ' + expression) }
  const click = selector => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing '+${JSON.stringify(selector)});e.click();})()`)
  const fill = (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing '+${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`)
  const check = async (id, description, assertion) => { await assertion(); checks.push({ id, description, passed: true }); console.log('PASS ' + id + ' ' + description) }
  const shot = async name => { const image = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId); await writeFile(join(artifact, 'screenshots', name + '.png'), Buffer.from(image.data, 'base64')) }
  const nav = async (view, id, tab) => { await click(`[data-action=nav][data-id="${view}"]`); if (id) await click(`[data-action=select][data-id="${id}"]`); if (tab) await click(`[data-action=tab][data-id="${tab}"]`) }
  const save = () => click('#save')
  const confirm = () => click('[data-action=modal-submit]')
  const reset = async () => { await click('[data-action=reset]'); await click('[data-action=confirm-reset]') }
  const text = () => evaluate('document.body.innerText')
  await cdp('Page.navigate', { url }, sessionId)
  await wait("document.querySelector('#content h1')?.textContent==='Aida'")
  await check('AC01', '四类配置与本地默认 Aida', async () => { assert.equal(await evaluate('document.querySelectorAll("#nav [data-action=nav]").length'), 4); assert.match(await text(), /本地 · Codex/); await shot('01-agent-overview') })
  await nav('channels', 'solo', 'members')
  await check('AC02', '仅 Aida 群聊与多 Agent 群聊', async () => { assert.equal(await evaluate('document.querySelectorAll("[data-member]").length'), 1); await nav('channels', 'product', 'members'); assert.equal(await evaluate('document.querySelectorAll("[data-member]").length'), 3); await shot('02-channel-members') })
  await click('[data-action=binding-access][data-id=bram]'); await fill('#access-mode', 'subset'); await click('#access-subset input[value=engineering]'); await confirm(); await save()
  await click('[data-action=tab][data-id=access]'); await click('[data-action=detach-bundle][data-id=engineering]'); await save()
  await check('AC03', '删除最后一个子集引用保持为空', async () => { assert.match(await text(), /当前未选择资源包/); await click('[data-action=tab][data-id=effective]'); await fill('#effective-agent', 'bram'); assert.doesNotMatch(await evaluate('document.querySelector("#tab-content").innerText'), /团队知识库/); await shot('03-empty-subset') })
  await click('[data-action=tab][data-id=members]'); await click('[data-action=binding-access][data-id=bram]'); await fill('#access-mode', 'none'); await confirm(); await save()
  await check('AC04', '不使用外部资源是独立配置状态', async () => assert.match(await text(), /不使用外部资源/))
  await reset()
  for (const kind of ['agents', 'bundles', 'channels', 'skills']) {
    await nav(kind); await click('[data-action=create]'); await fill('#new-name', '撤销验证 ' + kind); await confirm(); await click('#discard')
    await check('AC05-' + kind, '撤销新建 ' + kind + ' 后可正常编辑', async () => { assert.doesNotMatch(await evaluate('document.querySelector("#content h1").textContent'), /撤销验证/); const selector = kind === 'channels' ? '#f-name' : '#f-name'; await fill(selector, '正常编辑'); await click('#discard') })
  }
  await nav('bundles', 'engineering', 'instructions'); await fill('#f-instructions', '工程开发新版说明'); await save()
  await nav('channels', 'product', 'access'); await click('[data-action=choose-bundles]')
  await check('AC06', '选择器展示当前 v2 与最新 v3', async () => { assert.match(await evaluate('document.querySelector("[role=dialog]").innerText'), /当前 v2/); assert.match(await evaluate('document.querySelector("[role=dialog]").innerText'), /最新 v3/); await shot('04-bundle-version-picker') })
  await confirm()
  await check('AC07', '普通选择确认不隐式升级 Bundle', async () => assert.equal(await evaluate('getChannel("product").bundles.find(r=>r.id==="engineering").version'), 2))
  await click('[data-action=upgrade-bundle][data-id=engineering]'); await confirm(); await save()
  await check('AC08', '明确升级 Bundle 后引用新版', async () => assert.equal(await evaluate('getChannel("product").bundles.find(r=>r.id==="engineering").version'), 3))
  await nav('channels', 'product', 'members'); await click('[data-action=binding-skills][data-id=bram]'); await click('.modal-body input[value=writing]'); await click('[data-action=import-skill]'); await fill('#import-name', '发布验证'); await fill('#import-body', '# 发布验证\n\n核对交付与测试结果。'); await confirm()
  await check('AC09', '导入返回原成员选择器，保留选择并勾选新 Skill', async () => { assert.match(await evaluate('document.querySelector("#modal-title").textContent'), /调整成员/); assert.equal(await evaluate('document.querySelector(".modal-body input[value=writing]").checked'), true); assert.equal(await evaluate('[...document.querySelectorAll(".modal-body input:checked")].length'), 4); await shot('05-import-preserves-picker') })
  await confirm(); await save()
  await check('AC10', '确认后 Skill 仅配置给当前群聊成员', async () => { assert.equal(await evaluate('memberSkills(getChannel("product"),"bram").length'), 4); assert.equal(await evaluate('getAgent("bram").skills.length'), 2) })
  await nav('channels', 'product', 'general'); await fill('#f-language', '跟随 Agent'); await save(); await click('[data-action=tab][data-id=effective]'); await fill('#effective-agent', 'bram')
  await check('AC11', '语言继承有终点并显示来源', async () => { assert.equal(await evaluate('document.querySelector("[data-effective-language]").textContent'), '中文'); assert.match(await text(), /来源：工作区默认/) })
  await click('[data-action=tab][data-id=general]'); await fill('#f-language', '中文'); await save(); await click('[data-action=tab][data-id=members]'); await fill('#binding-bram-language', 'English'); await save(); await click('[data-action=tab][data-id=effective]'); await fill('#effective-agent', 'bram')
  await check('AC12', '成员语言优先且预览标明来源', async () => { assert.equal(await evaluate('document.querySelector("[data-effective-language]").textContent'), 'English'); assert.match(await text(), /来源：群内 Agent 设置/); await shot('06-effective-language') })
  await nav('bundles', 'engineering', 'overview'); await fill('#f-identity', '专用项目账号'); await save(); await click('[data-action=tab][data-id=mcp]'); await click('[data-action=edit-resource][data-id=mcp-linear]'); await fill('#r-identity', '继承 Bundle 默认'); await confirm(); await save()
  await nav('channels', 'product', 'access'); await click('[data-action=upgrade-bundle][data-id=engineering]'); await confirm(); await save(); await click('[data-action=tab][data-id=effective]')
  await check('AC13', '预览逐项身份、身份来源与资源操作范围', async () => { const body = await text(); for (const pattern of [/实际身份：Cumora 服务账号/, /实际身份：Cumora GitHub App/, /实际身份：专用项目账号/, /身份来源：Bundle 默认/, /工具：search、fetch/, /分支：main/, /路径：\/\*\*/, /动作：读取代码、创建分支、创建 PR/, /端口：443/]) assert.match(body, pattern); await shot('07-resource-preview') })
  await reset(); await nav('channels', 'product', 'snapshots'); await fill('#snapshot-agent', 'bram'); await click('[data-action=capture-snapshot]')
  const originalSnapshot = await evaluate('JSON.stringify(data.tasks[0])')
  await nav('skills', 'coding', 'skill-body'); await fill('#f-body', '# 代码实现 v4\n\n更新验证流程。'); await save()
  await nav('agents', 'bram', 'skills')
  await check('AC14', 'Skill 发布不改变 Agent 固定引用', async () => { assert.match(await text(), /当前 v3/); assert.match(await text(), /最新 v4/) })
  await click('[data-action=upgrade-agent-skill][data-id=coding]'); await save(); await click('[data-action=tab][data-id=prompt]'); await fill('#f-prompt', 'Bram 新版职责'); await fill('#f-language', 'English'); await save()
  await nav('channels', 'product', 'members')
  await check('AC15', 'Agent 发布不改变已有群聊引用', async () => { assert.match(await evaluate('document.querySelector("[data-member=bram]").innerText'), /当前 Agent v2.*最新 v4/); await shot('08-agent-version-upgrade') })
  await click('[data-action=upgrade-member-agent][data-id=bram]'); await confirm(); await save(); await click('[data-action=tab][data-id=effective]'); await fill('#effective-agent', 'bram')
  await check('AC16', '群聊升级使用新提示词和 Skill，群聊语言优先于 Agent', async () => { assert.match(await text(), /Bram 新版职责/); assert.match(await text(), /代码实现 · v4/); assert.equal(await evaluate('document.querySelector("[data-effective-language]").textContent'), '中文') })
  await click('[data-action=tab][data-id=snapshots]'); await fill('#snapshot-agent', 'bram'); await click('[data-action=capture-snapshot]')
  await check('AC17', '配置升级后旧任务快照不变，新快照使用新版', async () => { assert.equal(await evaluate('JSON.stringify(data.tasks[0])'), originalSnapshot); assert.equal(await evaluate('data.tasks[1].context.agentVersion'), 4); assert.equal(await evaluate('data.tasks[0].context.agentVersion'), 2); await shot('09-task-snapshots') })
  await cdp('Page.reload', {}, sessionId); await wait('document.querySelector("#content h1")')
  await check('AC18', '刷新保留固定引用和任务快照', async () => { assert.equal(await evaluate('data.tasks.length'), 2); assert.equal(await evaluate('getChannel("product").bindings.bram.agentVersion'), 4); assert.equal(await evaluate('JSON.stringify(data.tasks[0])'), originalSnapshot) })
  await check('AC19', '无浏览器异常或业务 API / 外部连接请求', async () => { assert.deepEqual(errors, []); assert.deepEqual(requests.filter(r => !r.startsWith(new URL(url).origin) && !r.startsWith('data:')), []); assert.deepEqual(requests.filter(r => new URL(r).pathname.startsWith('/api/')), []) })
  const files = ['docs/prototypes/configuration-workbench-v2.html', 'scripts/verify-configuration-prototype.mjs']
  const sourceHashes = Object.fromEntries(await Promise.all(files.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])))
  await writeFile(join(artifact, 'acceptance.json'), JSON.stringify({ timestamp: new Date().toISOString(), url, viewport: { width: 1440, height: 1000 }, scope: 'desktop-browser-prototype', sourceHashes, checks, errors, requests }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: checks.length, artifact: join(artifact, 'acceptance.json') }))
} finally { ws?.close(); chrome.kill('SIGTERM') }
