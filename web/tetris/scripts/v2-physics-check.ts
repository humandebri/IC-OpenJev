import {ROOT,OUT,sha,atomic,random,hashes} from './v2-common';
import {placements,landed} from '../src/placement-local';
import {searchPlacements} from '../src/placement-search';
import {masks,expand,fastPlacements,fastChoices,pieceStream} from '../src/placement-fast';
import assert from 'node:assert/strict';
process.chdir(ROOT);
const rng=random(773),boards:number[][]=[];
let board=Array(200).fill(0),episode=0,index=0,pieces=pieceStream(184,513);
while(boards.length<500){
 boards.push(board.slice());const options=placements(board,pieces[index]);
 if(!options.length||index>=511){board=Array(200).fill(0);pieces=pieceStream(++episode+184,513);index=0;continue;}
 const ranked=[...options].sort((a,b)=>b.evaluation-a.evaluation);const c=episode%3===0?ranked[Math.floor(rng()*Math.min(4,ranked.length))]:options[Math.floor(rng()*options.length)];
 board=landed(board,pieces[index++],c.cells).board;
}
for(let i=0;i<500;i++){
 const heights=Array.from({length:10},()=>Math.floor(rng()*21));heights[0]=0;
 boards.push(Array.from({length:200},(_,at)=>20-Math.floor(at/10)<=heights[at%10]&&rng()>.1?1:0));
}
let count=0,twoPly=0;const began=performance.now();
for(let i=0;i<boards.length;i++)for(let piece=0;piece<7;piece++){
 const input=boards[i],reference=placements(input,piece),actual=fastPlacements(masks(input),piece);
 assert.deepEqual(actual.map(c=>[c.r,c.x,c.y,c.lines,c.holes,c.height]),reference.map(c=>[c.pose.r,c.pose.x,c.pose.y,c.lines,c.holes,c.height]));
 actual.forEach((c,j)=>assert.deepEqual(expand(c.board),landed(input,piece,reference[j].cells).board.map(v=>Number(!!v))));count++;
 if(i%10===0){const next=(piece+3)%7,a=fastChoices(masks(input),piece,next),b=searchPlacements(input,piece,next);
  assert.deepEqual(a.map(c=>[c.key,c.score,c.total_lines,c.safe,c.next?.key??null]),b.map(c=>[c.pose.r*200+c.pose.x*20+c.pose.y,c.search.score,c.search.total_lines,c.search.safe,c.search.next_pose?c.search.next_pose.r*200+c.search.next_pose.x*20+c.search.next_pose.y:null]));twoPly++;
 }
}
atomic(`${OUT}/physics-check.json`,{passed:true,boards:boards.length,piece_cases:count,two_ply_cases:twoPly,fixture_sha256:sha(JSON.stringify(boards)),seconds:(performance.now()-began)/1000,source_hashes:hashes(['web/tetris/src/placement-fast.ts','web/tetris/src/placement-local.ts','web/tetris/src/placement-search.ts','web/tetris/scripts/v2-physics-check.ts'])});
console.log({passed:true,boards:boards.length,count,twoPly,seconds:(performance.now()-began)/1000});
