import {existsSync,readFileSync,mkdirSync} from 'node:fs';
import {ROOT,OUT,read,atomic,freeze,sha,hashes,now} from './v2-common';
import {NativeOracle} from './v2-oracle';
import {realOracle} from './v2-query';
import {Agent,episode,aggregate,type Spec,type Episode} from './v2-study-core';
import {validateBundle,type ValueBundle} from '../src/placement-value-v2';
process.chdir(ROOT);
const phase=process.argv[2],round=process.argv[3]||'initial';
if(!['screen','validate','test'].includes(phase))throw new Error('Expected screen, validate, or test');
const stage=phase==='test'?'test':`${phase}-${round}`;
const data=read(`${OUT}/data-protocol.json`),budget=read(`${OUT}/budget.json`);
const deadline=phase==='test'?Math.min(budget.overall_deadline_ms,now()+4*3600_000):budget.training_deadline_ms;
if(!deadline||now()>=deadline)throw new Error('Study budget exhausted');
const fixed:Spec={id:'fixed-jev',family:'fixed',mode:'jev'},v1:Spec={id:'v1-jev',family:'v1',mode:'jev'};
let specs:Spec[];
if(phase==='screen'){
 const trained=read(`${OUT}/training-${round}.json`);
 const browser=read(`${OUT}/browser-bench-${round}.json`);
 specs=[fixed,v1];
 for(const model of trained.models.filter((v:any)=>v.eligible&&browser.models.some((b:any)=>b.sha256===v.sha256&&b.eligible)))for(const alpha of [0,.25,.5,1])for(const beta of [0,10,40]){
  if(alpha===0&&beta===0)continue;
  specs.push({id:`${round}-${model.id}-a${String(alpha).replace('.','p')}-b${beta}-jev`,family:'v2',mode:'jev',bundle:`${OUT}/${model.path}`,bundle_sha256:model.sha256,alpha,beta});
 }
}else if(phase==='validate'){
 const shortlist=read<Spec[]>(`${OUT}/shortlist-${round}.json`);specs=[fixed,...shortlist];
 specs.push(...[...specs].map(s=>({...s,id:s.id.replace(/-jev$/,'-eval'),mode:'eval' as const})));
 if(round==='extra'){
  const prior=read<{spec:Spec}>(`${OUT}/selection-initial.json`).spec;
  specs.push({...prior,id:'prior-initial-jev'});specs.push({...prior,id:'prior-initial-eval',mode:'eval'});
 }
}else{
 const selected=read<{spec:Spec;validation_complete:boolean}>(`${OUT}/selection-final.json`);if(!selected.validation_complete)throw new Error('Authoritative validation incomplete');
 const chosen={...selected.spec,id:'v2-jev'};
 specs=[fixed,v1,chosen,...[fixed,v1,chosen].map(s=>({...s,id:s.id.replace(/-jev$/,'-eval'),mode:'eval' as const})),{...chosen,id:'v2-random',mode:'random'}];
}
for(const spec of specs)if(spec.family==='v2'){
 const bytes=readFileSync(spec.bundle!);if(sha(bytes)!==spec.bundle_sha256)throw new Error('Changed candidate');validateBundle(JSON.parse(bytes.toString()));
 if(bytes.length>8*1024*1024)throw new Error('Bundle exceeds 8 MiB');
}
const seeds=phase==='screen'?data.seeds.game_valid.slice(0,16):phase==='validate'?data.seeds.game_valid:data.seeds.test;
const sources=hashes(['web/tetris/src/placement-fast.ts','web/tetris/src/placement-value-v2.ts','web/tetris/src/placement-local.ts','web/tetris/src/placement-search.ts','web/tetris/src/placement-query-api.ts','web/tetris/scripts/v2-common.ts','web/tetris/scripts/v2-oracle.ts','web/tetris/scripts/v2-query.ts','web/tetris/scripts/v2-study-core.ts','web/tetris/scripts/v2-study.ts']);
const protocol={phase,round,stage,seeds,specs,source_hashes:sources,data_protocol_sha256:sha(JSON.stringify(data)),v1_sha256:sha(readFileSync(`${ROOT}/web/tetris/public/tetris-evaluator.json`)),checkpoint_sha256:data.checkpoint_sha256,model_digest:data.model_digest,cap:512,snapshot:128,selection:'Jev mean lines, mean pieces, 128 lines, model bytes, ID; evaluator point estimate >=95% fixed baseline for validation eligibility'};
const directory=`${OUT}/episodes/${stage}`;mkdirSync(directory,{recursive:true});freeze(`${OUT}/${stage}-protocol.json`,protocol);const protocolHash=sha(JSON.stringify(protocol));
const native=phase==='screen'?new NativeOracle():null,real=phase==='screen'?null:await realOracle();
const oracle=native?{choose:(r:Parameters<NativeOracle['choose']>[0])=>native.choose(r),close:()=>native.close()}:real!;
const agents=new Map(specs.map(s=>[s.id,new Agent(s)]));
const jobs=seeds.flatMap((seed:number)=>specs.map(spec=>({seed,spec}))),results:{episode:Episode;path:string;sha256:string}[]=[];let cursor=0,stopped=false;
function summarize(){
 const episodes=results.map(r=>r.episode),metrics=aggregate(episodes),complete=results.length===jobs.length;
 const stats=real?.stats;
 atomic(`${OUT}/${stage}-summary.json`,{complete,authoritative:!native,protocol_sha256:protocolHash,query_error_free:!existsSync(`${directory}/failure.json`),budget_stopped:stopped,
  actual_calls:stats?.actual??native?.actual??0,cache_hits:stats?.cached??native?.cached??0,max_tokens:stats?.max_tokens??Math.max(0,...episodes.map(r=>r.max_tokens)),max_instructions:stats?.max_instructions.toString()??'0',metrics,
  games:episodes.map(({trace,...r})=>r),sources:results.map(({path,sha256})=>({path,sha256}))});
 return {metrics,complete};
}
try{
 await Promise.all(Array.from({length:4},async()=>{while(cursor<jobs.length){
  if(now()>=deadline){stopped=true;break;}
  const {seed,spec}=jobs[cursor++],path=`${directory}/${seed}-${spec.id}.json`;
  let result:Episode;
  if(existsSync(path)){const saved=read(path);if(saved.protocol_sha256!==protocolHash)throw new Error('Episode lineage changed');result=saved.episode;}
  else{result=await episode(seed,agents.get(spec.id)!,r=>oracle.choose(r),true);atomic(path,{protocol_sha256:protocolHash,episode:result});}
  results.push({episode:{...result,trace:[]},path:`episodes/${stage}/${seed}-${spec.id}.json`,sha256:sha(readFileSync(path))});
  results.sort((a,b)=>a.episode.seed-b.episode.seed||a.episode.spec.localeCompare(b.episode.spec));
  const {metrics,complete}=summarize();console.log(`${stage} ${results.length}/${jobs.length} ${spec.id} seed=${seed}: ${result.lines} lines/${result.pieces} pieces`);
  if(complete&&phase==='screen'){
   const ids=metrics.filter(m=>specs.find(s=>s.id===m.id)!.family==='v2').slice(0,3).map(m=>specs.find(s=>s.id===m.id)!);atomic(`${OUT}/shortlist-${round}.json`,ids);
  }
  if(complete&&phase==='validate'){
   const base=metrics.find(m=>m.id==='fixed-eval')!;
   const candidates=metrics.filter(m=>m.id.endsWith('-jev')&&specs.find(s=>s.id===m.id)?.family==='v2');
   const eligible=candidates.filter(m=>{const control=metrics.find(v=>v.id===m.id.replace(/-jev$/,'-eval'));return control&&control.mean_lines>=.95*base.mean_lines;});
   const best=(eligible.length?eligible:candidates)[0];if(!best)throw new Error('No completed v2 validation candidate');
   const spec=specs.find(s=>s.id===best.id)!;
   atomic(`${OUT}/selection-${round}.json`,{spec,validation_complete:true,validation_eligible:eligible.length>0,metric:best,protocol_sha256:protocolHash,stage});
  }
 }}));
 const result=summarize();if(!result.complete)throw new Error('Study did not finish within its budget');
}catch(error){atomic(`${directory}/failure.json`,{error:String(error),completed:results.length});summarize();throw error;}finally{oracle.close();}
