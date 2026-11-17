import {expect,it} from 'vitest';
import {CONFIGS,makeRequest,selectCandidates} from '../scripts/jev-policy';
import {searchPlacements} from './placement-search';
const all=searchPlacements(Array(200).fill(0),2,0);
it('keeps real choices and the highest score in every unlearned variant',()=>{
 const best=Math.max(...all.map(c=>c.search.score));
 for(const config of CONFIGS.filter(c=>c.sampler!=='learned')){
  const options=selectCandidates(all,config);
  expect(options.length).toBeGreaterThanOrEqual(2);expect(options.length).toBeLessThanOrEqual(4);
  expect(options.every(c=>all.includes(c)&&c.search.safe)).toBe(true);
  expect(Math.max(...options.map(c=>c.search.score))).toBe(best);
  expect(selectCandidates(all,config)).toEqual(options);
 }
});
it('does not manufacture a second choice when only one legal board exists',()=>{
 for(const c of CONFIGS)expect(selectCandidates(all.slice(0,1),c)).toEqual(all.slice(0,1));
});
it('makes order explicit and cost prompts disclose code scores',()=>{
 const canonical=selectCandidates(all,CONFIGS.find(c=>c.id==='top4')!);
 expect(selectCandidates(all,CONFIGS.find(c=>c.id==='top4-reverse')!)).toEqual([...canonical].reverse());
 const cfg=CONFIGS.find(c=>c.id==='top4-cost')!,options=selectCandidates(all,cfg),request=makeRequest(options,cfg);
 expect(request.state).toBe('Min cost');expect(request.options).toHaveLength(options.length);
 expect(request.options.map(o=>o.id)).toEqual(options.map((_,i)=>String(i)));
 const best=Math.max(...options.map(c=>c.search.score));
 expect(request.options.map(o=>Number(o.text.slice(5)))).toEqual(options.map(c=>best-c.search.score));
});
