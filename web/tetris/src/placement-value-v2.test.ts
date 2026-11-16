import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {placements,landed,features,pieceAt} from './placement-local';
import {masks,expand,fastPlacements,fastChoices,bestChoice,Teacher,pieceStream} from './placement-fast';
import {featureNames,valueFeatures,predictValue,forestPredict,v2Score,topTwo,costRequest,validateBundle,sigmoid,type ValueBundle} from './placement-value-v2';
const leaf=(v:number)=>({trees:[[[-1,v,0,0]]],link:'identity' as const});
const bundle=(alpha=0,beta=0):ValueBundle=>({version:2,geometry:true,feature_names:featureNames(true),residual:leaf(12),risk:{...leaf(0),link:'sigmoid'},alpha,beta,horizon:32,metadata:{}});
it('matches Python predictions from the selected shipped residual and probability models',()=>{
 const model=JSON.parse(readFileSync(new URL('../public/tetris-value-v2.json',import.meta.url),'utf8')) as ValueBundle;
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/tetris-value-v2-predictions.json',import.meta.url),'utf8'));validateBundle(model);
 for(let i=0;i<fixture.features.length;i++){
  expect(forestPredict(model.residual,fixture.features[i])).toBeCloseTo(fixture.residual[i],9);
  expect(forestPredict(model.risk,fixture.features[i])).toBeCloseTo(fixture.risk[i],9);
 }
});
it('matches reference poses, clears, features and occupancy on trajectories',()=>{
 let board=Array(200).fill(0);
 for(let turn=0;turn<48;turn++){
  for(let piece=0;piece<7;piece++){
   const reference=placements(board,piece),actual=fastPlacements(masks(board),piece);
   expect(actual.map(c=>[c.r,c.x,c.y,c.lines,c.holes,c.height])).toEqual(reference.map(c=>[c.pose.r,c.pose.x,c.pose.y,c.lines,c.holes,c.height]));
   actual.forEach((c,i)=>expect(expand(c.board)).toEqual(landed(board,piece,reference[i].cells).board.map(v=>Number(!!v))));
  }
  const options=placements(board,pieceAt(184,turn));if(!options.length)break;
  const c=options[(turn*7)%options.length];board=landed(board,pieceAt(184,turn),c.cells).board;
 }
},20000);
it('exactly reproduces the old two-ply score and collision-checked caching',()=>{
 const board=Array(200).fill(0),all=fastChoices(masks(board),2,0),teacher=new Teacher(1);
 for(const c of all){const next=placements(expand(c.board),0),best=next.reduce((a,b)=>b.evaluation>a.evaluation?b:a);expect(c.score).toBe(10*c.lines+best.evaluation);expect(c.next?.key).toBe(best.pose.r*200+best.pose.x*20+best.pose.y);expect(v2Score(c,bundle()).score).toBe(c.score);}
 expect(teacher.choose(masks(board),2,0)?.key).toBe(bestChoice(all)?.key);expect(teacher.choose(masks(board),2,0)?.key).toBe(bestChoice(all)?.key);expect(teacher.hits).toBe(1);
});
it('keeps the seven-bag identical at long episode lengths',()=>{
 for(const seed of [0,1,184,0xffffffff])expect(pieceStream(seed,513)).toEqual(Array.from({length:513},(_,i)=>pieceAt(seed,i)));
});
it('counts known clears once and separates residual from probability',()=>{
 const c=fastChoices(new Uint16Array(20),2,0)[0],v=v2Score({...c,total_lines:3,base:-10,score:20},bundle(.5,10));
 expect(v.score).toBe(21);expect(v.residual).toBe(12);expect(v.risk).toBe(.5);
});
it('uses geometry without seed, hidden NEXT, score or turn inputs',()=>{
 const a=Array(200).fill(0),b=a.slice();a[170]=a[171]=b[170]=b[171]=1;a[180]=a[190]=1;b[181]=b[191]=1;
 expect(features(a)).toEqual(features(b));expect(valueFeatures(masks(a))).not.toEqual(valueFeatures(masks(b)));
 expect(valueFeatures(masks(a))).toHaveLength(featureNames(true).length);expect(valueFeatures(masks(a),false)).toHaveLength(featureNames(false).length);
 expect(featureNames(true).some(n=>/seed|next|turn|piece/.test(n))).toBe(false);
});
it('validates links and cycles and handles extreme logits',()=>{
 validateBundle(bundle());expect(sigmoid(-1000)).toBe(0);expect(sigmoid(1000)).toBe(1);
 const bad=bundle();bad.risk.trees=[[[0,1,0,0]]];expect(()=>validateBundle(bad)).toThrow('structure');
 expect(predictValue(bundle(),new Uint16Array(20))).toEqual({residual:12,risk:.5});
});
it('offers distinct choices with integer costs in canonical order',()=>{
 const selected=topTwo(fastChoices(new Uint16Array(20),2,0));expect(selected).toHaveLength(2);expect(selected[0].key).toBeLessThan(selected[1].key);
 const request=costRequest(selected);expect(request.options.map(o=>Number(o.text.slice(5)))).toEqual(selected.map(c=>Math.round(Math.max(...selected.map(v=>v.score))-c.score)));
});
