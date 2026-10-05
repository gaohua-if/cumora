import {spawn} from 'node:child_process'
import {mkdir,writeFile,open,readFile,mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)),'..'))
const suite=process.argv[2]??'all'
if(!['all','unit','integration','workflow','rollback','native','ui','checks'].includes(suite))throw new Error('Expected all, checks, unit, integration, workflow, rollback, native or ui')
const output=process.argv[3]??'/tmp/cumora-channel-task-verification.json'
const database=process.env.INTEGRATION_DATABASE_URL
const env={...process.env,NODE_ENV:'test',CUMORA_RUNTIME_CLIENT:'http',OPENAI_API_KEY:'task-test-key',RESEND_API_KEY:''}
if(['all','integration','workflow','rollback','native','ui'].includes(suite)){
  if(!database || !/test/i.test(new URL(database).pathname) || /\b(prod|production|main|live)\b/i.test(new URL(database).pathname))throw new Error('INTEGRATION_DATABASE_URL must name a dedicated test database; tests truncate its data')
  if(!process.env.REDIS_URL)throw new Error('REDIS_URL must explicitly select a dedicated test Redis')
  env.DATABASE_URL=database
}
const commands=[]
const add=(label,args,test=false,ui=false)=>commands.push({label,args,test,ui})
if(['all','checks'].includes(suite)){
  add('OpenSpec strict validation',['openspec','validate','introduce-channel-task-execution','--strict'])
  add('server types',[process.execPath,'node_modules/typescript/bin/tsc','-p','server/tsconfig.json','--noEmit'])
  add('frontend types',[process.execPath,'node_modules/typescript/bin/tsc','--noEmit'])
  for(const name of ['big-brain','llm-tracked','engine-registry'])add(`guard ${name}`,[process.execPath,`scripts/guard-${name}.mjs`])
}
const testFile=(file,pattern)=>add(`${file}${pattern?` (${pattern})`:''}`,[process.execPath,'--import','tsx','--test','--test-isolation=none','--test-reporter=spec',...(pattern?[`--test-name-pattern=${pattern}`]:[]),file],true)
if(['all','unit'].includes(suite))for(const name of [
  'schema-migrations','schema-boot-retry','task-contracts','task-local-model','agents-runtime-jwt','agents-runtime-http-client',
  'agents-runtime-cli-argv','model-policy','agents-routing','agents-routing-election','agents-steer','agents-steer-interrupt',
  'engine-argv-rejection','engine-stdin-safety','agents-computer-blocked-engines','agents-computer-engine-model',
  'agents-computer-engine-hot-switch','computer-engine-defaults','calendar-recurrence','frontend-calendar-recurrence',
])testFile(`server/src/__tests__/${name}.test.ts`)
if(['all','integration'].includes(suite))for(const name of ['channel-task-execution','group-default-aida','task-entrypoints','organizational-governance','calendar-scheduler','runtime-aux-authorization','convene-concurrency'])testFile(`server/src/__integration__/${name}.test.ts`)
if(suite==='workflow'){
  testFile('server/src/__integration__/channel-task-execution.test.ts','Aida repair')
  testFile('server/src/__integration__/task-entrypoints.test.ts')
  testFile('server/src/__integration__/convene-concurrency.test.ts')
}
if(suite==='rollback')testFile('server/src/__integration__/task-entrypoints.test.ts','private Task arriving')
if(['all','native'].includes(suite))for(const name of ['task-local-boundary','task-local-workflow'])testFile(`server/src/__runtime__/${name}.test.ts`)
if(['all','ui'].includes(suite))add('desktop/mobile Chrome interactions',[process.execPath,'--import','tsx','scripts/test-task-chat-ui.mjs'],false,true)
const report={createdAt:new Date().toISOString(),suite,results:[],passed:false}
const logs=await mkdtemp(resolve(tmpdir(),'cumora-task-verify-'))
try{
  for(const {label,args,test,ui} of commands){
    console.log(`[verify] ${label}`)
    // Node 24 can exit without running/reporting tests when its test reporter
    // is attached to a nested anonymous pipe. Use a regular log descriptor and
    // require actual assertion counts, rather than trusting an exit code.
    const logPath=resolve(logs,`${report.results.length}.log`)
    const descriptor=await open(logPath,'w')
    let shown=0
    const show=async()=>{const log=await readFile(logPath,'utf8');if(log.length>shown){process.stdout.write(log.slice(shown));shown=log.length}return log}
    const ticker=setInterval(()=>{void show()},1000)
    let code
    try{code=await new Promise((resolve,reject)=>{
      const child=spawn(args[0],args.slice(1),{env,stdio:['ignore',descriptor.fd,descriptor.fd]})
      child.once('error',reject);child.once('close',resolve)
    })}finally{clearInterval(ticker);await descriptor.close()}
    const result={code,log:await show()}
    const count=name=>Number(result.log.match(new RegExp(`^[#ℹ] ${name} (\\d+)$`,'m'))?.[1]??NaN)
    const uiResult=ui?result.log.split('\n').map(line=>{try{return JSON.parse(line)}catch{return null}}).findLast(item=>item && Array.isArray(item.checks)):null
    const facts=test?{tests:count('tests'),pass:count('pass'),fail:count('fail'),skipped:count('skipped'),cancelled:count('cancelled')}:
      ui?{tests:uiResult?.checks.length??0,pass:uiResult?.passed??0,fail:0,skipped:uiResult?.skipped??NaN,cancelled:0}:{}
    const passed=result.code===0 && (!(test||ui) || facts.tests>0 && facts.pass===facts.tests && facts.fail===0 && facts.skipped===0 && facts.cancelled===0)
    report.results.push({label,logPath,code:result.code,passed,...facts})
    if(!passed)throw new Error(`Required verification failed: ${label}`)
  }
  report.passed=true
}finally{
  await mkdir(dirname(resolve(output)),{recursive:true})
  await writeFile(output,JSON.stringify(report,null,2)+'\n')
  console.log(`[verify] report: ${output}`)
}
