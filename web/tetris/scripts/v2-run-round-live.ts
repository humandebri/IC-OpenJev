import {spawn} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {ROOT,OUT,read,now} from './v2-common';
process.chdir(ROOT);const round=process.argv[2]||'initial';
while(!read(`${OUT}/training-${round}.json`).complete){if(now()>=read(`${OUT}/budget.json`).training_deadline_ms)throw new Error('Training/selection budget exhausted while waiting for models');await new Promise(r=>setTimeout(r,2000));}
for(const [script,args] of [['v2-verify-models.ts',[round]],['v2-browser-bench.ts',[round]],['v2-study.ts',['screen',round]],['v2-study-live.ts',['validate',round]]] as const){
 const stage=args.join('-'),fd=openSync(`${OUT}/${script.replace('.ts','')}-${stage}.log`,'a');
 console.log(`START ${script} ${args.join(' ')}`);
 try{await new Promise<void>((resolve,reject)=>{
  const child=spawn(process.execPath,['--import',`${ROOT}/web/tetris/node_modules/tsx/dist/loader.mjs`,`${ROOT}/web/tetris/scripts/${script}`,...args],{env:{...process.env,PLAYWRIGHT_BROWSERS_PATH:'/tmp/openjev-playwright'},stdio:['ignore',fd,fd]});
  child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`${script} ${stage}: exit ${code}`)));
 });}finally{closeSync(fd);}
 console.log(`DONE ${script} ${args.join(' ')}`);
}
console.log(read(`${OUT}/selection-${round}.json`));
