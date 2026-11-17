import type {Decision,PlacementPolicy} from './placement-browser-v2';
import {decisionRequest} from './placement-local';
import {projectedRequest} from './placement-search';

export const POLICY_NAMES:Record<PlacementPolicy,string>={
 'value-v2':'LightGBM v2','fixed-cost':'Fixed search',lookahead:'Lookahead search',learned:'LightGBM v1',legacy:'Legacy heuristic',
};
export const usesNumericCosts=(policy:PlacementPolicy)=>policy==='value-v2'||policy==='fixed-cost';
const isPolicy=(value:string|undefined):value is PlacementPolicy=>!!value&&Object.hasOwn(POLICY_NAMES,value);
export function releasePolicy(release:{adopted:boolean;default_policy?:string},previous:{default_policy:string}):PlacementPolicy{
 if(isPolicy(release.default_policy)&&(release.adopted||release.default_policy!=='value-v2'))return release.default_policy;
 return isPolicy(previous.default_policy)&&previous.default_policy!=='value-v2'?previous.default_policy:'legacy';
}
// Retained policies use three-feature descriptions, not the v2 numeric prompt.
// Evaluator-only turns have no request, so reconstruct their policy's descriptions.
export function optionLabels(decision:Decision):string[]{
 if(decision.model_request)return decision.model_request.options.map(option=>option.text);
 if(usesNumericCosts(decision.policy)){
  const scores=decision.candidates.map(c=>(c as typeof c&{search:{score:number}}).search.score),best=Math.max(...scores);
  return scores.map(score=>`cost ${Math.max(0,Math.round(best-score))}`);
 }
 return (decision.policy==='legacy'?decisionRequest(decision.candidates):projectedRequest(decision.candidates)).options.map(option=>option.text);
}
