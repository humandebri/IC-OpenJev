import assert from 'node:assert/strict';
import {ROOT,OUT,read,atomic,sha,random} from './v2-common';
import {readFileSync} from 'node:fs';
import {pieceAt,landed} from '../src/placement-local';
import {searchPlacements} from '../src/placement-search';
process.chdir(ROOT);const manifest=read(`${OUT}/dataset-manifest.json`),rng=random(1729),sources=[...manifest.sources],checks=[];
for(let n=0;n<16&&sources.length;n++){
 const source=sources.splice(Math.floor(rng()*sources.length),1)[0],part=read(`${OUT}/${source.path}`),row=part.rows[Math.floor(rng()*part.rows.length)];if(!row)continue;
 for(const o of row.outcomes){
  let board=row.terminal.flatMap((mask:number)=>Array.from({length:10},(_,x)=>(mask>>>x)&1)),lines=0,survived=0,ended=false;
  for(let t=0;t<32;t++){
   const piece=pieceAt(o.seed,t),next=pieceAt(o.seed,t+1),legal=searchPlacements(board,piece,next);
   if(!legal.length){ended=true;break;}
   let c=legal[0];for(const p of legal)if(p.search.score>c.search.score)c=p;
   const placed=landed(board,piece,c.cells);board=placed.board;lines+=placed.lines;survived++;
   if(!c.search.safe){ended=true;break;}
  }
  assert.deepEqual({lines,survived,ended},{lines:o.lines,survived:o.survived,ended:o.ended});
 }
 checks.push({source:source.path,seed:row.seed,turn:row.turn,key:row.key});console.log(`reference label ${checks.length}/16`);
}
atomic(`${OUT}/label-audit.json`,{passed:true,checks,rollouts:checks.length*8,implementation:'Original colored-board BFS and original searchPlacements; independent original pieceAt, no fast simulator',dataset_sha256:sha(readFileSync(`${OUT}/dataset-manifest.json`)),source_sha256:sha(readFileSync(import.meta.filename))});
