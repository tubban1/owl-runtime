// Proves macOS lockf gating without replacing the TCC-authorized Helper binary.
import {spawn,spawnSync} from "node:child_process";
import {existsSync,mkdtempSync,rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {setTimeout as sleep} from "node:timers/promises";

if(process.platform!=="darwin"){console.log("SKIP macOS only");process.exit(0);}
const folder=mkdtempSync(path.join(os.tmpdir(),"owl-helper-legacy-lockf-"));
const lock=path.join(folder,"single.lock");
const exe="/usr/bin/lockf";
const args=["-k","-t","0",lock];
let first;
try {
 first=spawn(exe,[...args,"/bin/sleep","2"],{stdio:"ignore"});
 await sleep(150);
 assert.equal(first.exitCode,null,"first holder exited before second request");
 const second=spawnSync(exe,[...args,"/usr/bin/true"],{encoding:"utf8",timeout:3000});
 assert.equal(second.status,75,"a second launcher must fail EX_TEMPFAIL without starting Helper");
 await new Promise((resolve,reject)=>{
   first.on("close",code=>code===0?resolve():reject(new Error("first exited "+code)));
   first.on("error",reject);
 });
 assert.ok(existsSync(lock),"persistent lock file must not be unlinked (prevent inode split)");
 const third=spawnSync(exe,[...args,"/usr/bin/true"],{encoding:"utf8",timeout:3000});
 assert.equal(third.status,0,"launch must succeed after lock holder exits");
 console.log("PASS: legacy authorized Helper single-instance launcher: acquire, reject competing, release, reacquire");
} finally {
 if(first && first.exitCode===null)first.kill("SIGTERM");
 rmSync(folder,{recursive:true,force:true});
}
