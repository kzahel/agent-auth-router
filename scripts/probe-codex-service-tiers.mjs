#!/usr/bin/env node
// Manual, synthetic official-CLI probe. No real account/profile is used.
// node scripts/probe-codex-service-tiers.mjs /absolute/codex /absolute/models.json
import assert from "node:assert/strict";
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { StateStore, writePrivateJson } from '../src/state.ts';
import { startRouter } from '../src/runtime.ts';
import { hashGatewayToken, generateGatewayToken } from '../src/gateway-auth.ts';

const [codex, catalogPath] = process.argv.slice(2);
if (!codex || !catalogPath || process.platform === 'win32') throw Error('Pass an official Codex executable and its matching upstream models.json on macOS/Linux');
const dir = mkdtempSync('/tmp/aar-speed-probe-');
const model = 'aar-speed-fixture';
const rows = JSON.parse(readFileSync(catalogPath)).models;
const row = structuredClone(rows[0]); row.slug = model;
row.service_tiers = [{id:'priority',name:'Fast',description:'Synthetic speed tier'},{id:'ultrafast',name:'Ultra Fast',description:'Synthetic tier absent from bundled models'}];
row.default_service_tier = null;
const captured = [];
const upstream = createServer(async (req,res) => {
  const chunks=[]; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString();
  if (req.url.includes('/models')) { res.setHeader('content-type','application/json'); res.end(JSON.stringify({models:[row]})); return; }
  const request = JSON.parse(body);
  captured.push({path:req.url, tier:request.service_tier ?? null,model:request.model});
  const message = {id:'msg_'+randomUUID(),type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'ok',annotations:[]}]};
  const response = {id:'resp_'+randomUUID(),object:'response',created_at:Math.floor(Date.now()/1000),model,status:'completed',output:[message],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
  res.writeHead(200,{'content-type':'text/event-stream'});
  for (const event of [{type:'response.created',response:{...response,status:'in_progress',output:[]}}, {type:'response.output_item.added',output_index:0,item:{...message,status:'in_progress',content:[]}}, {type:'response.output_text.delta',item_id:message.id,output_index:0,content_index:0,delta:'ok'}, {type:'response.output_item.done',output_index:0,item:message}, {type:'response.completed',response}]) res.write('data: '+JSON.stringify(event)+'\n\n');
  res.end();
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const store = new StateStore(join(dir,'aar')); store.init();
const account = join(dir,'account'); mkdirSync(account);
writePrivateJson(join(account,'auth.json'),{tokens:{access_token:'synthetic',account_id:'fixture'},last_refresh:new Date().toISOString()});
store.saveAccounts([{id:'fixture',provider:'codex',home:account,helper:{kind:'none'}}]);
const token = generateGatewayToken();
store.saveClients([{id:'fixture',name:'fixture',tokenSha256:hashGatewayToken(token),accounts:{codex:'fixture'},createdAt:new Date().toISOString()}]);
writePrivateJson(store.configPath,{listen:{host:'127.0.0.1',port:0},upstreams:{codex:'http://127.0.0.1:'+upstream.address().port}});
const router = await startRouter(store,{}, {eventLog:false});
const home=join(dir,'codex');mkdirSync(home); const cwd=join(dir,'workspace');mkdirSync(cwd);
const args=['app-server',...['model_provider="aar"','model_providers.aar.name="AAR"',`model_providers.aar.base_url=${JSON.stringify(router.origin+'/codex')}`,'model_providers.aar.env_key="AAR_SESSION_TOKEN"',`model_providers.aar.model_catalog_url=${JSON.stringify(router.origin+'/codex/models')}`,'features.api_key_model_discovery=true','model_providers.aar.requires_openai_auth=false','model_providers.aar.supports_websockets=false','features.shell_tool=false','features.web_search_request=false'].flatMap(v=>['-c',v])];
const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG'].flatMap(k => process.env[k] ? [[k, process.env[k]]] : []));
const cli=spawn(resolve(codex),args,{cwd,env:{...env,HOME:home,CODEX_HOME:home,AAR_SESSION_TOKEN:token},stdio:['pipe','pipe','pipe']});
let seq=0; const pending=new Map(); const notifications=[]; let stderr='';cli.stderr.on('data',c=>{stderr+=c;});
createInterface({input:cli.stdout}).on('line',line=>{let m;try{m=JSON.parse(line);}catch{return;}if(m.id && pending.has(m.id)){const {resolve,reject,timer}=pending.get(m.id);clearTimeout(timer);pending.delete(m.id);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result);}else notifications.push(m);});
function rpc(method,params){return new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>reject(Error('RPC timeout '+method)),20000);pending.set(id,{resolve,reject,timer});cli.stdin.write(JSON.stringify({id,method,params})+'\n');});}
async function turn(id,tier){await rpc('turn/start',{threadId:id,serviceTier:tier,input:[{type:'text',text:'Reply exactly ok'}]});for(let n=0;n<200;n++){const i=notifications.findIndex(m=>m.method==='turn/completed');if(i>=0){const [m]=notifications.splice(i,1);if(m.params.turn.error)throw Error(JSON.stringify(m.params.turn.error));return;}await new Promise(r=>setTimeout(r,50));}throw Error('Turn completion timeout');}
try {
  await rpc('initialize',{clientInfo:{name:'aar_speed_spike',version:'1'},capabilities:{experimentalApi:true}});cli.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  const catalog=await rpc('model/list',{});assert.deepEqual(catalog.data.find(m=>m.id===model)?.serviceTiers?.map(t=>t.id), ['priority','ultrafast']);
  const started=await rpc('thread/start',{model,cwd,approvalPolicy:'never',sandbox:'read-only',serviceTier:'priority'});
  await turn(started.thread.id,'priority');
  await rpc('thread/settings/update',{threadId:started.thread.id,serviceTier:null});await turn(started.thread.id,null);
  await rpc('thread/resume',{threadId:started.thread.id,serviceTier:'ultrafast'});await turn(started.thread.id,'ultrafast');
  assert.deepEqual(captured.map(r=>r.tier), ['priority', null, 'ultrafast']); console.log(JSON.stringify({officialCliProbe:'passed',captured}));
} catch(e){console.error(JSON.stringify({error:String(e),captured,stderr:stderr.slice(-3000)}));process.exitCode=1;}
finally{for(const p of pending.values())clearTimeout(p.timer);cli.stdin.end();cli.kill('SIGTERM');await new Promise(r=>cli.once('close',r));await router.close(true);upstream.closeAllConnections();await new Promise(r=>upstream.close(r));rmSync(dir,{recursive:true,force:true});}
