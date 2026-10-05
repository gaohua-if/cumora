import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLocalSandbox } from '../tasks/local-sandbox.js'
import { resolveLocalCodex } from '../tasks/local-client.js'
import { hashContent } from '../tasks/contracts.js'

function response(output: unknown[]) {
  return { id: 'resp_task_boundary', object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', error: null, incomplete_details: null,
    model: 'gpt-5.4', output, parallel_tool_calls: false, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }
}

test('admitted Linux/Codex task has isolated files, credentials, process view, network and task sessions', { timeout: 120000 }, async () => {
  const binary = await resolveLocalCodex()
  const binaryHash = hashContent(await readFile(binary))
  const fixture = await mkdtemp(join(tmpdir(), 'cumora-host-boundary-'))
  const secret = join(fixture, 'host-secret.txt')
  await writeFile(secret, 'HOST_FILE_SECRET')
  process.env.CUMORA_TASK_HOST_SECRET = 'HOST_ENV_SECRET'
  let calls = 0
  let inspected = false
  try {
    const result = await runLocalSandbox({ binary, binaryHash, model: 'gpt-5.4', context: { taskId: 'first-task', objective: 'Write a boundary report', inputs: [{ content: 'APPROVED_TASK_INPUT' }] },
      signal: AbortSignal.timeout(90000), modelCall: async (request) => {
        calls++
        const serialized = JSON.stringify(request)
        assert.ok(!serialized.includes('HOST_ENV_SECRET') && !serialized.includes('HOST_FILE_SECRET'), 'host secret values must not enter the model')
        if (calls === 1) {
          const tools = request.tools as { type: string; name?: string }[]
          const command = tools.find((tool) => tool.type === 'function' && tool.name === 'exec_command')
          assert.ok(command, 'native Codex must advertise its actual local execution tool')
          const probe = `const fs=require('node:fs'); const net=require('node:net'); const report={environment:!process.env.CUMORA_TASK_HOST_SECRET&&!process.env.DATABASE_URL&&!process.env.REDIS_URL,filesystem:!fs.existsSync(${JSON.stringify(secret)}),process:!fs.existsSync('/proc/${process.pid}'),input:fs.readFileSync('/inputs/task.json','utf8').includes('APPROVED_TASK_INPUT')};const socket=net.connect({host:'127.0.0.1',port:15432});socket.on('connect',()=>{report.network=false;socket.destroy();fs.writeFileSync('/workspace/boundary.json',JSON.stringify(report));});socket.on('error',()=>{report.network=true;fs.writeFileSync('/workspace/boundary.json',JSON.stringify(report));});`
          return response([{ type: 'function_call', id: 'fc_boundary', call_id: 'call_boundary', name: 'exec_command', arguments: JSON.stringify({ cmd: `/engine/node -e ${"'" + probe.replaceAll("'", "'\\''") + "'"}`, yield_time_ms: 1000, max_output_tokens: 2000 }) }])
        }
        inspected = serialized.includes('call_boundary')
        return response([{ type: 'message', id: 'msg_boundary', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Boundary report complete.', annotations: [] }] }])
      } })
    assert.ok(inspected)
    assert.equal(result.answer, 'Boundary report complete.')
    const report = JSON.parse(result.artifacts.find((artifact) => artifact.name === 'boundary.json')!.content)
    assert.deepEqual(report, { environment: true, filesystem: true, process: true, input: true, network: true })
    const second = await runLocalSandbox({ binary, binaryHash, model: 'gpt-5.4', context: { taskId: 'second-task', objective: 'Fresh task', inputs: [{ content: 'SECOND_TASK_ONLY' }] },
      signal: AbortSignal.timeout(90000), modelCall: async (request) => {
        assert.doesNotMatch(JSON.stringify(request), /APPROVED_TASK_INPUT|Boundary report complete/)
        return response([{ type: 'message', id: 'msg_second', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fresh task.', annotations: [] }] }])
      } })
    assert.equal(second.artifacts.length, 0)
    assert.equal(second.answer, 'Fresh task.')
  } finally { delete process.env.CUMORA_TASK_HOST_SECRET; await rm(fixture, { recursive: true, force: true }) }
})

test('abort terminates the actual Codex namespace and its outstanding shell descendants',async()=>{
  const binary=await resolveLocalCodex()
  const binaryHash=hashContent(await readFile(binary))
  const marker=`cumora-stop-${randomUUID()}`
  const abort=new AbortController()
  let calls=0
  let observed=false
  const result=runLocalSandbox({binary,binaryHash,model:'gpt-5.4',context:{taskId:'abort-task',objective:'Run the stop proof'},signal:abort.signal,
    modelCall:async(request)=>{
      if(++calls===1)return response([{type:'function_call',id:'fc_sleep',call_id:'call_sleep',name:'exec_command',arguments:JSON.stringify({cmd:`sh -c 'sleep 120' ${marker}`,yield_time_ms:1000,max_output_tokens:1000})}])
      const processes=await promisify(execFile)('ps',['-eo','pid,args'])
      observed=processes.stdout.includes(marker)
      abort.abort()
      return response([{type:'message',id:'msg_abort',role:'assistant',status:'completed',content:[{type:'output_text',text:'Stopped.',annotations:[]}]}])
    }})
  await assert.rejects(result,/TASK_CONTEXT_REVOKED|LOCAL_ENGINE_FAILED/)
  assert.equal(observed,true,'the test must observe a running descendant before cancellation')
  const remaining=await promisify(execFile)('ps',['-eo','pid,args'])
  assert.equal(remaining.stdout.includes(marker),false,'stop confirmation must wait until all namespace descendants exit')
})

test('a native tool cannot write input manifests or return symlink artifacts',async()=>{
  const binary=await resolveLocalCodex()
  const binaryHash=hashContent(await readFile(binary))
  let calls=0
  await assert.rejects(runLocalSandbox({binary,binaryHash,model:'gpt-5.4',context:{taskId:'escape-task',objective:'Test immutable inputs'},signal:AbortSignal.timeout(90000),modelCall:async()=>{
    if(++calls===1)return response([{type:'function_call',id:'fc_escape',call_id:'call_escape',name:'exec_command',arguments:JSON.stringify({cmd:"if echo changed > /inputs/task.json; then echo INPUT_WRITE_BYPASS; else echo INPUT_IMMUTABLE; fi; ln -s /inputs/task.json /workspace/escape.txt",yield_time_ms:1000,max_output_tokens:1000})}])
    return response([{type:'message',id:'msg_escape',role:'assistant',status:'completed',content:[{type:'output_text',text:'Boundary tested.',annotations:[]}]}])
  }}),/ARTIFACT_FILE_ESCAPE/)
})
