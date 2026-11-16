import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ROOT,OUT,read,atomic,sha} from './v2-common';
import {Agent} from './v2-study-core';
import {pieceStream,expand,type MaskBoard} from '../src/placement-fast';
import {placements,landed} from '../src/placement-local';
import {v2Score,topTwo} from '../src/placement-value-v2';
process.chdir(ROOT);const training=read(`${OUT}/training-initial.json`),seeds=read(`${OUT}/data-protocol.json`).seeds.game_valid.slice(0,2);let cases=0,candidates=0;
for(const item of training.models){
 const path=`${OUT}/${item.path}`,bundle=read(path);bundle.alpha=.25;bundle.beta=40;
 const agent=new Agent({id:item.id,family:'v2',mode:'eval',bundle:path,bundle_sha256:item.sha256,alpha:.25,beta:40});
 for(const seed of seeds){let board:MaskBoard=new Uint16Array(20);const stream=pieceStream(seed,129);
  for(let turn=0;turn<128;turn++){
   const result=agent.prepare(board,stream[turn],stream[turn+1]),repeat=agent.prepare(board,stream[turn],stream[turn+1]);assert.deepEqual(result,repeat);
   if(!result.offered.length)break;const original=placements(expand(board),stream[turn]);
   for(const c of result.all){
    const p=original.find(v=>v.pose.r===c.r&&v.pose.x===c.x&&v.pose.y===c.y);assert(p);assert.deepEqual(landed(expand(board),stream[turn],p.cells).board.map(v=>Number(!!v)),expand(c.board));assert.equal(c.lines,p.lines);
    const uncached=v2Score(c,bundle);assert.equal(uncached.score,c.score);assert.equal(uncached.residual,c.residual);assert.equal(uncached.risk,c.risk);candidates++;
   }
   const chosen=result.offered[result.recommended];board=chosen.board;cases++;if(!chosen.safe)break;
  }
 }
 console.log(`checked ${item.id}: ${cases} turns`);
}
atomic(`${OUT}/simulation-check.json`,{passed:true,models:training.models.length,games:training.models.length*seeds.length,turns:cases,all_candidate_checks:candidates,cache_repeat_and_original_transition:true,source_sha256:sha(readFileSync(import.meta.filename)),study_core_sha256:sha(readFileSync(`${ROOT}/web/tetris/scripts/v2-study-core.ts`))});
