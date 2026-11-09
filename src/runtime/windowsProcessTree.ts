import {execFile} from "node:child_process";
import {promisify} from "node:util";
const execute=promisify(execFile);
export type WindowsTreeStopReceipt={
  sent:boolean;verified:boolean;forced:boolean;
  status:"stopped"|"not-running"|"identity-mismatch"|"unverified";
};
export function authorizedWindowsPidTime(
  observedAt:string|undefined,
  recordedAt:string,
  now=Date.now(),
):boolean {
  if(!observedAt)return false;
  const started=Date.parse(recordedAt),observed=Date.parse(observedAt);
  return Number.isFinite(started)&&Number.isFinite(observed)&&
    observed<=now&&Math.abs(started-observed)<30_000;
}
function alive(pid:number):boolean{
  try {process.kill(pid,0);return true;}
  catch(error){return (error as NodeJS.ErrnoException).code==="EPERM";}
}
export async function terminateOwnedWindowsProcessTree(
 pid:number,recordedAt:string,signal:NodeJS.Signals="SIGTERM",
):Promise<WindowsTreeStopReceipt>{
 if(process.platform!=="win32")throw Error("WINDOWS_PROCESS_TREE_NOT_WIN32");
 if(!Number.isSafeInteger(pid)||pid<=0)throw Error("WINDOWS_PROCESS_TREE_INVALID_PID");
 // Owner is checked by killProcess; additionally verify PID birth to defend
 // against PID reuse after Runtime restart.
 const query="$p=Get-CimInstance Win32_Process -Filter 'ProcessId="+pid+"' -ErrorAction Stop; if($p){$p.CreationDate.ToUniversalTime().ToString('o')}";
 const observed=await execute("powershell.exe",
  ["-NoProfile","-NonInteractive","-Command",query],
  {timeout:9000,windowsHide:true,maxBuffer:4096});
 const birth=observed.stdout.trim();
 if(!birth)return {sent:false,verified:true,forced:false,status:"not-running"};
 if(!authorizedWindowsPidTime(birth,recordedAt))
   return {sent:false,verified:false,forced:false,status:"identity-mismatch"};
 const runTaskKill=async(force:boolean)=>{
   try{
     await execute("taskkill.exe",
       ["/PID",String(pid),"/T",...(force?["/F"]:[])],
       {timeout:7000,windowsHide:true,maxBuffer:8192});
   }catch(error){
     if(alive(pid)&&force)throw error;
   }
 };
 if(signal==="SIGKILL")await runTaskKill(true);
 else await runTaskKill(false);
 for(let i=0;i<5&&alive(pid);i++)
   await new Promise(resolve=>setTimeout(resolve,150));
 let forced=signal==="SIGKILL";
 if(alive(pid)){
   forced=true;await runTaskKill(true);
   for(let i=0;i<10&&alive(pid);i++)
     await new Promise(resolve=>setTimeout(resolve,150));
 }
 const verified=!alive(pid);
 return {sent:true,verified,forced,
   status:verified?"stopped":"unverified"};
}
