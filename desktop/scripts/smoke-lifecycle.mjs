// Actual native close/quit events, isolated from the installed app and real accounts.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const desktop = resolve(import.meta.dirname,"..");
const node = join(desktop,"resources/node"), cli = join(desktop,"resources/core/cli.js");
const app = join(desktop,"src-tauri/target/debug/agent-auth-router-desktop");
for (const attached of [false,true]) {
  const state = mkdtempSync("/tmp/aar-quit-");let child,router;
  const env = {...process.env,AAR_STATE_DIR:state,AAR_LIFECYCLE_SMOKE:"1"};
  const request = op => JSON.parse(execFileSync(node,[cli,"--state",state,"owner-request",op],{input:"{}",encoding:"utf8",stdio:["pipe","pipe","pipe"]}));
  try {
    writeFileSync(join(state,"config.json"),JSON.stringify({listen:{host:"127.0.0.1",port:0}}));
    writeFileSync(join(state,"synthetic-signin"),"synthetic-only");mkdirSync(join(state,"bin"));
    if (attached) {
      router=spawn(node,[cli,"--state",state,"serve"],{stdio:"ignore"});
      for(let i=0;i<100&&!existsSync(join(state,"control.sock"));i++)await delay(50);
      request("overview");
    }
    for (let launch=0;launch<2;launch++) {
      const result=join(state,"embedded-smoke.json");rmSync(result,{force:true});
      child=spawn(app,[],{env,stdio:"ignore"});
      for(let i=0;i<200&&child.exitCode===null&&child.signalCode===null;i++)await delay(100);
      assert.equal(child.exitCode,0,"Native app must finish Quit");
      assert.equal(JSON.parse(readFileSync(result)).ok,true,"Window close keeps routing");
      assert.equal(existsSync(join(state,"control.sock")),false,"Quit removes router IPC");
    }
    if(router){for(let i=0;i<50&&router.exitCode===null;i++)await delay(100);assert.equal(router.exitCode,0,"Quit stops an attached router too");}
    console.log(`${attached?"Attached":"App-started"} router: close hides, Quit stops, relaunch works.`);
  } finally {
    for (const p of [child,router]) if(p&&p.exitCode===null&&p.signalCode===null)p.kill("SIGTERM");
    for(let i=0;i<150&&existsSync(join(state,"control.sock"));i++)await delay(100);
    if(!existsSync(join(state,"control.sock")))rmSync(state,{recursive:true,force:true});
  }
}
