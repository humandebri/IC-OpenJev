// Post-hoc illustration only: no policy selection and no replay of held-out games.
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync} from 'node:fs';
import {rollout,hash} from './placement-study-core';
import {landed} from '../src/placement-local';
import type {SearchCandidate} from '../src/placement-search';
process.chdir(fileURLToPath(new URL('../../../',import.meta.url)));
const out='artifacts/tetris-search',examples=[];
for(const policy of ['lookahead-model','learned-model']){
 const rows=[];
 for(const seed of [30001,30002,30003]){
  const file=`${out}/test/${seed}-${policy}.json`,raw=readFileSync(file),game=JSON.parse(raw.toString());
  for(const row of game.trace.filter((r:{selected:number;recommended:number})=>r.selected!==r.recommended).slice(0,4)){
   const value=(index:number)=>row.options[index].lines+Array.from({length:4},(_,r)=>rollout(landed(row.before,row.piece,row.options[index].cells).board,row.next,(seed*2246822519+row.turn*97+r*104729)>>>0).lines).reduce((a,b)=>a+b,0)/4;
   const selected=value(row.selected),recommended=value(row.recommended);
   rows.push({seed,turn:row.turn,source:file,source_sha256:hash(raw),selected:row.selected,recommended:row.recommended,selected_description:row.request.options[row.selected].text,recommended_description:row.request.options[row.recommended].text,
    selected_features:row.options[row.selected] as SearchCandidate,recommended_features:row.options[row.recommended] as SearchCandidate,selected_estimated_lines:selected,recommended_estimated_lines:recommended,estimated_line_gain:selected-recommended});
  }
 }
 rows.sort((a,b)=>a.estimated_line_gain-b.estimated_line_gain);
 examples.push({policy,sampled_states:rows.length,worst:rows[0],best:rows.at(-1)});
}
writeFileSync(`${out}/model-examples.json`,JSON.stringify({note:'Illustrative extremes among the first four disagreements on the first three test seeds. Four paired independent 16-piece rollouts estimate line return; these are not optimal-move labels or full-game win rates.',examples},null,2)+'\n');
console.log(examples.map(e=>({policy:e.policy,worst:e.worst?.estimated_line_gain,best:e.best?.estimated_line_gain})));
