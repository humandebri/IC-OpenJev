import {fastChoices,bestChoice,Teacher,pieceStream,POP,type MaskBoard,type FastChoice} from '../src/placement-fast';
import {valueFeatures,topTwo,costRequest,v2Score,type ValueBundle} from '../src/placement-value-v2';
import type {NativeOracle} from './v2-oracle';
import {derive,random} from './v2-common';
export type State={board:number[];piece:number;next:number;turn:number};
export type Group=State&{seed:number;split:string;behavior:string;candidates:{key:number;r:number;x:number;y:number;board:number[];terminal:number[];immediate_lines:number;next_lines:number;base:number}[];rollout_seeds:number[]};
function sampleStates(states:State[],seed:number){
 const rng=random(derive('states',seed)),selected=new Set<number>();
 const buckets=Array.from({length:4},()=>[] as number[]);
 states.forEach((s,i)=>{let height=0;for(let y=0;y<20;y++)if(s.board[y]){height=20-y;break;}buckets[Math.min(3,Math.floor(Math.max(0,height-1)/5))].push(i);});
 for(const bucket of buckets)for(let k=0;k<2&&bucket.length;k++)selected.add(bucket.splice(Math.floor(rng()*bucket.length),1)[0]);
 const remaining=states.map((_,i)=>i).filter(i=>!selected.has(i));while(selected.size<Math.min(8,states.length))selected.add(remaining.splice(Math.floor(rng()*remaining.length),1)[0]);
 return [...selected].sort((a,b)=>a-b).map(i=>states[i]);
}
function candidateSample(all:FastChoice[],seed:number,turn:number){
 const ranked=[...all].sort((a,b)=>b.score-a.score||a.key-b.key),selected=ranked.slice(0,4),rng=random(derive('candidates',seed,turn));
 const add=(c:FastChoice|undefined)=>{if(c&&!selected.includes(c)&&selected.length<8)selected.push(c);};
 add(all.reduce<FastChoice|undefined>((a,b)=>!a||b.lines>a.lines?b:a,undefined));
 const rest=()=>all.filter(c=>!selected.includes(c));
 let farthest:FastChoice|undefined,distance=-1;
 for(const c of rest()){
  const d=Math.min(...selected.map(s=>c.board.reduce((n,row,y)=>n+POP[row^s.board[y]],0)));
  if(d>distance){distance=d;farthest=c;}
 }add(farthest);
 const remaining=rest();while(selected.length<8&&remaining.length)add(remaining.splice(Math.floor(rng()*remaining.length),1)[0]);
 return selected.sort((a,b)=>a.key-b.key);
}
export async function collect(seed:number,split:string,index:number,oracle:NativeOracle,bundle?:ValueBundle):Promise<Group[]>{
 const mix=index%4,behavior=bundle?'v2-jev':mix<2?'fixed':mix===2?'fixed-jev':'explore',stream=pieceStream(seed,513),rng=random(derive('behavior',seed));
 let board:MaskBoard=new Uint16Array(20);const visited:State[]=[];
 for(let turn=0;turn<512;turn++){
  let all=fastChoices(board,stream[turn],stream[turn+1]);if(!all.length)break;
  visited.push({board:Array.from(board),piece:stream[turn],next:stream[turn+1],turn});
  let chosen:FastChoice;
  if(bundle){all=all.map(c=>v2Score(c,bundle));const offered=topTwo(all);chosen=offered[(await oracle.choose(costRequest(offered))).selected];}
  else if(behavior==='fixed-jev'){const offered=topTwo(all);chosen=offered[(await oracle.choose(costRequest(offered))).selected];}
  else if(behavior==='explore'){const offered=[...all].sort((a,b)=>b.score-a.score||a.key-b.key).slice(0,4);chosen=rng()<.1?offered[Math.floor(rng()*offered.length)]:offered[0];}
  else chosen=bestChoice(all)!;
  board=chosen.board;if(!chosen.safe)break;
 }
 return sampleStates(visited,seed).flatMap(state=>{
  const all=fastChoices(Uint16Array.from(state.board),state.piece,state.next).filter(c=>c.safe);
  if(!all.length)return [];
  const candidates=candidateSample(all,seed,state.turn).map(c=>({key:c.key,r:c.r,x:c.x,y:c.y,board:Array.from(c.board),terminal:Array.from(c.next!.board),immediate_lines:c.lines,next_lines:c.next!.lines,base:c.base}));
  return [{...state,seed,split,behavior,candidates,rollout_seeds:Array.from({length:8},(_,r)=>derive('future',split,seed,state.turn,r))}];
 });
}
export function labelGroup(group:Group,teacher:Teacher){
 return group.candidates.map(c=>{
  const outcomes=group.rollout_seeds.map(seed=>{
   let board:MaskBoard=Uint16Array.from(c.terminal),lines=0,survived=0,ended=false;const stream=pieceStream(seed,33);
   for(let i=0;i<32;i++){
    const action=teacher.choose(board,stream[i],stream[i+1]);if(!action){ended=true;break;}
    board=action.board;lines+=action.lines;survived++;if(!action.safe){ended=true;break;}
   }
   return {seed,lines,survived,ended};
  });
  const mean=outcomes.reduce((s,o)=>s+o.lines,0)/8,risk=outcomes.filter(o=>o.ended).length/8;
  return {seed:group.seed,split:group.split,turn:group.turn,behavior:group.behavior,key:c.key,piece:group.piece,next:group.next,before:group.board,after:c.board,terminal:c.terminal,immediate_lines:c.immediate_lines,next_lines:c.next_lines,base:c.base,features:valueFeatures(Uint16Array.from(c.terminal)),residual_target:10*mean-c.base,risk_target:risk,future_lines:mean,survival:outcomes.reduce((s,o)=>s+o.survived,0)/8,outcomes};
 });
}
