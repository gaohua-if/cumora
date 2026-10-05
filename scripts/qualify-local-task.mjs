import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
// Run with: node --import tsx scripts/qualify-local-task.mjs [output] [server|codex-login]
import { resolveLocalCodex } from '../server/src/tasks/local-client.ts'

const output = resolve(process.argv[2] ?? '/tmp/cumora-local-task-admission.json')
const modelProvider = process.argv[3] ?? 'server'
if (!['server', 'codex-login'].includes(modelProvider)) throw new Error('Expected server or codex-login model provider')
const binary = await resolveLocalCodex()
const hash = async () => createHash('sha256').update(await readFile(binary)).digest('hex')
const before = await hash()
const log = `${output}.log`
// Use a regular output file, so Node 24's test runner reports every assertion.
const { open } = await import('node:fs/promises')
const file = await open(log, 'w', 0o600)
let code
try { code = await new Promise((done, fail) => { const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-isolation=none', 'server/src/__runtime__/task-local-boundary.test.ts'], { stdio: ['ignore', file.fd, file.fd] }); child.once('error', fail); child.once('close', done) }) }
finally { await file.close() }
const text = await readFile(log, 'utf8')
const count = name => Number(text.match(new RegExp(`^[#ℹ] ${name} (\\d+)$`, 'm'))?.[1])
if (code !== 0 || count('tests') < 3 || count('pass') !== count('tests') || count('fail') !== 0 || count('skipped') !== 0 || count('cancelled') !== 0 || before !== await hash()) throw new Error(`Local qualification failed; inspect ${log}`)
const record = { engine: 'codex', binaryHash: before, modelProvider, verificationRef: `Native boundary tests ${new Date().toISOString()}; ${log}; sha256:${createHash('sha256').update(text).digest('hex')}`,
  checks: { filesystem: true, environment: true, process: true, network: true, freshSession: true, stoppedChildren: true }, tests: count('pass') }
await writeFile(output, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify({ passed: true, tests: record.tests, output, binaryHash: before, modelProvider }))
