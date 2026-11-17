import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ROOT,OUT,read,atomic,sha} from './v2-common';
import {placements,landed,pieceAt,features,renderPrompt} from '../src/placement-local';
import {validateReply} from '../src/placement-query-api';
process.chdir(ROOT);
const stage=process.argv[2]||'test',protocol=read(`${OUT}/${stage}-protocol.json`),summary=read(`${OUT}/${stage}-summary.json`);
assert(summary.complete&&summary.authoritative&&summary.query_error_free);
assert.equal(summary.protocol_sha256,sha(JSON.stringify(protocol)));
for(const [path,hash] of Object.entries(protocol.source_hashes))assert.equal(sha(readFileSync(`${ROOT}/${path}`)),hash,`Changed source ${path}`);
const expand=(rows:number[])=>rows.flatMap(row=>Array.from({length:10},(_,x)=>(row>>>x)&1));
const masks=(cells:number[])=>Array.from({length:20},(_,y)=>cells.slice(y*10,y*10+10).reduce((v,b,x)=>v|(b?1<<x:0),0));
let turns=0,queries=0,maxTokens=0,maxInstructions=0n;const httpCalls=new Set<string>(),visited=new Set<string>(),status={enabled:true,warmed:true,model:[...Buffer.from(protocol.model_digest,'hex')],max_tokens:41};
for(const source of summary.sources){
 const bytes=readFileSync(`${OUT}/${source.path}`);assert.equal(sha(bytes),source.sha256);
 const saved=JSON.parse(bytes.toString());assert.equal(saved.protocol_sha256,summary.protocol_sha256);
 const game=saved.episode;assert(protocol.seeds.includes(game.seed));assert(!visited.has(`${game.seed}:${game.spec}`));visited.add(`${game.seed}:${game.spec}`);
 let board=Array(200).fill(0),lines=0,lines128=0;
 for(const [turn,t] of game.trace.entries()){
  assert.equal(t.turn,turn);assert.equal(t.piece,pieceAt(game.seed,t.turn));assert.equal(t.next,pieceAt(game.seed,t.turn+1));assert.deepEqual(t.before,masks(board));
  const legal=placements(board,t.piece),occupancies=new Set<string>();assert(t.candidates.length>=1&&t.candidates.length<=2);
  const recommendation=t.candidates.reduce((best:number,c:any,i:number)=>c.score>t.candidates[best].score?i:best,0);assert.equal(t.recommended,recommendation);
  for(const c of t.candidates){
   const candidate=legal.find(p=>p.pose.r===c.r&&p.pose.x===c.x&&p.pose.y===c.y);assert(candidate,'Unreachable candidate');
   const placed=landed(board,t.piece,candidate.cells);assert.equal(placed.lines,c.lines);assert.deepEqual(masks(placed.board),c.after);
   assert(!occupancies.has(c.after.join(',')));occupancies.add(c.after.join(','));
   const next=placements(placed.board,t.next);let best=next[0];for(const p of next)if(p.evaluation>best.evaluation)best=p;
   assert.equal(c.safe,!!best);
   if(best){const end=landed(placed.board,t.next,best.cells),f=features(end.board);assert.deepEqual(c.next_pose,best.pose);assert.equal(c.next_lines,end.lines);assert.deepEqual(c.terminal,masks(end.board));assert(c.base===-8*f.holes-f.height,'Two-ply base mismatch');assert.equal(c.total_lines,placed.lines+end.lines);}
   else assert.equal(c.terminal,null);
  }
  if(game.mode==='jev'){
   const best=Math.max(...t.candidates.map((c:any)=>c.score));assert.deepEqual(t.request,{question:'',state:'Min cost',abstention:false,temperature:1,options:t.candidates.map((c:any,i:number)=>({id:String(i),text:`cost ${Math.max(0,Math.round(best-c.score))}`}))});
   const tReply=t.reply;assert.equal(tReply.cached,false);assert.equal(typeof tReply.call_id,'string');assert(!httpCalls.has(tReply.call_id));httpCalls.add(tReply.call_id);
   const cache=read(`${OUT}/query-cache/${tReply.query_record}.json`);assert.equal(sha(JSON.stringify(cache)),tReply.query_record);
   assert.deepEqual(cache.request,t.request);assert.equal(cache.model,protocol.model_digest);assert.equal(sha(JSON.stringify({request:cache.request,model:cache.model,wasm:cache.wasm})),tReply.cache_key);
   const reply={...cache.reply,measured_instructions:BigInt(cache.reply.measured_instructions)};
   assert.equal(validateReply(reply,t.request,status),t.selected);assert.equal(tReply.selected,t.selected);assert.equal(tReply.tokens,reply.input_tokens);assert.deepEqual(tReply.scores,reply.probabilities);assert.deepEqual(tReply.logits,reply.logits);
   assert.equal(tReply.instructions,reply.measured_instructions.toString());assert(reply.measured_instructions>0n);assert.equal(renderPrompt(t.request),t.request.options.map((v:any)=>`<<LABEL>>${v.text}`).join('')+'<<SEP>>Min cost');
   queries++;maxTokens=Math.max(maxTokens,reply.input_tokens);maxInstructions=reply.measured_instructions>maxInstructions?reply.measured_instructions:maxInstructions;
  }
  if(game.mode==='eval')assert.equal(t.selected,t.recommended);
  const chosen=t.candidates[t.selected];assert(chosen);assert.deepEqual(t.after,chosen.after);board=expand(t.after);lines+=chosen.lines;if(t.turn<128)lines128=lines;turns++;
 }
 assert.equal(game.pieces,game.trace.length);assert.equal(game.lines,lines);assert.equal(game.lines128,lines128);assert.equal(game.pieces128,Math.min(128,game.pieces));
 if(visited.size%32===0)console.log(`audit ${visited.size}/${summary.sources.length} games, ${turns} placements`);
}
assert.equal(visited.size,protocol.seeds.length*protocol.specs.length);assert.equal(queries,httpCalls.size);assert.equal(queries,summary.logical_model_turns);
atomic(`${OUT}/${stage}-audit.json`,{passed:true,implementation:'Original colored-board reachable BFS, lock/clear, fixed NEXT response; every HTTP query reply, unique call ID, content hash and request binding',games:visited.size,turns,http_queries:queries,logical_queries:queries,max_tokens:maxTokens,max_instructions:maxInstructions.toString(),protocol_sha256:summary.protocol_sha256,summary_sha256:sha(readFileSync(`${OUT}/${stage}-summary.json`)),source_sha256:sha(readFileSync(import.meta.filename))});
