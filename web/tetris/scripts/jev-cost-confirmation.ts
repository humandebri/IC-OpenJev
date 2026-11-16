// Frozen second confirmation runner; round-one source and evidence remain unchanged.
import {fileURLToPath} from 'node:url';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {CONFIGS,prepare,type Config} from './jev-policy';
import {landed,pieceAt,placements,decisionRequest} from '../src/placement-local';
import {searchPlacements,searchRecommendation} from '../src/placement-search';
import {hash,loadEvaluator,rng} from './placement-study-core';
import {connectQuery,validateReply,type ModelReply} from '../src/placement-query-api';
process.chdir(fileURLToPath(new URL('../../../',import.meta.url)));
const out=process.env.TETRIS_JEV_CONFIRM_DIR||'artifacts/tetris-jev-confirmation';mkdirSync(out,{recursive:true});
const phase=process.argv[2]||'test';if(phase!=='test')throw new Error('Confirmation only accepts test');
const evaluator=loadEvaluator('web/tetris/public/tetris-evaluator.json');
const sourcePaths=['web/tetris/scripts/jev-policy.ts','web/tetris/scripts/jev-cost-confirmation.ts','web/tetris/src/placement-local.ts','web/tetris/src/placement-search.ts','web/tetris/src/placement-query-api.ts'];
const sources=Object.fromEntries(sourcePaths.map(p=>[p,hash(readFileSync(p))]));
const protocol={parent_development_protocol_sha256:hash(readFileSync('artifacts/tetris-jev-search/protocol.json')),primary_config:'top2-cost',secondary_config:'top2',purpose:'Independent confirmation of the two fixed development finalists; no new prompt or candidate tuning',configs:CONFIGS,development_seeds:Array.from({length:8},(_,i)=>20001+i),validation_seeds:Array.from({length:8},(_,i)=>20017+i),test_seeds:Array.from({length:32},(_,i)=>50001+i),model_digest:'0757d774c8c44397d189c5b479853897acef8f1e2b55ebf1f5a46969063225e0',checkpoint_sha256:hash(readFileSync('models/verdict-pack/model.bin')),tokenizer_sha256:hash(readFileSync('models/verdict-151m/tokenizer.json')),probe_sha256:hash(readFileSync('target/release/tetris_probe')),evaluator_hash:evaluator.hash,max_tokens:41,max_turns:128,min_offered_when_possible:2,selection:'best non-reference by mean lines, mean pieces, lower mean tokens, config ID; no held-out tuning',sources};
const protocolText=JSON.stringify(protocol,null,2)+'\n';
if(existsSync(`${out}/protocol.json`)&&readFileSync(`${out}/protocol.json`,'utf8')!==protocolText)throw new Error('Frozen protocol changed');
writeFileSync(`${out}/protocol.json`,protocolText);
type Answer={selected:number;tokens:number;instructions:string;cached:boolean};
type Request=ReturnType<typeof decisionRequest>;
let answer:(r:Request)=>Promise<Answer>,close=()=>{},queryCount=0,cacheCount=0;
const tokens=new Map<string,number>();
if(phase!=='test'){
 const p=spawn('target/release/tetris_probe',['.'],{stdio:['pipe','pipe','inherit']});
 const queue:{resolve:(line:string)=>void;reject:(e:Error)=>void}[]=[];let failed:Error|undefined;
 const fail=(e:Error)=>{failed=e;for(const item of queue.splice(0))item.reject(e);};
 p.on('error',fail);p.on('exit',code=>{if(code)fail(new Error(`Probe exited ${code}`));});
 createInterface({input:p.stdout}).on('line',line=>{const item=queue.shift();if(item)item.resolve(line);});
 const cache=new Map<string,Promise<Answer>>();
 const request=(r:Request,infer:boolean)=>new Promise<string>((resolve,reject)=>{if(failed){reject(failed);return;}queue.push({resolve,reject});p.stdin.write(JSON.stringify({text:r.state,labels:r.options.map(o=>o.text),infer})+'\n');});
 answer=async r=>{
  const key=JSON.stringify(r);if(cache.has(key)){cacheCount++;return {...await cache.get(key)!,cached:true};}
  const pending=request(r,true).then(line=>{const v=JSON.parse(line);if(v.tokens>41)throw new Error('Token budget exceeded');queryCount++;return {selected:v.selected,tokens:v.tokens,instructions:'0',cached:false};});cache.set(key,pending);return pending;
 };
 close=()=>{p.stdin.end();};
 // Domain witnesses for relative, scalar-cost, and two-candidate numeric formats.
 if(phase==='screen'){
  const witnesses:Request[]=[];
  for(let n=1;n<=4;n++)for(const h of [0,200])for(const height of [0,20])for(const missed of [0,8]){
   witnesses.push({question:'',state:'Min holes',abstention:false,temperature:1,options:Array.from({length:n},(_,i)=>({id:String(i),text:`equal holes,equal height,equal missed`}))});
   witnesses.push({question:'',state:'Min cost',abstention:false,temperature:1,options:Array.from({length:n},(_,i)=>({id:String(i),text:`cost ${8*200+20+80}`}))});
   if(n<=2)witnesses.push({question:'',state:'Min holes',abstention:false,temperature:1,options:Array.from({length:n},(_,i)=>({id:String(i),text:`holes${h} height${height} missed${missed}`}))});
  }
  let max=0;for(const w of witnesses){const v=JSON.parse(await request(w,false));max=Math.max(max,v.tokens);}
  writeFileSync(`${out}/token-witnesses.json`,JSON.stringify({witnesses:witnesses.length,max_tokens:max,relative_prior_exhaustive_check:'artifacts/tetris-search/token-check.json',note:'New numeric domains additionally checked per actual request; witness scan alone is not an exhaustive bound.'},null,2)+'\n');
  if(max>41)throw new Error(`Witness exceeds budget: ${max}`);
 }
}else{
 const target=JSON.parse(readFileSync('artifacts/tetris-search/local-target.json','utf8'));
 const c=await connectQuery(target.host,target.canister),status=await c.status();
 if(Buffer.from(status.model).toString('hex')!==protocol.model_digest||!status.enabled)throw new Error('Frozen model unavailable');
 mkdirSync(`${out}/query-cache`,{recursive:true});
 writeFileSync(`${out}/test-target.json`,JSON.stringify(target,null,2)+'\n');
 const cache=new Map<string,Promise<Answer>>();
 const nativeFetch=globalThis.fetch;globalThis.fetch=(...args)=>{if(/\/call(?:\?|$)/.test(String(args[0])))throw new Error('Updates forbidden');return nativeFetch(...args);};
 answer=async r=>{
  const key=hash(JSON.stringify({request:r,model:protocol.model_digest,target}));
  if(cache.has(key)){cacheCount++;return {...await cache.get(key)!,cached:true};}
  const pending=(async()=>{
   const path=`${out}/query-cache/${key}.json`,saved=existsSync(path);
   const reply:ModelReply=saved?JSON.parse(readFileSync(path,'utf8'),(k,v)=>k==='measured_instructions'?BigInt(v):v):await c.query(r);
   const selected=validateReply(reply,r,status);if(reply.input_tokens>41)throw new Error('Token budget exceeded');
   if(!saved){writeFileSync(path,JSON.stringify({...reply,model:Array.from(reply.model)},(_,v)=>typeof v==='bigint'?v.toString():v)+'\n');queryCount++;}else cacheCount++;
   return {selected,tokens:reply.input_tokens,instructions:reply.measured_instructions.toString(),cached:saved};
  })();cache.set(key,pending);return pending;
 };
}
type Result=Awaited<ReturnType<typeof game>>;
async function game(seed:number,config:Config,policy:'model'|'evaluator'|'random'|'full'='model'){
 let board=Array(200).fill(0),lines=0,turn=0,disagreements=0,first=0,multiple=0,differentLabels=0,totalTokens=0,maxTokens=0,maxInstructions=0n,totalOptions=0;
 const random=rng(seed),trace=[];
 for(;turn<128;turn++){
  const piece=pieceAt(seed,turn),next=pieceAt(seed,turn+1);if(!placements(board,piece).length)break;
  const offered=prepare(board,piece,next,config,evaluator);let {options,recommended}=offered,selected=recommended,reply:Answer|undefined;
  if(policy==='full'){options=searchPlacements(board,piece,next);recommended=searchRecommendation(options);selected=recommended;}
  else if(policy==='model'){
   reply=await answer(offered.request);selected=reply.selected;if(selected!==recommended)disagreements++;
   totalTokens+=reply.tokens;maxTokens=Math.max(maxTokens,reply.tokens);maxInstructions=BigInt(reply.instructions)>maxInstructions?BigInt(reply.instructions):maxInstructions;
  }else if(policy==='random')selected=Math.floor(random()*options.length);
  if(selected===0)first++;if(options.length>1)multiple++;
  if(new Set(offered.request.options.map(o=>o.text)).size>1)differentLabels++;
  totalOptions+=options.length;
  const after=landed(board,piece,options[selected].cells);
  trace.push({turn,before:board,piece,next,options,recommended,selected,request:policy==='model'?offered.request:null,reply:reply??null,after:after.board});
  board=after.board;lines+=after.lines;
 }
 return {seed,config:config.id,policy,lines,pieces:turn,early:turn<32,capped:turn===128,disagreements,first,multiple,different_labels:differentLabels,mean_options:totalOptions/Math.max(1,turn),mean_tokens:totalTokens/Math.max(1,turn),max_tokens:maxTokens,max_instructions:maxInstructions.toString(),trace};
}
function aggregate(rows:Result[]){
 const keys=[...new Set(rows.map(g=>`${g.config}/${g.policy}`))];
 return keys.map(key=>{
  const games=rows.filter(g=>`${g.config}/${g.policy}`===key),mean=(f:(g:Result)=>number)=>games.reduce((s,g)=>s+f(g),0)/games.length;
  return {key,config:games[0].config,policy:games[0].policy,games:games.length,mean_lines:mean(g=>g.lines),mean_pieces:mean(g=>g.pieces),early_rate:mean(g=>Number(g.early)),cap_rate:mean(g=>Number(g.capped)),mean_tokens:mean(g=>g.mean_tokens),mean_options:mean(g=>g.mean_options),first_rate:games.reduce((s,g)=>s+g.first,0)/games.reduce((s,g)=>s+g.pieces,0),disagreements:games.reduce((s,g)=>s+g.disagreements,0),multiple_turns:games.reduce((s,g)=>s+g.multiple,0),different_label_turns:games.reduce((s,g)=>s+g.different_labels,0)};
 }).sort((a,b)=>b.mean_lines-a.mean_lines||b.mean_pieces-a.mean_pieces||a.mean_tokens-b.mean_tokens||a.config.localeCompare(b.config));
}
const configs=[CONFIGS[0],CONFIGS.find(c=>c.id==='top2')!,CONFIGS.find(c=>c.id==='top2-cost')!];
const seeds=protocol.test_seeds;
const jobs=seeds.flatMap(seed=>configs.flatMap((config:Config)=>[{seed,config,policy:'model' as const},...(phase==='test'&&config.id==='top2-cost'?(['evaluator','random','full'] as const).map(policy=>({seed,config,policy})):[])]));
const rows:Result[]=[];let cursor=0;mkdirSync(`${out}/${phase}`,{recursive:true});
try{
 await Promise.all(Array.from({length:4},async()=>{while(cursor<jobs.length){
  const j=jobs[cursor++],path=`${out}/${phase}/${j.seed}-${j.config.id}-${j.policy}.json`;
  const r:Result=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):await game(j.seed,j.config,j.policy);
  if(!existsSync(path))writeFileSync(path,JSON.stringify(r)+'\n');rows.push(r);
  rows.sort((a,b)=>a.seed-b.seed||a.config.localeCompare(b.config)||a.policy.localeCompare(b.policy));
  const summary=aggregate(rows),complete=rows.length===jobs.length;
  writeFileSync(`${out}/${phase}-summary.json`,JSON.stringify({complete,authoritative:phase==='test',protocol_sha256:hash(protocolText),actual_calls:queryCount,cache_hits:cacheCount,summary,games:rows.map(({trace,...v})=>v),sources:rows.map(v=>({path:`${phase}/${v.seed}-${v.config}-${v.policy}.json`,sha256:hash(readFileSync(`${out}/${phase}/${v.seed}-${v.config}-${v.policy}.json`))}))},null,2)+'\n');
  console.log(`${phase} ${rows.length}/${jobs.length} ${r.config}/${r.policy} seed=${r.seed}: ${r.lines} lines/${r.pieces} pieces`);
 }}));
}catch(error){writeFileSync(`${out}/${phase}/failure.json`,JSON.stringify({error:String(error),completed:rows.length},null,2)+'\n');throw error;}finally{close();}
