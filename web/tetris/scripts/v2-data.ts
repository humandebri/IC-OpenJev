import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync,readdirSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {fastChoices,bestChoice,Teacher,pieceStream,POP,fastPlacements,type MaskBoard,type FastChoice} from '../src/placement-fast';
import {valueFeatures,featureNames,topTwo,costRequest,v2Score,validateBundle,type ValueBundle} from '../src/placement-value-v2';
import {NativeOracle} from './v2-oracle';
import {ROOT,OUT,sha,derive,random,read,atomic,freeze,dataProtocol,now,hashes,DATA_SOURCES} from './v2-common';
process.chdir(ROOT);mkdirSync(OUT,{recursive:true});
import {collect,labelGroup,type Group} from './v2-data-core';
const mode=process.argv[2]||'generate';
if(mode==='worker'){
 const source=process.argv[3],destination=process.argv[4],deadline=Number(process.argv[5]),protocolHash=process.argv[6];
 const active=read(`${OUT}/data-protocol.json`);if(JSON.stringify(active.source_hashes)!==JSON.stringify(hashes(DATA_SOURCES)))throw new Error('Worker source changed');
 const groupFile=read<{groups:Group[];protocol_sha256:string}>(source);if(groupFile.protocol_sha256!==protocolHash)throw new Error('Group lineage mismatch');
 const teacher=new Teacher(),rows=[];let groups=0;
 for(const group of groupFile.groups){if(now()>=deadline)break;rows.push(...labelGroup(group,teacher));groups++;}
 atomic(destination,{protocol_sha256:protocolHash,groups,complete:groups===groupFile.groups.length,teacher_cache:{hits:teacher.hits,misses:teacher.misses},rows});
 process.exit(0);
}
if(mode==='generate'||mode==='extra'){
 const protocol=dataProtocol();freeze(`${OUT}/data-protocol.json`,protocol);const protocolHash=sha(JSON.stringify(protocol));
 const budgetFile=`${OUT}/budget.json`;
 if(!existsSync(budgetFile))atomic(budgetFile,{started_ms:now(),data_started_ms:now(),data_deadline_ms:now()+14*3600_000,overall_deadline_ms:now()+24*3600_000});
 const budget=read(budgetFile);if(now()>=budget.data_deadline_ms)throw new Error('Data budget exhausted');
 const bundle=mode==='extra'?read<ValueBundle>(process.argv[3]):undefined;if(bundle)validateBundle(bundle);
 const extraHash=bundle?sha(JSON.stringify(bundle)):null;
 const tasks=(mode==='extra'?protocol.seeds.extra.map((seed,index)=>({seed,index,split:'extra'})):[...protocol.seeds.train.map((seed,index)=>({seed,index,split:'train'})),...protocol.seeds.data_valid.map((seed,index)=>({seed,index,split:'data_valid'}))]);
 // Shuffle source episodes before any deadline can truncate the set.
 const rng=random(1729);for(let i=tasks.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[tasks[i],tasks[j]]=[tasks[j],tasks[i]];}
 mkdirSync(`${OUT}/groups`,{recursive:true});mkdirSync(`${OUT}/rows`,{recursive:true});
 const sourceDeadline=now()+Math.min(2*3600_000,(budget.data_deadline_ms-now())/4);
 const oracle=new NativeOracle();let done=0;
 try{
  for(const task of tasks){
   if(now()>=sourceDeadline)break;
   const key=`${task.split}-${task.seed}`,path=`${OUT}/groups/${key}.json`;
   if(existsSync(path)){const old=read(path);if(old.protocol_sha256!==protocolHash||old.extra_model_sha256!==extraHash)throw new Error('Stale collected data');}
   else atomic(path,{protocol_sha256:protocolHash,extra_model_sha256:extraHash,groups:await collect(task.seed,task.split,task.index,oracle,bundle)});
   if(++done%32===0){atomic(`${OUT}/data-progress.json`,{stage:'collect',done,total:tasks.length,elapsed_seconds:(now()-budget.data_started_ms)/1000});console.log(`collect ${done}/${tasks.length}`);await new Promise(r=>setTimeout(r,0));}
  }
 }finally{oracle.close();}
 let cursor=0,completed=0;
 await Promise.all(Array.from({length:4},async()=>{while(cursor<tasks.length&&now()<budget.data_deadline_ms){
  const task=tasks[cursor++],key=`${task.split}-${task.seed}`,source=`${OUT}/groups/${key}.json`,destination=`${OUT}/rows/${key}.json`;
  if(!existsSync(source))continue;
  if(existsSync(destination)){if(read(destination).protocol_sha256!==protocolHash)throw new Error('Stale labels');}
  else await new Promise<void>((resolve,reject)=>{const p=spawn(process.execPath,['--import',`${ROOT}/web/tetris/node_modules/tsx/dist/loader.mjs`,import.meta.filename,'worker',source,destination,String(budget.data_deadline_ms),protocolHash],{stdio:['ignore','ignore','inherit']});p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error(`Label worker ${key}: ${code}`)));});
  if(++completed%16===0){atomic(`${OUT}/data-progress.json`,{stage:'label',done:completed,total:tasks.length,elapsed_seconds:(now()-budget.data_started_ms)/1000});console.log(`label ${completed}/${tasks.length}`);}
 }}));
 const files=readdirSync(`${OUT}/rows`).filter(p=>p.endsWith('.json')).sort(),manifest=[];
 let count=0;const splitCounts:Record<string,number>={};
 for(const file of files){const path=`${OUT}/rows/${file}`,bytes=readFileSync(path),v=JSON.parse(bytes.toString());if(v.protocol_sha256!==protocolHash)throw new Error('Mixed label versions');count+=v.rows.length;for(const r of v.rows)splitCounts[r.split]=(splitCounts[r.split]??0)+1;manifest.push({path:`rows/${file}`,sha256:sha(bytes),rows:v.rows.length,groups:v.groups,complete:v.complete});}
 atomic(`${OUT}/dataset-manifest.json`,{protocol_sha256:protocolHash,rows:count,split_counts:splitCounts,feature_names:featureNames(true),summary_feature_names:featureNames(false),sources:manifest,finished_ms:now(),data_seconds:(now()-budget.data_started_ms)/1000});
 console.log({rows:count,splitCounts,data_seconds:(now()-budget.data_started_ms)/1000});
}else if(mode!=='worker')throw new Error('Expected generate, extra, or worker');
