import {spawn} from 'node:child_process';
import {existsSync,readFileSync,mkdirSync} from 'node:fs';
import {ROOT,OUT,read,atomic,hashes,sha,now} from './v2-common';
process.chdir(ROOT);const directory=`${OUT}/ui`;mkdirSync(directory,{recursive:true});
const SOURCE=['web/tetris/src/main.tsx','web/tetris/src/placement-browser-v2.ts','web/tetris/src/placement-fast.ts','web/tetris/src/placement-value-v2.ts','web/tetris/src/move-preview.ts','web/tetris/src/app.css'];
while(!existsSync(`${OUT}/selection-final.json`)||!existsSync(`${ROOT}/web/tetris/public/tetris-value-v2.json`)){
 if(now()>read(`${OUT}/budget.json`).overall_deadline_ms)throw new Error('Budget exhausted before final asset');await new Promise(r=>setTimeout(r,2000));
}
async function run(args:string[],cwd=ROOT){
 return new Promise<{code:number;output:string}>((resolve,reject)=>{const child=spawn(process.execPath,args,{cwd,env:{...process.env,PLAYWRIGHT_BROWSERS_PATH:'/tmp/openjev-playwright',UI_URL:'http://127.0.0.1:5178/'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});child.on('error',reject);child.on('exit',code=>resolve({code:code??-1,output}));});
}
const functional=await run(['--import',`${ROOT}/web/tetris/node_modules/tsx/dist/loader.mjs`,`${ROOT}/web/tetris/scripts/v2-ui-check.ts`]);
atomic(`${directory}/functional-command.json`,functional);if(functional.code)throw new Error(functional.output);console.log('PASS functional UI');
const cli=`${ROOT}/web/tetris/node_modules/@mizchi/vlmkit/dist/vlmkit.mjs`,url='http://127.0.0.1:5178/';
const commands:{id:string;args:string[]}[]=[
 {id:'integrity',args:['check','integrity',url]},
 {id:'copy',args:['check','copy',url,'--manifest',`${ROOT}/web/tetris/v2-copy.txt`]},
 {id:'scroll',args:['check','scroll',url]},
 {id:'handlers',args:['scan','handlers',url,'--rule','scan.handlers/drag-source-not-draggable=warn']},
 {id:'interactions',args:['check','interactions',url]},
 {id:'breakpoints',args:['check','breakpoints',url,'--sweep']},
];
const gates:Record<string,unknown>={};
for(const command of commands){
 const result=await run([cli,...command.args,'--json','--no-ledger']);atomic(`${directory}/gate-${command.id}.json`,result);
 let parsed;try{parsed=JSON.parse(result.output);}catch{throw new Error(result.output);}
 gates[command.id]=parsed;atomic(`${directory}/gates.json`,{passed:false,results:gates,source_hashes:hashes(SOURCE),retune_reason:'React delegates synthetic dragstart on #root; source has no drag feature. Functional UI is tested separately.'});
 if(result.code||parsed.verdict!=='pass')throw new Error(`${command.id}: ${result.output}`);console.log(`PASS ${command.id}`);
}
atomic(`${directory}/gates.json`,{passed:true,results:gates,source_hashes:hashes(SOURCE),asset_sha256:sha(readFileSync(`${ROOT}/web/tetris/public/tetris-value-v2.json`)),retune_reason:'React delegates synthetic dragstart on #root; source has no drag feature. Functional UI is tested separately.'});
const checks=[];
for(const args of [['node_modules/typescript/bin/tsc','--noEmit'],['node_modules/vitest/vitest.mjs','run'],['node_modules/vite/bin/vite.js','build']]){
 const result=await run(args,`${ROOT}/web/tetris`);checks.push({command:[process.execPath,...args],...result});if(result.code)throw new Error(result.output);console.log(`PASS ${args[0]}`);
}
atomic(`${directory}/tests-build.json`,{passed:true,checks,source_hashes:hashes(SOURCE),asset_sha256:sha(readFileSync(`${ROOT}/web/tetris/public/tetris-value-v2.json`))});
