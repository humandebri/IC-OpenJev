// Shared deterministic placement study. No realtime control/gravity imports.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {landed,pieceAt,placements,prepareTurn,recommend,MAX_TURNS} from '../src/placement-local';
import {boardFeatures,createEvaluator,improvedCandidates,searchPlacements,searchRecommendation,type Evaluator,type SearchCandidate,type TreeModel} from '../src/placement-search';
export const TRAIN_SEEDS=Array.from({length:256},(_,i)=>10001+i);
export const VALID_SEEDS=Array.from({length:64},(_,i)=>20001+i);
export const TEST_SEEDS=Array.from({length:32},(_,i)=>30001+i);
export const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export const rng=(seed:number)=>()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
export function loadEvaluator(path:string):Evaluator{
 const bytes=readFileSync(path);return createEvaluator(JSON.parse(bytes.toString()) as TreeModel,hash(bytes));
}
export const freshGame=(seed:number)=>({id:0,seed,mode:1,board:Array(200).fill(0) as number[],turn:0,lines:0,over:false});
export function rollout(board:number[],next:number,simulationSeed:number){
 let current=board,lines=0,pieces=0;
 for(let turn=0;turn<16;turn++){
  // Only NEXT is shared with the real game; suffix is an independent seven-bag.
  const piece=turn===0?next:pieceAt(simulationSeed,turn-1),upcoming=pieceAt(simulationSeed,turn);
  const options=searchPlacements(current,piece,upcoming);
  if(!options.length)break;
  const chosen=options[searchRecommendation(options)],after=landed(current,piece,chosen.cells);
  current=after.board;lines+=after.lines;pieces++;
 }
 return {lines,pieces};
}
export function trainingRows(seed:number){
 const random=rng(seed),states:{board:number[];piece:number;next:number;turn:number}[]=[];
 let game=freshGame(seed);
 const behavior=(seed-10001)%3;
 while(game.turn<MAX_TURNS){
  const piece=pieceAt(seed,game.turn),next=pieceAt(seed,game.turn+1),all=placements(game.board,piece);
  if(!all.length)break;
  states.push({board:game.board,piece,next,turn:game.turn});
  let c;
  if(behavior===0)c=all[recommend(all)];
  else if(behavior===1){const offered=improvedCandidates(searchPlacements(game.board,piece,next,all));c=offered[searchRecommendation(offered)];}
  else c=all[Math.floor(random()*all.length)];
  const after=landed(game.board,piece,c.cells);game={...game,board:after.board,turn:game.turn+1,lines:game.lines+after.lines};
 }
 const sampled=Array.from(new Set(Array.from({length:Math.min(4,states.length)},(_,i)=>Math.floor((i+.5)*states.length/Math.min(4,states.length)))));
 return sampled.flatMap(index=>{
  const state=states[index],all=searchPlacements(state.board,state.piece,state.next),chosen=improvedCandidates(all);
  const rest=all.filter(c=>!chosen.includes(c));
  while(chosen.length<8&&rest.length)chosen.push(rest.splice(Math.floor(random()*rest.length),1)[0]);
  return chosen.map((c,option)=>{
   const after=landed(state.board,state.piece,c.cells).board;
   // Common random suffixes across alternatives remove avoidable label noise.
   const outcomes=Array.from({length:4},(_,r)=>rollout(after,state.next,(seed*2654435761+state.turn*97+r*104729)>>>0));
   return {seed,turn:state.turn,behavior,option,features:boardFeatures(after,state.next),target:outcomes.reduce((s,o)=>s+o.lines,0)/4,survival:outcomes.reduce((s,o)=>s+o.pieces,0)/4};
  });
 });
}
export type StudyPolicy='legacy-model'|'lookahead-model'|'lookahead-only'|'learned-model'|'learned-only'|'full-search';
export const POLICIES:StudyPolicy[]=['legacy-model','lookahead-model','lookahead-only','learned-model','learned-only','full-search'];
export type Answer={selected:number;tokens:number;instructions:string;cached:boolean};
export type Decide=(request:ReturnType<typeof prepareTurn>['request'])=>Promise<Answer>;
export async function studyGame(seed:number,policy:StudyPolicy,evaluator:Evaluator,decide:Decide){
 let game=freshGame(seed),disagreements=0,regret=0,candidateMs=0,queries=0,counterfactualCount=0,counterfactualGain=0,maxTokens=0,maxInstructions=0n;
 const trace:unknown[]=[];
 while(game.turn<MAX_TURNS){
  if(!placements(game.board,pieceAt(seed,game.turn)).length)break;
  const began=performance.now(),strategy=policy.startsWith('legacy')?'legacy':policy.startsWith('learned')?'learned':'lookahead';
  const turn=prepareTurn({...game,policy:strategy},evaluator);
  candidateMs+=performance.now()-began;
  let options=turn.candidates,recommended=turn.recommended,selected=recommended,answer:Answer|undefined;
  if(policy==='full-search'){options=searchPlacements(game.board,turn.piece,turn.next);recommended=searchRecommendation(options);selected=recommended;}
  if(policy.endsWith('-model')){
   answer=await decide(turn.request);selected=answer.selected;queries++;maxTokens=Math.max(maxTokens,answer.tokens);maxInstructions=BigInt(answer.instructions)>maxInstructions?BigInt(answer.instructions):maxInstructions;
   if(selected!==recommended){
    disagreements++;
    if(counterfactualCount<4){
     const simulate=(index:number)=>Array.from({length:4},(_,r)=>rollout(landed(game.board,turn.piece,options[index].cells).board,turn.next,(seed*2246822519+game.turn*97+r*104729)>>>0).lines).reduce((a,b)=>a+b,0)/4+options[index].lines;
     counterfactualGain+=simulate(selected)-simulate(recommended);counterfactualCount++;
    }
   }
   const score=(c:typeof options[number])=>'search' in c?(c as SearchCandidate).search.score:c.evaluation;
   regret+=score(options[recommended])-score(options[selected]);
  }
  const after=landed(game.board,turn.piece,options[selected].cells);
  trace.push({turn:game.turn,before:game.board,piece:turn.piece,next:turn.next,options,recommended,selected,request:policy.endsWith('-model')?turn.request:null,answer,after:after.board});
  game={...game,turn:game.turn+1,board:after.board,lines:game.lines+after.lines};
 }
 return {seed,policy,lines:game.lines,pieces:game.turn,early:game.turn<32,capped:game.turn===MAX_TURNS,disagreements,regret,counterfactual_count:counterfactualCount,counterfactual_line_gain:counterfactualGain,candidate_ms:candidateMs/Math.max(1,game.turn),queries,max_tokens:maxTokens,max_instructions:maxInstructions.toString(),trace};
}
export function summarize(games:Awaited<ReturnType<typeof studyGame>>[]){
 return Object.fromEntries(POLICIES.map(policy=>{
  const rows=games.filter(g=>g.policy===policy),mean=(f:(g:typeof rows[number])=>number)=>rows.reduce((s,g)=>s+f(g),0)/rows.length;
  const sorted=rows.map(g=>g.lines).sort((a,b)=>a-b),n=sorted.length;
  return [policy,{games:n,mean_lines:mean(g=>g.lines),median_lines:n?(sorted[Math.floor((n-1)/2)]+sorted[Math.floor(n/2)])/2:0,mean_pieces:mean(g=>g.pieces),early_rate:mean(g=>Number(g.early)),cap_rate:mean(g=>Number(g.capped)),mean_candidate_ms:mean(g=>g.candidate_ms),disagreements:rows.reduce((s,g)=>s+g.disagreements,0),regret:rows.reduce((s,g)=>s+g.regret,0),counterfactual_line_gain:rows.reduce((s,g)=>s+g.counterfactual_line_gain,0),counterfactual_count:rows.reduce((s,g)=>s+g.counterfactual_count,0)}];
 }));
}
export function adoption(summary:ReturnType<typeof summarize>,verified:boolean){
 const improves=(a:string,b:string,factor:number)=>summary[a].games===32&&summary[b].games===32&&summary[a].mean_lines>=summary[b].mean_lines*factor&&(factor===1||summary[a].mean_lines>summary[b].mean_lines)&&summary[a].mean_pieces>=summary[b].mean_pieces&&summary[a].early_rate<=summary[b].early_rate;
 const lookahead=verified&&improves('lookahead-model','legacy-model',1);
 const learned=lookahead&&improves('learned-model','lookahead-model',1.1)&&improves('learned-only','lookahead-only',1.1);
 return {lookahead,learned,default_policy:learned?'learned':lookahead?'lookahead':'legacy',verified};
}
