// Experimental policies only; the public application's release is unchanged.
import {decisionRequest} from '../src/placement-local';
import {improvedCandidates,projectedRequest,searchPlacements,searchRecommendation,type Evaluator,type SearchCandidate} from '../src/placement-search';
export type Config={id:string;sampler:'current'|'learned'|'top'|'band'|'pareto';count:number;gap?:number;order:'canonical'|'quality'|'reverse';prompt:'relative'|'cost'|'numeric'};
const config=(id:string,sampler:Config['sampler'],count:number,order:Config['order']='canonical',prompt:Config['prompt']='relative',gap?:number):Config=>({id,sampler,count,order,prompt,...(gap===undefined?{}:{gap})});
export const CONFIGS:Config[]=[
 config('current','current',4),config('learned','learned',4),
 config('top4','top',4),config('top3','top',3),config('top2','top',2),
 config('band2','band',4,'canonical','relative',2),config('band8','band',4,'canonical','relative',8),config('pareto4','pareto',4),
 config('top4-quality','top',4,'quality'),config('top4-reverse','top',4,'reverse'),
 config('top2-quality','top',2,'quality'),config('top2-reverse','top',2,'reverse'),
 config('top4-cost','top',4,'canonical','cost'),config('top2-cost','top',2,'canonical','cost'),
 config('top2-numeric','top',2,'canonical','numeric'),config('band2-cost','band',4,'canonical','cost',2),
];
export function selectCandidates(all:SearchCandidate[],c:Config){
 if(!all.length)return [];
 const ranked=[...all].sort((a,b)=>b.search.score-a.search.score);
 let selected:SearchCandidate[];
 if(c.sampler==='current'||c.sampler==='learned')selected=improvedCandidates(all);
 else{
  let eligible=ranked;
  if(c.sampler==='band')eligible=ranked.filter(x=>x.search.score>=ranked[0].search.score-c.gap!);
  if(c.sampler==='pareto')eligible=ranked.filter(x=>!all.some(y=>y.search.holes<=x.search.holes&&y.search.height<=x.search.height&&y.search.total_lines>=x.search.total_lines&&(y.search.holes<x.search.holes||y.search.height<x.search.height||y.search.total_lines>x.search.total_lines)));
  selected=eligible.slice(0,c.count);
  for(const x of ranked)if(selected.length<Math.min(2,all.length)&&!selected.includes(x))selected.push(x);
 }
 if(c.order==='quality')return [...selected].sort((a,b)=>b.search.score-a.search.score);
 const canonical=all.filter(x=>selected.includes(x));return c.order==='reverse'?canonical.reverse():canonical;
}
export function makeRequest(options:SearchCandidate[],c:Config):ReturnType<typeof decisionRequest>{
 if(c.prompt==='relative')return projectedRequest(options);
 const max=Math.max(...options.map(o=>o.search.score));
 return {question:'',state:c.prompt==='cost'?'Min cost':'Min holes',abstention:false,temperature:1,
  options:options.map((o,i)=>({id:String(i),text:c.prompt==='cost'?`cost ${max-o.search.score}`:`holes${o.search.holes} height${o.search.height} missed${Math.max(...options.map(v=>v.search.total_lines))-o.search.total_lines}`}))};
}
export function prepare(board:number[],piece:number,next:number,c:Config,evaluator:Evaluator){
 const all=searchPlacements(board,piece,next,undefined,evaluator,c.sampler==='learned'),options=selectCandidates(all,c);
 if(!options.length)throw new Error('No legal placements');
 return {all,options,request:makeRequest(options,c),recommended:searchRecommendation(options)};
}
