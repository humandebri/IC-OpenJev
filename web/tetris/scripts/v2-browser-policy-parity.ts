import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ROOT,OUT,read,atomic,sha} from './v2-common';
import {prepareAssisted} from '../src/placement-browser-v2';
import {Agent} from './v2-study-core';
process.chdir(ROOT);const selection=read(`${OUT}/selection-final.json`),spec=selection.spec,agent=new Agent(spec),bytes=readFileSync(`${ROOT}/web/tetris/public/tetris-value-v2.json`),bundle=JSON.parse(bytes.toString()),hash=sha(bytes);
assert.equal(hash,read(`${ROOT}/web/tetris/public/tetris-value-v2-manifest.json`).sha256);
const summary=read(`${OUT}/${selection.stage}-summary.json`),sources=summary.sources.filter((s:any)=>s.path.endsWith(`-${spec.id}.json`)).slice(0,32);let cases=0;
for(const source of sources){
 const game=read(`${OUT}/${source.path}`).episode;
 for(const turn of [0,31,63,127]){
  const state=game.trace[turn];if(!state)continue;const board=Uint16Array.from(state.before),reference=agent.prepare(board,state.piece,state.next);
  const ui=prepareAssisted({id:0,seed:game.seed,mode:0,turn,lines:0,over:false,policy:'value-v2',board:state.before.flatMap((mask:number)=>Array.from({length:10},(_,x)=>(mask>>>x)&1))},{bundle,hash});
  assert.deepEqual(ui.request,reference.request);assert.equal(ui.recommended,reference.recommended);
  assert.deepEqual(ui.candidates.map(c=>c.pose),reference.offered.map(c=>({r:c.r,x:c.x,y:c.y})));
  assert.deepEqual(ui.choices.map(c=>Array.from(c.board)),reference.offered.map(c=>Array.from(c.board)));
  assert.deepEqual(ui.choices.map(c=>c.score),reference.offered.map(c=>c.score));cases++;
 }
}
assert(cases>=32);atomic(`${OUT}/browser-policy-parity.json`,{passed:true,cases,scope:'Selected asset and browser candidate/cost/score path vs authoritative study, validation frames only',asset_sha256:hash,selection_sha256:sha(readFileSync(`${OUT}/selection-final.json`)),source_sha256:sha(readFileSync(import.meta.filename))});console.log({passed:true,cases});
