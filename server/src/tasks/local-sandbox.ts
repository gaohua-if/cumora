import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readdir, lstat, readFile, rm, copyFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { TaskError, hashContent } from './contracts.js'

/** Task-only native Codex. Its only network peer is an in-namespace stdio model relay. */
const WORKER = String.raw`
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
const pending = new Map(); let counter=0;
const inbox=createInterface({input:process.stdin});
inbox.on('line',line=>{try { const r=JSON.parse(line); const done=pending.get(r.id); if(done){pending.delete(r.id);done(r);} } catch{}});
const emit=(event)=>process.stdout.write(JSON.stringify(event)+'\n');
function events(response) {
  const stream=[{type:'response.created',response:{...response,output:[],status:'in_progress'}}];
  for(const [output_index,item] of (response.output??[]).entries()) {
    stream.push({type:'response.output_item.added',output_index,item:{...item,status:'in_progress'}});
    if(item.type==='message') for(const [content_index,part] of (item.content??[]).entries()) {
      stream.push({type:'response.content_part.added',output_index,content_index,item_id:item.id,part:{...part,text:''}});
      stream.push({type:'response.output_text.delta',output_index,content_index,item_id:item.id,delta:part.text??''});
      stream.push({type:'response.output_text.done',output_index,content_index,item_id:item.id,text:part.text??''});
      stream.push({type:'response.content_part.done',output_index,content_index,item_id:item.id,part});
    }
    if(item.type==='function_call') {
      stream.push({type:'response.function_call_arguments.delta',output_index,item_id:item.id,delta:item.arguments});
      stream.push({type:'response.function_call_arguments.done',output_index,item_id:item.id,arguments:item.arguments});
    }
    if(item.type==='custom_tool_call') {
      stream.push({type:'response.custom_tool_call_input.delta',output_index,item_id:item.id,delta:item.input});
      stream.push({type:'response.custom_tool_call_input.done',output_index,item_id:item.id,input:item.input});
    }
    stream.push({type:'response.output_item.done',output_index,item});
  }
  stream.push({type:'response.completed',response});
  return stream.map((event,sequence_number)=>'event: '+event.type+'\ndata: '+JSON.stringify({...event,sequence_number})+'\n\n').join('');
}
const server=createServer(async(req,res)=>{
  if(req.method!=='POST'||req.url!=='/v1/responses'){res.writeHead(403);res.end();return;}
  let body=''; for await(const chunk of req){body+=chunk;if(body.length>2000000){res.writeHead(413);res.end();return;}}
  let request;try{request=JSON.parse(body);}catch{res.writeHead(400);res.end();return;}
  const id=String(++counter); const response=new Promise(done=>pending.set(id,done));
  emit({kind:'model',id,request});
  const result=await response;
  if(result.error){res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:result.error}}));return;}
  res.writeHead(200,{'Content-Type':request.stream?'text/event-stream':'application/json'});
  res.end(request.stream?events(result.response):JSON.stringify(result.response));
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const port=server.address().port;
const task=JSON.parse(await readFile('/inputs/task.json','utf8'));
const args=['exec','--json','--ephemeral','--skip-git-repo-check','--sandbox','danger-full-access','-C','/workspace',
  '-c','model_provider="cumora_task"','-c','model_providers.cumora_task.name="Cumora task broker"',
  '-c','model_providers.cumora_task.base_url="http://127.0.0.1:'+port+'/v1"',
  '-c','model_providers.cumora_task.wire_api="responses"','-c','model_providers.cumora_task.env_key="CUMORA_TASK_MODEL_KEY"',
  '-c','web_search="disabled"',
  ...['apps','plugins','skill_search','tool_suggest','image_generation','browser_use','browser_use_external','computer_use','multi_agent','memories','shell_snapshot','auth_elicitation','hooks','worktrees','workspace_dependencies','remote_plugin','skill_mcp_dependency_install'].flatMap(feature=>['-c','features.'+feature+'=false']),
  '-m',task.model,
  'Execute only this task. Input files in /inputs are approved and immutable. Put deliverables in /workspace as .md/.txt/.patch/.diff/.json. No external connections or persistent credentials are available. '+
  'If canPlan=true and collaboration is needed, write /workspace/task-plan.json as {parallelism:1..4,members:[{key,bindingId,objective,dependsOn:[],grantIds:[],role:"WORK"|"VERIFY"}]}. Use only supplied eligibleBindings and rootGrantIds; at most 8 nodes and one level. Write the plan then finish: the supervisor submits it and waits for children. Do not claim delivery. If canPlan=false, never write a plan; execute the child work or aggregate the approved child artifacts. Task: '+JSON.stringify(task.context)];
const child=spawn('/engine/codex',args,{env:{...process.env,CUMORA_TASK_MODEL_KEY:'task-local-relay'},stdio:['ignore','pipe','pipe']});
let answer=''; let engineError=''; const output=createInterface({input:child.stdout});
output.on('line',line=>{try{const e=JSON.parse(line);if(e.type==='item.completed'&&e.item?.type==='agent_message')answer=e.item.text;}catch{}});
child.stderr.on('data',chunk=>{if(engineError.length<2000)engineError+=chunk.toString();});
const code=await new Promise((done,reject)=>{child.on('error',reject);child.on('close',done);});
emit({kind:'result',code,answer,error:code===0?'':engineError});
server.close(); inbox.close(); process.exit(code===0?0:1);
`

export interface LocalSandboxOptions {
  binary: string
  binaryHash: string
  context: unknown
  model: string
  signal: AbortSignal
  modelCall(request: Record<string, unknown>): Promise<unknown>
}
export interface LocalSandboxResult { answer: string; plan?: unknown; artifacts: { name: string; content: string; mediaType: string; hash: string }[] }

export function sandboxArgs(input: { root: string; binary: string; worker: string; inputs: string; work: string; node?: string }): string[] {
  return ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--ro-bind', '/bin', '/bin',
    '--ro-bind', input.node ?? process.execPath, '/engine/node', '--ro-bind', input.binary, '/engine/codex',
    '--ro-bind', input.worker, '/bootstrap/worker.mjs', '--ro-bind', input.inputs, '/inputs', '--bind', input.work, '/workspace',
    '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/home', '--dir', '/home/task', '--dir', '/home/task/.codex',
    '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/home/task', '--setenv', 'CODEX_HOME', '/home/task/.codex',
    '--setenv', 'LANG', 'C.UTF-8', '--chdir', '/workspace', '/engine/node', '/bootstrap/worker.mjs']
}

export async function runLocalSandbox(options: LocalSandboxOptions): Promise<LocalSandboxResult> {
  if (process.platform !== 'linux') throw new TaskError('RUNTIME_CAPABILITY_UNQUALIFIED')
  const root = await mkdtemp(join(tmpdir(), 'cumora-channel-task-'))
  const work = join(root, 'work')
  const inputs = join(root, 'inputs')
  const worker = join(root, 'worker.mjs')
  await mkdir(work); await mkdir(inputs)
  await writeFile(worker, WORKER, { mode: 0o400 })
  await writeFile(join(inputs, 'task.json'), JSON.stringify({ context: options.context, model: options.model }), { mode: 0o400 })
  const immutableBinary = join(root, 'codex')
  await copyFile(options.binary, immutableBinary)
  await chmod(immutableBinary, 0o500)
  if (hashContent(await readFile(immutableBinary)) !== options.binaryHash) { await rm(root, { recursive: true, force: true }); throw new TaskError('RUNTIME_BINARY_CHANGED') }
  try {
    const child = spawn('bwrap', sandboxArgs({ root, binary: immutableBinary, worker, inputs, work }), { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let answer = ''
    let resultCode: number | null = null
    let processing: Promise<void> = Promise.resolve()
    let failure: unknown
    let errorText = ''
    let outputSize = 0
    let modelCalls = 0
    const stop = () => { child.kill('SIGKILL') }
    options.signal.addEventListener('abort', stop, { once: true })
    if (options.signal.aborted) stop()
    const cap = setTimeout(stop, 10 * 60_000)
    const lines = createInterface({ input: child.stdout })
    child.stdin.on('error', error => { failure=error;stop() })
    child.stderr.on('data', (chunk: Buffer) => { if (errorText.length < 2000) errorText += chunk.toString() })
    lines.on('line', (line) => {
      outputSize += Buffer.byteLength(line)
      if (outputSize > 20_000_000) { failure = new TaskError('RUNTIME_OUTPUT_LIMIT'); stop(); return }
      processing = processing.then(async () => {
        const event = JSON.parse(line) as Record<string, unknown>
        if (event.kind === 'result') {
          resultCode = Number(event.code)
          if (typeof event.answer !== 'string' || event.answer.length > 12000) throw new TaskError('INVALID_RUNTIME_RESULT')
          answer = event.answer
          if (resultCode !== 0 && typeof event.error === 'string') errorText = event.error.slice(0, 2000)
        } else if (event.kind === 'model') {
          if (++modelCalls > 24 || typeof event.id !== 'string' || !event.request || typeof event.request !== 'object') throw new TaskError('RUNTIME_MODEL_LIMIT')
          try {
            const response = await options.modelCall(event.request as Record<string, unknown>)
            child.stdin.write(JSON.stringify({ id: event.id, response }) + '\n')
          } catch (error) {
            child.stdin.write(JSON.stringify({ id: event.id, error: error instanceof TaskError ? error.code : 'MODEL_BROKER_FAILED' }) + '\n')
            throw error
          }
        } else throw new TaskError('INVALID_RUNTIME_PROTOCOL')
      }).catch((error) => { failure = error; stop() })
    })
    let code:number|null
    try { code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve) }) }
    finally { clearTimeout(cap);options.signal.removeEventListener('abort', stop) }
    await processing
    if (failure) throw failure
    if (options.signal.aborted) throw new TaskError('TASK_CONTEXT_REVOKED', 403)
    if (code !== 0 || resultCode !== 0) {
      const error = new TaskError(errorText.includes('namespace') ? 'RUNTIME_CAPABILITY_UNQUALIFIED' : 'LOCAL_ENGINE_FAILED')
      Object.defineProperty(error, 'cause', { value: errorText })
      throw error
    }
    const artifacts: LocalSandboxResult['artifacts'] = []
    let plan: unknown
    const walk = async (directory: string, prefix = ''): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        const name = prefix + entry.name
        const path = join(directory, entry.name)
        const stat = await lstat(path)
        if (stat.isSymbolicLink() || stat.nlink > 1) throw new TaskError('ARTIFACT_FILE_ESCAPE', 403)
        if (stat.isDirectory()) { if (prefix.split('/').length > 8) throw new TaskError('ARTIFACT_FILE_LIMIT'); await walk(path, name + '/'); continue }
        if (!stat.isFile() || !/\.(?:md|txt|patch|diff|json)$/.test(name)) continue
        if (stat.size > 2_000_000 || artifacts.length >= 32) throw new TaskError('ARTIFACT_FILE_LIMIT')
        const content = await readFile(path, 'utf8')
        if (name === 'task-plan.json') {
          if (stat.size > 64000) throw new TaskError('INVALID_PLAN', 400)
          try { plan = JSON.parse(content) } catch { throw new TaskError('INVALID_PLAN', 400) }
          if (!plan || typeof plan !== 'object') throw new TaskError('INVALID_PLAN', 400)
          continue
        }
        artifacts.push({ name, content, mediaType: /\.(patch|diff)$/.test(name) ? 'text/x-diff' : name.endsWith('.json') ? 'application/json' : name.endsWith('.md') ? 'text/markdown' : 'text/plain', hash: hashContent(content) })
      }
    }
    await walk(work)
    return { answer, plan, artifacts }
  } finally { await rm(root, { recursive: true, force: true }) }
}
