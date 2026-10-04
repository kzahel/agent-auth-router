import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync, chmodSync, symlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { desktopStartupError, recoverDesktopSocket } from "../src/desktop-lifecycle.ts";
import { StateStore } from "../src/state.ts";
import { ownerRequest } from "../src/owner.ts";
import { generateGatewayToken, hashGatewayToken } from "../src/gateway-auth.ts";
import { writeClaudeCredentials } from "./support.ts";

const cli = join(import.meta.dirname, "../src/cli.ts");
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(50); }
  throw new Error("fixture deadline");
}
function fixture(t: TestContext) {
  const dir = mkdtempSync("/tmp/aar-life-"); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new StateStore(dir); store.init();
  writeFileSync(store.configPath, JSON.stringify({ listen: { host: "127.0.0.1", port: 0 } }));
  return store;
}
function launch(t: TestContext, store: StateStore, desktop = true) {
  const child = spawn(process.execPath, [cli, "--state", store.dir, desktop ? "desktop-serve" : "serve"], { stdio: ["pipe", "ignore", "pipe"] });
  let errors = "";child.stderr!.on("data", d => errors += d);
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child,"exit"); } });
  return { child, errors: () => errors };
}
async function ready(store: StateStore) {
  await until(async () => { try { await ownerRequest(store,"overview"); return true; } catch { return false; } });
  return ownerRequest(store,"overview");
}
async function dead(child: ChildProcess) { await until(() => child.exitCode !== null || child.signalCode !== null); }

test("desktop parent loss stops the router, releases IPC and permits relaunch", async t => {
  const store=fixture(t), first=launch(t,store); await ready(store);
  first.child.stdin!.end(); await dead(first.child);
  assert.equal(first.child.exitCode,0,first.errors()); assert.equal(existsSync(join(store.dir,"control.sock")),false);
  const second=launch(t,store);await ready(store);second.child.stdin!.end();await dead(second.child);
  assert.equal(second.child.exitCode,0,second.errors());
});
test("desktop recovers a dead private socket and preserves non-socket or live endpoints", async t => {
  const store=fixture(t), first=launch(t,store);await ready(store);
  first.child.kill("SIGKILL");await dead(first.child);assert.ok(existsSync(join(store.dir,"control.sock")));
  const second=launch(t,store);await ready(store);
  assert.equal(readdirSync(store.dir).filter(n=>n.startsWith("control.sock.stale-")).length,1);
  const inode=lstatSync(join(store.dir,"control.sock")).ino;
  await assert.rejects(recoverDesktopSocket(store),/active/);
  assert.equal(lstatSync(join(store.dir,"control.sock")).ino,inode);
  second.child.stdin!.end();await dead(second.child);
  writeFileSync(join(store.dir,"control.sock"),"not a socket",{mode:0o600});
  await assert.rejects(recoverDesktopSocket(store),/private/);
  rmSync(join(store.dir,"control.sock"));symlinkSync("config.json",join(store.dir,"control.sock"));
  await assert.rejects(recoverDesktopSocket(store),/private/);
});
test("desktop reports safe startup reasons instead of configuration contents", async t => {
  const store=fixture(t);
  writeFileSync(store.configPath,'{"synthetic-secret": broken');
  const first=launch(t,store);await dead(first.child);
  assert.match(first.errors(),/AAR_STARTUP_ERROR:.*invalid JSON/);assert.doesNotMatch(first.errors(),/synthetic-secret/);
  const occupied=createServer();await new Promise<void>(r=>occupied.listen(0,"127.0.0.1",r));t.after(()=>occupied.close());
  writeFileSync(store.configPath,JSON.stringify({listen:{host:"127.0.0.1",port:(occupied.address() as any).port}}));
  const second=launch(t,store);await dead(second.child);assert.match(second.errors(),/listening address is already in use/);
  assert.doesNotMatch(desktopStartupError(new Error("unexpected-secret")),/unexpected-secret/);
});
test("owner shutdown interrupts active streams while idle stop remains guarded", async t => {
  const store=fixture(t);
  const upstream=http.createServer((_q,r)=>{r.writeHead(200,{"content-type":"text/event-stream"});r.write("data: synthetic\n\n");});
  await new Promise<void>(r=>upstream.listen(0,"127.0.0.1",r));t.after(()=>{upstream.closeAllConnections();upstream.close();});
  const origin=`http://127.0.0.1:${(upstream.address() as any).port}`;
  writeFileSync(store.configPath,JSON.stringify({listen:{host:"127.0.0.1",port:0},upstreams:{claude:origin}}));
  const home=join(store.profilesDir,"synthetic");new StateStore(home).init();writeClaudeCredentials(home,"synthetic",Date.now()+3600000);
  store.saveAccounts([{id:"a",provider:"claude",home}]);const token=generateGatewayToken();
  store.saveClients([{id:"c",name:"Synthetic",tokenSha256:hashGatewayToken(token),accounts:{claude:"a"},createdAt:new Date().toISOString()}]);
  const running=launch(t,store,false), overview=await ready(store);
  const response=await fetch(overview.origin+"/claude/v1/messages",{method:"POST",headers:{authorization:`Bearer ${token}`},body:"{}"});
  const reader=response.body!.getReader();await reader.read();
  await assert.rejects(ownerRequest(store,"stop",{routerId:overview.routerId}),/busy/);
  await assert.rejects(ownerRequest(store,"shutdown",{routerId:"wrong"}),/identity/);
  await ownerRequest(store,"shutdown",{routerId:overview.routerId});
  await dead(running.child);assert.equal(running.child.exitCode,0,running.errors());
  assert.equal(existsSync(join(store.dir,"control.sock")),false);
  await assert.rejects(reader.read());
});

test("desktop shutdown reaps renewal helpers and stubborn descendants", async t => {
  const store=fixture(t),home=join(store.profilesDir,"synthetic");new StateStore(home).init();
  writeClaudeCredentials(home,"synthetic",Date.now()-1000);
  const helper=join(store.dir,"helper.mjs"),pids=join(store.dir,"pids.json");
  writeFileSync(helper,`import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('READY');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','inherit']});
child.stdout.once('data',()=>writeFileSync(process.argv[2],JSON.stringify([process.pid,child.pid])));
setInterval(()=>{},1000);`);
  store.saveAccounts([{id:"a",provider:"claude",home,helper:{kind:"command",command:process.execPath,args:[helper,pids]}}]);
  const running=launch(t,store);await ready(store);
  const renewal=ownerRequest(store,"accounts/renew",{id:"a"}).catch(()=>{});
  await until(()=>existsSync(pids));
  const processes=JSON.parse(readFileSync(pids,"utf8")) as number[];
  t.after(()=>{for(const pid of processes)try{process.kill(pid,"SIGKILL");}catch{}});
  running.child.stdin!.end();await dead(running.child);await renewal;
  assert.equal(running.child.exitCode,0,running.errors());
  await until(()=>processes.every(pid=>{try{process.kill(pid,0);return false;}catch{return true;}}));
});
