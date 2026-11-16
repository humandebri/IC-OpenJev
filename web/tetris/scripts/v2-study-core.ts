import {readFileSync} from 'node:fs';
import {fastChoices,hashBoard,sameBoard,expand,masks,pieceStream,type MaskBoard,type FastChoice} from '../src/placement-fast';
import {shapes,landed} from '../src/placement-local';
import {predictValue,topTwo,costRequest,validateBundle,type ValueBundle} from '../src/placement-value-v2';
import {loadEvaluator} from './placement-study-core';
import {ROOT,sha,derive,random} from './v2-common';
import type {OracleReply,Request} from './v2-oracle';
export type Spec={id:string;family:'fixed'|'v1'|'v2';mode:'jev'|'eval'|'random';bundle?:string;bundle_sha256?:string;alpha?:number;beta?:number};
type Shared={bundle:ValueBundle;cache:Map<number,{board:MaskBoard;residual:number;risk:number}[]>;size:number};
const SHARED=new Map<string,Shared>();
export class Agent {
 bundle?:ValueBundle;private old?:ReturnType<typeof loadEvaluator>;
 private shared?:Shared;
 constructor(public spec:Spec){
  if(spec.family==='v2'){
   let shared=SHARED.get(spec.bundle_sha256!);
   if(!shared){const bytes=readFileSync(spec.bundle!);if(sha(bytes)!==spec.bundle_sha256)throw new Error('Changed model bundle');const bundle=JSON.parse(bytes.toString()) as ValueBundle;validateBundle(bundle);shared={bundle,cache:new Map(),size:0};SHARED.set(spec.bundle_sha256!,shared);}
   this.shared=shared;this.bundle=shared.bundle;
  }else if(spec.family==='v1')this.old=loadEvaluator(`${ROOT}/web/tetris/public/tetris-evaluator.json`);
 }
 predict(board:MaskBoard):{residual:number;risk:number}{
  const key=hashBoard(board),bucket=this.shared!.cache.get(key),saved=bucket?.find(v=>sameBoard(v.board,board));if(saved)return {residual:saved.residual,risk:saved.risk};
  const p=predictValue(this.bundle!,board);
  if(this.shared!.size>=20000){this.shared!.cache.clear();this.shared!.size=0;}
  const list=this.shared!.cache.get(key)??[];list.push({board:new Uint16Array(board),...p});this.shared!.cache.set(key,list);this.shared!.size++;return p;
 }
 prepare(board:MaskBoard,piece:number,next:number){
  const all=fastChoices(board,piece,next).map(c=>{
   if(this.spec.family==='v1')return {...c,score:10*(c.lines+this.old!.predict(expand(c.board),next)),residual:0,risk:0};
   if(this.spec.family!=='v2'||!c.next)return {...c,residual:0,risk:c.safe?0:1};
   const p=this.predict(c.next.board);return {...c,residual:p.residual,risk:p.risk,score:c.score+this.spec.alpha!*p.residual-this.spec.beta!*p.risk};
  });
  if(all.some(c=>!Number.isFinite(c.score)))throw new Error('Non-finite policy value');
  const offered=topTwo(all),recommended=offered.reduce((a,c,i)=>c.score>offered[a].score?i:a,0);
  return {all,offered,recommended,request:costRequest(offered)};
 }
}
export type Episode=Awaited<ReturnType<typeof episode>>;
export async function episode(seed:number,agent:Agent,choose:(r:Request)=>Promise<OracleReply>,record=true){
 const spec=agent.spec,stream=pieceStream(seed,513),rng=random(derive('control-random',seed));
 let board:MaskBoard=new Uint16Array(20),lines=0,pieces=0,ended=false,lines128=0,pieces128=0,disagreements=0,strictRegret=0,maxTokens=0,maxInstructions=0n,candidateTotal=0;const timings:number[]=[],trace:unknown[]=[];
 for(let turn=0;turn<512;turn++){
  if(turn%8===0)await new Promise<void>(resolve=>setImmediate(resolve));
  const begin=performance.now(),prepared=agent.prepare(board,stream[turn],stream[turn+1]);timings.push(performance.now()-begin);
  if(!prepared.offered.length){ended=true;break;}
  let selected=prepared.recommended,reply:OracleReply|null=null;
  if(spec.mode==='jev'){
   reply=await choose(prepared.request);selected=reply.selected;
   if(!Number.isInteger(selected)||selected<0||selected>=prepared.offered.length)throw new Error('Invalid selection');
   maxTokens=Math.max(maxTokens,reply.tokens);maxInstructions=BigInt(reply.instructions)>maxInstructions?BigInt(reply.instructions):maxInstructions;
  }else if(spec.mode==='random')selected=Math.floor(rng()*prepared.offered.length);
  const c=prepared.offered[selected];
  // Original colored-board transition is a per-turn guard, independent of the cache/scorer.
  const expected=landed(expand(board),stream[turn],shapes(stream[turn])[c.r].map(([x,y]):[number,number]=>[x+c.x,y+c.y]));
  if(expected.lines!==c.lines||!sameBoard(masks(expected.board),c.board))throw new Error('Current landing was changed by evaluation');
  if(selected!==prepared.recommended)disagreements++;strictRegret+=prepared.offered[prepared.recommended].score-c.score;candidateTotal+=prepared.offered.length;
  if(record)trace.push({turn,piece:stream[turn],next:stream[turn+1],before:Array.from(board),candidates:prepared.offered.map(v=>({key:v.key,r:v.r,x:v.x,y:v.y,lines:v.lines,holes:v.holes,height:v.height,total_lines:v.total_lines,base:v.base,score:v.score,residual:v.residual,risk:v.risk,safe:v.safe,after:Array.from(v.board),terminal:v.next?Array.from(v.next.board):null,next_pose:v.next?{r:v.next.r,x:v.next.x,y:v.next.y}:null,next_lines:v.next?.lines??0})),recommended:prepared.recommended,selected,request:spec.mode==='jev'?prepared.request:null,reply,after:Array.from(c.board)});
  board=c.board;lines+=c.lines;pieces++;
  if(pieces<=128){lines128=lines;pieces128=pieces;}
  if(!c.safe){ended=true;break;}
 }
 const sorted=timings.sort((a,b)=>a-b);
 return {seed,spec:spec.id,family:spec.family,mode:spec.mode,lines,pieces,lines128,pieces128,ended,early32:pieces<32,early128:pieces<128,capped:pieces===512,disagreements,score_regret:strictRegret,mean_options:candidateTotal/Math.max(1,pieces),mean_candidate_ms:timings.reduce((a,b)=>a+b,0)/Math.max(1,timings.length),p95_candidate_ms:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]??0,max_tokens:maxTokens,max_instructions:maxInstructions.toString(),trace};
}
export function aggregate(rows:Episode[]){
 const ids=[...new Set(rows.map(r=>r.spec))];return ids.map(id=>{
  const list=rows.filter(r=>r.spec===id),mean=(f:(r:Episode)=>number)=>list.reduce((s,r)=>s+f(r),0)/list.length;
  const median=(f:(r:Episode)=>number)=>{const s=list.map(f).sort((a,b)=>a-b),n=s.length;return (s[Math.floor((n-1)/2)]+s[Math.floor(n/2)])/2;};
  return {id,games:list.length,mean_lines:mean(r=>r.lines),median_lines:median(r=>r.lines),mean_pieces:mean(r=>r.pieces),median_pieces:median(r=>r.pieces),mean_lines128:mean(r=>r.lines128),median_lines128:median(r=>r.lines128),mean_pieces128:mean(r=>r.pieces128),early32_rate:mean(r=>Number(r.early32)),early128_rate:mean(r=>Number(r.early128)),cap_rate:mean(r=>Number(r.capped)),mean_candidate_ms:mean(r=>r.mean_candidate_ms),max_p95_candidate_ms:Math.max(...list.map(r=>r.p95_candidate_ms)),disagreements:list.reduce((s,r)=>s+r.disagreements,0),regret:list.reduce((s,r)=>s+r.score_regret,0),mean_options:mean(r=>r.mean_options)};
 }).sort((a,b)=>b.mean_lines-a.mean_lines||b.mean_pieces-a.mean_pieces||b.mean_lines128-a.mean_lines128||a.id.localeCompare(b.id));
}
