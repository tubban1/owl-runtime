import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),"owl-drive-workspaces-"));
const a=path.join(tmp,"project-a"),b=path.join(tmp,"project-b");
try{
  await fs.mkdir(path.join(a,"src"),{recursive:true});
  await fs.mkdir(path.join(b,"src"),{recursive:true});
  await fs.writeFile(path.join(a,"package.json"),"{}");
  await fs.writeFile(path.join(b,".owl-workspace"),"");
  await fs.writeFile(path.join(a,"src","x.txt"),"x");
  await fs.writeFile(path.join(b,"src","x.txt"),"y");
  process.env.ALLOWED_DIRECTORIES=path.parse(tmp).root;
  const {resolveWorkspace,resolveActionWorkspaces}=await import("../src/runtime/workspaceResolver.js");
  const wa=await resolveWorkspace(path.join(a,"src","x.txt"),{requireProjectRoot:true});
  const wb=await resolveWorkspace(path.join(b,"src","x.txt"),{requireProjectRoot:true});
  assert.equal(wa,await fs.realpath(a));
  assert.equal(wb,await fs.realpath(b));
  assert.notEqual(wa,wb);
  assert.equal((await resolveActionWorkspaces("fs.write",
    {path:path.join(a,"src","x.txt")}))[0]?.workspace,await fs.realpath(a));
  const missing=path.join(tmp,"without-marker");
  await fs.mkdir(missing);
  await assert.rejects(resolveWorkspace(missing,{requireProjectRoot:true}),
    /WORKSPACE_PROJECT_ROOT_REQUIRED/);
  assert.equal(await resolveWorkspace(missing),path.parse(tmp).root);
  console.log("PASS: distinct non-Git projects never share drive-wide write lease");
}finally{
  await fs.rm(tmp,{recursive:true,force:true});
}
