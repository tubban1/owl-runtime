/** Bound specific recovery checks to fresh OS-temp state, never an active home profile. */
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const scriptName=process.argv[2];
const allow=new Set(['verify-approval-resume','verify-fault-recovery','verify-state-isolation']);
if (!allow.has(scriptName)||process.argv.length!==3) throw new Error('ISOLATION_UNLISTED_TEST');
const cwd=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'owl-run-isolated-'));
const env={...process.env};
for(const key of ['OWL_STATE_ROOT','AGENTOS_STATE_ROOT','TASK_DIR','TASK_KEY_PATH',
 'TASK_STAGING_DIR','SCHEDULER_DIR','SCHEDULER_KEY_PATH','LOOP_DIR','LOOP_KEY_PATH',
 'SEMANTIC_MEMORY_DIR','SEMANTIC_MEMORY_KEY_PATH','EPISODIC_INDEX_DIR',
 'EPISODIC_INDEX_KEY_PATH','WORKSPACE_LEASE_DIR','WORKSPACE_HANDOFF_DIR',
 'TRANSACTION_DIR','OWL_APPROVAL_MODE','OWL_APPROVAL_ACTIONS',
 'OWL_RUNTIME_ACCESS_MODE','OWL_RUNTIME_REQUIRE_SIGNED_LEASE',
 'OWL_RUNTIME_LEASE_PUBLIC_KEY_PEM','OWL_RUNTIME_LEASE_PUBLIC_KEY_B64',
 'OWL_RUNTIME_LEASE_PUBLIC_KEY_FILE']) delete env[key];
env.OWL_RUNTIME_MODE='test';
// Synthetic test tasks must not depend on a real Cloud-signed device lease.
env.OWL_RUNTIME_ACCESS_MODE='compat';
env.OWL_RUNTIME_REQUIRE_SIGNED_LEASE='false';
env.OWL_STATE_ROOT=path.join(scratch,'state');
env.AGENTOS_STATE_ROOT=env.OWL_STATE_ROOT;
try{
  const child=spawnSync(process.execPath,[path.join(cwd,'node_modules/tsx/dist/cli.mjs'),
    path.join(cwd,'scripts',scriptName+'.ts')],{cwd,env,stdio:'inherit',timeout:90000});
  if(child.error) throw child.error;
  if(child.signal) throw new Error('TEST_TERMINATED:'+child.signal);
  process.exitCode=child.status??1;
}finally{fs.rmSync(scratch,{recursive:true,force:true});}
