import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {boardFeatures,FEATURE_NAMES,createEvaluator,improvedCandidates,occupancy,projectedRequest,searchPlacements,treePredict} from './placement-search';
import {landed,placements,prepareTurn,decisionRequest,pieceAt} from './placement-local';
import {choosePlacement} from './placement-query-api';
import {adoption,hash,rng,TEST_SEEDS,TRAIN_SEEDS,VALID_SEEDS} from '../scripts/placement-study-core';
const game={id:0,board:Array(200).fill(0),seed:11,turn:0,lines:0,mode:1,over:false};
it('retains equal-feature boards with distinct geometry and canonical order',()=>{
 const all=searchPlacements(game.board,1,0),flat=all.filter(c=>c.lines===0&&c.holes===0&&c.height===2);
 expect(flat.length).toBeGreaterThan(4);
 expect(new Set(flat.map(c=>occupancy(landed(game.board,1,c.cells).board))).size).toBe(flat.length);
 const offered=improvedCandidates(all);expect(offered.length).toBeLessThanOrEqual(4);
 expect(improvedCandidates(all)).toEqual(offered);expect(offered).toEqual(all.filter(c=>offered.includes(c)));
});
it('uses exact two-placement features and preserves query shape and input',()=>{
 const board=game.board.slice(),all=searchPlacements(board,2,0),options=improvedCandidates(all);
 for(const c of all){
  const next=placements(landed(board,2,c.cells).board,0),best=next.reduce((a,b)=>b.evaluation>a.evaluation?b:a);
  expect(c.search).toMatchObject({safe:true,total_lines:c.lines+best.lines,holes:best.holes,height:best.height,score:10*(c.lines+best.lines)-8*best.holes-best.height,next_pose:best.pose});
 }
 expect(board).toEqual(game.board);
 expect(projectedRequest(options)).toEqual(decisionRequest(options.map(c=>({...c,lines:c.search.total_lines,holes:c.search.holes,height:c.search.height}))));
});
it('filters blocked NEXT only when a safe alternative exists',()=>{
 const random=rng(123),seen={mixed:false,unsafe:false};
 for(let attempt=0;attempt<400&&(!seen.mixed||!seen.unsafe);attempt++){
  const heights=Array.from({length:10},()=>Math.floor(random()*20));heights[0]=0;
  const board=Array.from({length:200},(_,i)=>20-Math.floor(i/10)<=heights[i%10]?1:0);
  const all=placements(board,0);if(!all.length)continue;
  const safe=all.filter(c=>placements(landed(board,0,c.cells).board,1).length>0),actual=searchPlacements(board,0,1,all);
  if(safe.length&&safe.length<all.length){seen.mixed=true;expect(actual.every(c=>c.search.safe)).toBe(true);expect(actual.length).toBeGreaterThan(0);}
  if(!safe.length){seen.unsafe=true;expect(actual.length).toBeGreaterThan(0);expect(actual.every(c=>!c.search.safe)).toBe(true);expect(improvedCandidates(actual).length).toBeGreaterThan(0);}
 }
 expect(seen).toEqual({mixed:true,unsafe:true});
});
it('reserves scoring, clear, holes, and height alternatives',()=>{
 const all=searchPlacements(game.board,1,0).slice(0,6).map((c,i)=>({...c,lines:i===1?4:0,holes:i===2?0:10,height:i===3?1:10,search:{...c.search,score:i===0?100:0}}));
 expect(improvedCandidates(all)).toEqual(all.slice(0,4));
});
it('learned score preserves projected descriptions and rejects missing evaluators',()=>{
 const fixed=searchPlacements(game.board,2,0),learned=searchPlacements(game.board,2,0,undefined,{hash:'test',predict:()=>123},true);
 expect(projectedRequest(learned)).toEqual(projectedRequest(fixed));expect(learned.every(c=>c.search.score===123+c.lines)).toBe(true);
 expect(()=>prepareTurn({...game,policy:'learned'})).toThrow('not loaded');
});
it('extracts geometry features with one-hot NEXT and no seed',()=>{
 const board=game.board.slice();board[170]=1;board[190]=1;
 const f=boardFeatures(board,2);expect(f).toHaveLength(FEATURE_NAMES.length);
 expect(f[0]).toBe(3);expect(f[10]).toBe(1);expect(f.slice(-7)).toEqual([0,0,1,0,0,0,0]);expect(()=>boardFeatures(board,7)).toThrow();
});
it('executes one query even for one candidate and leaves the board intact on errors',async()=>{
 const board=Array(200).fill(1);for(let y=0;y<20;y++)board[y*10]=0;for(const i of [4,5,14,15])board[i]=0;
 const seed=Array.from({length:100},(_,i)=>i+1).find(s=>pieceAt(s,0)===1)!;
 const g={...game,seed,mode:0,board,policy:'lookahead' as const},turn=prepareTurn(g);expect(turn.candidates).toHaveLength(1);
 const status={enabled:true,warmed:true,model:Array(32).fill(7),max_tokens:52};let calls=0;
 const result=await choosePlacement(g,status,async()=>{calls++;return {ids:['0'],selected:'0',probabilities:[1],logits:[0],model:status.model,confidence:1,input_tokens:14,measured_instructions:1n};});
 expect(calls).toBe(1);expect(result.query_count).toBe(1);expect(result.policy).toBe('lookahead');expect(g.board).toEqual(board);
 await expect(choosePlacement(g,status,async()=>{throw new Error('offline');})).rejects.toThrow('offline');expect(g.board).toEqual(board);
});
it('keeps partitions separate and adoption closed without authoritative evidence',()=>{
 expect(new Set([...TRAIN_SEEDS,...VALID_SEEDS,...TEST_SEEDS]).size).toBe(352);
 const metrics={games:32,mean_lines:10,median_lines:10,mean_pieces:60,early_rate:0,cap_rate:0,mean_candidate_ms:1,disagreements:0,regret:0,counterfactual_line_gain:0,counterfactual_count:0};
 const summary=Object.fromEntries(['legacy-model','lookahead-model','lookahead-only','learned-model','learned-only','full-search'].map(k=>[k,{...metrics}]));
 summary['learned-model'].mean_lines=summary['learned-only'].mean_lines=11;
 expect(adoption(summary,false).default_policy).toBe('legacy');expect(adoption(summary,true).default_policy).toBe('learned');
 summary['learned-only'].mean_pieces=59;expect(adoption(summary,true).default_policy).toBe('lookahead');
 summary['legacy-model'].games=31;expect(adoption(summary,true).default_policy).toBe('legacy');
});
it('matches Python predictions from the actual trained model',()=>{
 const root=new URL('../../../artifacts/tetris-search/',import.meta.url),path=new URL('../public/tetris-evaluator.json',import.meta.url);
 const model=JSON.parse(readFileSync(path,'utf8')),fixtures=JSON.parse(readFileSync(new URL('prediction-fixtures.json',root),'utf8'));
 const evaluator=createEvaluator(model,hash(readFileSync(path)));expect(evaluator.hash).toHaveLength(64);
 for(let i=0;i<fixtures.features.length;i++)expect(treePredict(model,fixtures.features[i])).toBeCloseTo(fixtures.predictions[i],9);
});
