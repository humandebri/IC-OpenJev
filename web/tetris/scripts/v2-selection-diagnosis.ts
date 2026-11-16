import {ROOT,OUT,read,atomic,sha} from './v2-common';
import {readFileSync} from 'node:fs';
process.chdir(ROOT);const summary=read(`${OUT}/test-summary.json`);if(!summary.complete)throw new Error('Held-out study incomplete');
const metrics=new Map<string,{spec:string;turns:number;disagreements:number;equal_cost_disagreements:number;strictly_higher_cost_choices:number;first_option_choices:number;single_options:number}>();
for(const source of summary.sources){
 const game=read(`${OUT}/${source.path}`).episode;if(game.mode!=='jev')continue;
 let m=metrics.get(game.spec);if(!m){m={spec:game.spec,turns:0,disagreements:0,equal_cost_disagreements:0,strictly_higher_cost_choices:0,first_option_choices:0,single_options:0};metrics.set(game.spec,m);}
 for(const state of game.trace){
  m.turns++;if(state.selected===0)m.first_option_choices++;if(state.candidates.length===1)m.single_options++;
  const costs=state.request.options.map((o:{text:string})=>Number(o.text.slice(5)));
  if(state.selected!==state.recommended){m.disagreements++;if(costs[state.selected]===costs[state.recommended])m.equal_cost_disagreements++;}
  if(costs[state.selected]>Math.min(...costs))m.strictly_higher_cost_choices++;
 }
}
atomic(`${OUT}/selection-diagnosis.json`,{complete:true,interpretation:'Disagreements caused by rounded equal cost descriptions are distinguished from selecting a strictly larger described cost. This does not infer strategic reasoning from equal-cost tie behavior.',metrics:[...metrics.values()],test_summary_sha256:sha(readFileSync(`${OUT}/test-summary.json`)),source_sha256:sha(readFileSync(import.meta.filename))});console.log([...metrics.values()]);
