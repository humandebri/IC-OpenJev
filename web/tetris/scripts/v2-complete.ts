// Local orchestration only. Stage protocols own all model/data/selection decisions.
import {spawn} from 'node:child_process';
import {existsSync,copyFileSync,openSync,closeSync} from 'node:fs';
import {ROOT,OUT,read,now,atomic} from './v2-common';
process.chdir(ROOT);
async function run(command:string,args:string[],label:string){
 const budget=read(`${OUT}/budget.json`);if(now()>=budget.overall_deadline_ms)throw new Error('24-hour budget exhausted');
 const fd=openSync(`${OUT}/${label}.log`,'a');console.log(`START ${label}`);
 try{await new Promise<void>((resolve,reject)=>{const child=spawn(command,args,{env:{...process.env,PLAYWRIGHT_BROWSERS_PATH:'/tmp/openjev-playwright',DYLD_LIBRARY_PATH:'/Users/0xhude/.cache/uv/archive-v0/9r-dMaAoNok3rEjY/torch/lib'},stdio:['ignore',fd,fd]});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`${label} exit ${code}`)));});}finally{closeSync(fd);}console.log(`DONE ${label}`);
}
const node=(script:string,args:string[]=[])=>['--import',`${ROOT}/web/tetris/node_modules/tsx/dist/loader.mjs`,`${ROOT}/web/tetris/scripts/${script}`,...args];
await run(process.execPath,node('v2-run-round-live.ts',['initial']),'round-initial-corrected');
const available=read(`${OUT}/budget.json`);
if(Math.min(available.data_deadline_ms,available.training_deadline_ms)-now()>=30*60_000){
 await run(process.execPath,node('v2-extra.ts'),'extra-collection');
 copyFileSync(`${OUT}/dataset-manifest.json`,`${OUT}/dataset-manifest-extra.json`);
 await run('/tmp/openjev-tetris-venv/bin/python',[`${ROOT}/tools/audit_tetris_v2_data.py`],'data-audit-extra');copyFileSync(`${OUT}/data-audit.json`,`${OUT}/data-audit-extra.json`);
 await run('/tmp/openjev-tetris-venv/bin/python',[`${ROOT}/tools/train_tetris_v2.py`,'extra'],'training-extra');
 await run(process.execPath,node('v2-run-round-live.ts',['extra']),'round-extra');
}else atomic(`${OUT}/extra-skipped.json`,{reason:'Less than 30 minutes remain in the data/selection budgets',at_ms:now()});
await run(process.execPath,node('v2-run-final.ts'),'round-final');
console.log('Completed held-out study and audit; UI/build/adoption gates remain.');
