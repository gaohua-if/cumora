import { execFileSync } from 'node:child_process'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const container = process.env.WORKBENCH_CONTAINER ?? 'cumora-server-1'
const baseline = JSON.parse(await readFile('docs/verification/configuration-workbench-2026-10-05/acceptance.json', 'utf8'))
const companyId = process.env.WORKBENCH_COMPANY ?? 'co-a09a2bc0-f'
const userId = process.env.WORKBENCH_USER ?? 'u-aafb44fb-e1d'
const channelId = process.env.AIDA_TEST_CHANNEL ?? baseline.objects.soloId
const existingMessageId = process.env.AIDA_TEST_MESSAGE ?? null
const script = `
import assert from 'node:assert/strict';
import {createSession,deleteSession} from './server/src/auth.ts';
import {pool} from './server/src/db/pool.ts';
import {listAgentsForComputer} from './server/src/agents/computer/registry.ts';
import {redis,sub} from './server/src/redis.ts';
const companyId=${JSON.stringify(companyId)}, channelId=${JSON.stringify(channelId)};
const {token}=await createSession(${JSON.stringify(userId)},{ua:'aida-codex-model-repair'});
try {
 const agent=(await listAgentsForComputer('comp-11c2fc72-048')).find(a=>a.id==='aida-lnn7');
 assert.equal(agent.model,'gpt-6-sol');assert.equal(agent.fastModel,'gpt-6-luna');
 let before=new Date();
 let message;
 if(${JSON.stringify(existingMessageId)}) {
  message=(await pool.query('SELECT id,sequence,created_at FROM messages WHERE id=$1 AND conversation_id=$2 AND company_id=$3',[${JSON.stringify(existingMessageId)},channelId,companyId])).rows[0];assert.ok(message);before=new Date(message.created_at);
 } else {
 const response=await fetch('http://127.0.0.1:5181/api/conversations/'+encodeURIComponent(channelId)+'/messages',{method:'POST',headers:{Authorization:'Bearer '+token,'x-company-id':companyId,'content-type':'application/json'},body:JSON.stringify({body:'@Aida 请验证本地 Codex 已恢复：计算 17 + 25，仅回复「LOCAL_CODEX_OK 42」，不要调用工具。',clientId:'aida-local-codex-'+Date.now()})});
 assert.ok(response.ok,JSON.stringify(await response.clone().json()));
 message=await response.json();
 }
 console.error('Sent verification message; waiting for local Aida.');
 let answer;
 for(let i=0;i<120;i++){
  const rows=(await pool.query("SELECT id,body,sequence FROM messages WHERE company_id=$1 AND conversation_id=$2 AND author_id='aida-lnn7' AND sequence>$3 ORDER BY sequence",[companyId,channelId,message.sequence])).rows;
  answer=rows.find(m=>m.body.includes('LOCAL_CODEX_OK')&&m.body.includes('42'));
  if(answer)break;
  await new Promise(r=>setTimeout(r,2000));
 }
 let runs,calls;
 for(let i=0;i<30;i++){
 runs=(await pool.query("SELECT id,status,model,error,input_tokens,output_tokens FROM agent_runs WHERE company_id=$1 AND agent_id='aida-lnn7' AND started_at>=$2 ORDER BY started_at",[companyId,before])).rows;
 calls=(await pool.query("SELECT run_id,purpose,source,model,status,input_tokens,output_tokens FROM llm_calls WHERE company_id=$1 AND agent_id='aida-lnn7' AND created_at>=$2 ORDER BY created_at",[companyId,before])).rows;
 if(runs.some(r=>r.status==='completed'&&r.model==='gpt-6-sol')&&calls.some(c=>c.status==='ok'&&c.model==='gpt-6-sol'))break;
 await new Promise(r=>setTimeout(r,500));
 }
 assert.ok(calls.some(c=>c.model==='gpt-6-sol'&&c.status==='ok'),'Missing successful measured Codex call');
 assert.ok(runs.some(r=>r.model==='gpt-6-sol'&&r.status==='completed'),'Missing completed local Codex run');
 assert.ok(answer,'Local Aida did not deliver the expected answer: '+JSON.stringify(runs));
 assert.ok(!runs.some(r=>r.error?.includes('not supported')),'Unsupported model still reached Codex');
 console.log(JSON.stringify({timestamp:new Date().toISOString(),companyId,channelId,agent:{id:agent.id,model:agent.model,fastModel:agent.fastModel},message,answer,runs,calls,realModelInference:true}));
} finally{await deleteSession(token);await pool.end();redis.disconnect();sub.disconnect();}
`
const output = execFileSync('docker', ['exec', '-i', container, 'node', '--import', 'tsx', '--input-type=module'], { input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], timeout: 260000 })
const result = JSON.parse(output.trim().split('\n').at(-1))
result.imageId = execFileSync('docker', ['inspect', '--format={{.Image}}', container], { encoding: 'utf8' }).trim()
const files = ['server/src/agents/computer/codex-model-defaults.ts', 'server/src/agents/computer/model-catalog.ts', 'server/src/agents/computer/registry.ts', 'scripts/verify-aida-local-codex.mjs']
result.sourceHashes = Object.fromEntries(await Promise.all(files.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])))
const artifact = resolve('docs/verification/aida-local-codex-2026-10-05')
await mkdir(artifact, { recursive: true })
await writeFile(artifact+'/acceptance.json', JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify({model:result.agent.model,answer:result.answer.body,artifact:artifact+'/acceptance.json'}))
