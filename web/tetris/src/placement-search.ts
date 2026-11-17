import type {Candidate} from './placement-api';
import {decisionRequest,landed,placements,recommend} from './placement-local';

export type SearchInfo={safe:boolean;next_count:number;total_lines:number;holes:number;height:number;score:number;next_pose:Candidate['pose']|null};
export type SearchCandidate=Candidate&{search:SearchInfo};
export type Evaluator={hash:string;predict:(board:number[],next:number)=>number};
export const occupancy=(board:number[])=>board.map(v=>v?'1':'0').join('');
export const isAnalyzed=(c:Candidate):c is SearchCandidate=>'search' in c;

// Only identical resulting occupancy is merged, never identical summary features.
export function searchPlacements(board:number[],piece:number,next:number,all=placements(board,piece),evaluator?:Evaluator,learned=false):SearchCandidate[]{
 if(learned&&!evaluator)throw new Error('Learned evaluator is not loaded');
 const seen=new Set<string>(),out:SearchCandidate[]=[];
 for(const c of all){
  const after=landed(board,piece,c.cells).board,key=occupancy(after);
  if(seen.has(key))continue;seen.add(key);
  const replies=placements(after,next),best=replies.length?replies[recommend(replies)]:undefined;
  const total_lines=c.lines+(best?.lines??0),holes=best?.holes??c.holes,height=best?.height??c.height;
  const score=learned?c.lines+evaluator!.predict(after,next):10*total_lines-8*holes-height;
  if(!Number.isFinite(score))throw new Error('Non-finite evaluator prediction');
  out.push({...c,search:{safe:!!best,next_count:replies.length,total_lines,holes,height,score,next_pose:best?.pose??null}});
 }
 return out.some(c=>c.search.safe)?out.filter(c=>c.search.safe):out;
}
export function improvedCandidates(all:SearchCandidate[]):SearchCandidate[]{
 if(!all.length)return [];
 const best=(value:(c:SearchCandidate)=>number)=>all.reduce((a,b)=>value(b)>value(a)?b:a);
 const selected:SearchCandidate[]=[];
 for(const c of [best(c=>c.search.score),best(c=>c.lines),best(c=>-c.holes),best(c=>-c.height)])if(!selected.includes(c))selected.push(c);
 for(const c of [...all].sort((a,b)=>b.search.score-a.search.score))if(selected.length<4&&!selected.includes(c))selected.push(c);
 // Keep canonical placement order, rather than exposing quality through option position.
 return all.filter(c=>selected.includes(c));
}
export function searchRecommendation(options:Candidate[]){
 return options.reduce((best,c,i)=>{
  const a=options[best];if(!isAnalyzed(c)||!isAnalyzed(a))throw new Error('Missing search result');
  return c.search.score>a.search.score?i:best;
 },0);
}
export function projectedRequest(options:Candidate[]){
 return decisionRequest(options.map(c=>{
  if(!isAnalyzed(c))throw new Error('Missing search result');
  return {...c,holes:c.search.holes,height:c.search.height,lines:c.search.total_lines};
 }));
}

export const FEATURE_NAMES=[...Array.from({length:10},(_,i)=>`height_${i}`),...Array.from({length:10},(_,i)=>`holes_${i}`),...Array.from({length:9},(_,i)=>`slope_${i}`),...Array.from({length:10},(_,i)=>`well_${i}`),...Array.from({length:20},(_,i)=>`row_${i}`),...Array.from({length:7},(_,i)=>`next_${i}`)];
export function boardFeatures(board:number[],next:number):number[]{
 if(board.length!==200||!Number.isInteger(next)||next<0||next>6)throw new Error('Invalid feature input');
 const heights:number[]=[],holes:number[]=[];
 for(let x=0;x<10;x++){
  let h=0,n=0;for(let y=0;y<20;y++){if(board[y*10+x])h=Math.max(h,20-y);else if(h)n++;}
  heights.push(h);holes.push(n);
 }
 const slopes=heights.slice(1).map((h,i)=>h-heights[i]);
 const wells=heights.map((h,i)=>Math.max(0,Math.min(i?heights[i-1]:20,i<9?heights[i+1]:20)-h));
 const rows=Array.from({length:20},(_,y)=>board.slice(y*10,y*10+10).filter(Boolean).length);
 return [...heights,...holes,...slopes,...wells,...rows,...Array.from({length:7},(_,i)=>Number(i===next))];
}
export type Tree={leaf_value:number}|{split_feature:number;threshold:number;decision_type:'<=';default_left:boolean;missing_type:string;left_child:Tree;right_child:Tree};
export type TreeModel={feature_names:string[];objective:string;tree_info:{tree_structure:Tree}[];average_output?:boolean};
export function treePredict(model:TreeModel,values:number[]):number{
 const visit=(t:Tree):number=>{
  if('leaf_value' in t)return t.leaf_value;
  if(t.decision_type!=='<=')throw new Error('Unsupported tree split');
  const v=values[t.split_feature];if(!Number.isFinite(v))throw new Error('Invalid tree feature');
  return visit(v<=t.threshold?t.left_child:t.right_child);
 };
 const total=model.tree_info.reduce((s,t)=>s+visit(t.tree_structure),0);
 return model.average_output?total/model.tree_info.length:total;
}
export function createEvaluator(model:TreeModel,hash:string):Evaluator{
 if(JSON.stringify(model.feature_names)!==JSON.stringify(FEATURE_NAMES)||!model.objective.startsWith('regression')||!model.tree_info.length)throw new Error('Invalid evaluator schema');
 const validate=(tree:Tree):void=>{
  if('leaf_value' in tree){if(!Number.isFinite(tree.leaf_value))throw new Error('Invalid leaf');return;}
  if(tree.decision_type!=='<='||!Number.isFinite(tree.threshold)||!Number.isInteger(tree.split_feature)||tree.split_feature<0||tree.split_feature>=FEATURE_NAMES.length)throw new Error('Unsupported tree split');
  validate(tree.left_child);validate(tree.right_child);
 };
 model.tree_info.forEach(t=>validate(t.tree_structure));
 return {hash,predict:(board,next)=>treePredict(model,boardFeatures(board,next))};
}
