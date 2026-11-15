/** Synthetic child/stdio test, no active Runtime or production workspace touched. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'owl-verify-shell-settlement-'));
process.env.OWL_RUNTIME_MODE='test';
process.env.OWL_STATE_ROOT=path.join(scratch,'state');
process.env.AGENTOS_STATE_ROOT=process.env.OWL_STATE_ROOT;
process.env.ALLOWED_DIRECTORIES=scratch;
process.env.ALLOW_SHELL='true';
process.env.SHELL=process.platform==='win32'?'powershell.exe':'/bin/sh';
const {executeCommand}=await import('../src/tools/shellOps.js');
const run=code=>'node -e '+JSON.stringify(code);
try{
 const childScript=`const p=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},4000)'],{detached:true,stdio:['ignore',1,2]});p.unref()`;
 const began=Date.now();
 const inherited=await executeCommand(run(childScript),scratch,6000);
 const elapsed=Date.now()-began;
 assert.equal(inherited.exitCode,0,JSON.stringify(inherited));
 assert.ok(elapsed<3000,`Shell result blocked by inherited descendant stdio for ${elapsed}ms`);
 assert.equal(inherited.outputComplete,false,'Inherited stdout pipe should be marked incomplete');
 assert.equal(inherited.outcomeUncertain,true,'A detached child can continue side effects');

 const timeoutStarted=Date.now();
 const timeout=await executeCommand(run('setTimeout(()=>{},8000)'),scratch,1000);
 const timeoutDuration=Date.now()-timeoutStarted;
 assert.equal(timeout.timedOut,true);
 assert.equal(timeout.outcomeUncertain,true);
 assert.ok(timeoutDuration<6000,`Timeout did not release mutation/permit: ${timeoutDuration}ms`);
 console.log(JSON.stringify({ok:true,inheritedPipeSettlementMs:elapsed,
   deadlineSettlementMs:timeoutDuration,unknownResultFlagPreserved:true}));
}finally{await fs.rm(scratch,{recursive:true,force:true})}
