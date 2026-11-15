import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runtimeStateRoot} from '../src/runtime/runtimePaths.js';
const env=process.env;
const previous={...env};
try {
  env.OWL_RUNTIME_MODE='test';
  for(const forbidden of [path.join(os.homedir(),'.owl-runtime-dev'),path.join(os.homedir(),'.owl-runtime'),os.homedir()]){
    env.OWL_STATE_ROOT=forbidden;
    assert.throws(()=>runtimeStateRoot(),/OWL_TEST_STATE_ROOT_NOT_ISOLATED/);
  }
  const safe=fs.mkdtempSync(path.join(os.tmpdir(),'owl-isolation-proof-'));
  try{
    env.OWL_STATE_ROOT=safe;
    env.AGENTOS_STATE_ROOT=path.join(os.homedir(),'.owl-runtime-dev');
    assert.equal(runtimeStateRoot(),safe);
    delete env.OWL_STATE_ROOT;
    env.AGENTOS_STATE_ROOT=path.join(os.homedir(),'.owl-runtime-dev');
    assert.throws(()=>runtimeStateRoot(),/OWL_TEST_STATE_ROOT_NOT_ISOLATED/);
    env.AGENTOS_STATE_ROOT=safe;
    assert.equal(runtimeStateRoot(),safe);
    const alias=path.join(safe,'alias-to-live');
    fs.symlinkSync(path.join(os.homedir(),'.owl-runtime-dev'),alias);
    env.OWL_STATE_ROOT=alias;
    assert.throws(()=>runtimeStateRoot(),/OWL_TEST_STATE_ROOT_NOT_ISOLATED/);

  } finally{fs.rmSync(safe,{recursive:true,force:true});}
  console.log(JSON.stringify({ok:true,forbiddenLiveRootsRejectedBeforeWrite:true,explicitRootPrecedence:true,symlinkSafe:true}));
} finally {
  for(const k of ['OWL_RUNTIME_MODE','OWL_STATE_ROOT','AGENTOS_STATE_ROOT']){
    if(previous[k]===undefined)delete env[k]; else env[k]=previous[k];
  }
}
