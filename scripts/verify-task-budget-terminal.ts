import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const scratch=path.join(root,".tmp-verify-task-budget-terminal");
await fs.rm(scratch,{recursive:true,force:true});
await fs.mkdir(scratch,{recursive:true});
process.env.OWL_STATE_ROOT=path.join(scratch,"state");
process.env.ALLOWED_DIRECTORIES=root;
process.env.OWL_RUNTIME_MODE="test";
process.env.OWL_APPROVAL_MODE="compat";
process.env.OWL_RUNTIME_ACCESS_MODE="compat";

try{
 const {createPersistentTask,runPersistentTask,getPersistentTaskStatus}
   =await import("../src/tasks/taskRuntime.js");
 const pathToRead=path.join(root,"package.json");
 const one=await createPersistentTask("single read succeeds at the wave boundary",[
  {id:"read",action:"fs.read",args:{path:pathToRead}},
 ],{maxConcurrency:1,failFast:true});
 const result=await runPersistentTask(one.id,{
  maxConcurrency:1,maxWaves:1,timeBudgetMs:1000,
 });
 assert.equal(result.status,"completed",
  "One succeeded wave must not be mislabeled paused just because maxWaves=1");
 const status=await getPersistentTaskStatus(one.id,false);
 assert.equal(status.status,"completed");
 assert.equal(status.progress.terminal,true);
 assert.equal(status.progress.counts.succeeded,1);
 assert.ok(status.events.some(event=>event.type==="task_completed"));
 assert.ok(!status.events.some(event=>event.type==="run_paused"));

 const two=await createPersistentTask("two dependent reads still respect wave budget",[
  {id:"first",action:"fs.read",args:{path:pathToRead}},
  {id:"second",action:"fs.read",args:{path:pathToRead},dependsOn:["first"]},
 ],{maxConcurrency:1,failFast:true});
 const paused=await runPersistentTask(two.id,{
  maxConcurrency:1,maxWaves:1,timeBudgetMs:1000,
 });
 assert.equal(paused.status,"paused","Genuinely unfinished task must remain paused");
 const pauseStatus=await getPersistentTaskStatus(two.id,false);
 assert.equal(pauseStatus.progress.terminal,false);
 assert.equal(pauseStatus.progress.counts.succeeded,1);
 const completed=await runPersistentTask(two.id,{
  maxConcurrency:1,maxWaves:5,timeBudgetMs:1000,
 });
 assert.equal(completed.status,"completed");
 console.log(JSON.stringify({ok:true,terminalWinsAtWaveBudget:true,
  unfinishedStillPauses:true,resumeOnlyPendingStep:true}));
}finally{
 await fs.rm(scratch,{recursive:true,force:true});
}
