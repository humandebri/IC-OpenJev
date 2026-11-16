import {spawn} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {ROOT,OUT,read,now} from './v2-common';
process.chdir(ROOT);
async function run(command:string,args:string[],label:string,deadline?:number){
 const fd=openSync(`${OUT}/${label}.log`,'a');console.log(`START ${label}`);
 try{await new Promise<void>((resolve,reject)=>{
  const child=spawn(command,args,{stdio:['ignore',fd,fd],env:{...process.env,PLAYWRIGHT_BROWSERS_PATH:'/tmp/openjev-playwright'}});
  const remaining=deadline?deadline-now():undefined;
  if(remaining!==undefined&&remaining<=0){child.kill('SIGTERM');reject(new Error('Final budget exhausted'));return;}
  const timer=remaining?setTimeout(()=>{child.kill('SIGTERM');reject(new Error(`${label} exceeded final deadline`));},remaining):undefined;
  child.on('error',e=>{if(timer)clearTimeout(timer);reject(e);});child.on('exit',code=>{if(timer)clearTimeout(timer);code===0?resolve():reject(new Error(`${label} exit ${code}`));});
 });}finally{closeSync(fd);}console.log(`DONE ${label}`);
}
const node=(name:string,args:string[]=[])=>['--import',`${ROOT}/web/tetris/node_modules/tsx/dist/loader.mjs`,`${ROOT}/web/tetris/scripts/${name}`,...args];
await run(process.execPath,node('v2-freeze-final.ts'),'freeze-final');const deadline=read(`${OUT}/budget.json`).final_deadline_ms;
await run(process.execPath,node('v2-browser-policy-parity.ts'),'browser-policy-parity',deadline);
await run(process.execPath,node('v2-browser-prediction.ts'),'browser-prediction-parity',deadline);
await run(process.execPath,node('v2-study-live.ts',['test']),'v2-study-test',deadline);
await run(process.execPath,node('v2-audit.ts',['test']),'v2-audit-test',deadline);
await run(process.execPath,node('v2-counterfactual.ts'),'v2-counterfactual',deadline);
await run(process.execPath,node('v2-selection-diagnosis.ts'),'v2-selection-diagnosis',deadline);
await run('/tmp/openjev-tetris-venv/bin/python',[`${ROOT}/tools/report_tetris_v2_json.py`],'test-report',deadline);
console.log(read(`${OUT}/test-report.json`));
