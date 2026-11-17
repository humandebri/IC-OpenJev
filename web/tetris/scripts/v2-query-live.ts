// Authoritative transport: one HTTP decide_query call per requested game turn.
// Identical immutable reply records may share storage; HTTP calls are never memoized.
import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {connectQuery,validateReply,type ModelReply} from '../src/placement-query-api';
import {ROOT,OUT,sha,atomic,read} from './v2-common';
import type {OracleReply,Request as DecisionRequest} from './v2-oracle';
export async function realOracle(){
 const target=read(`${ROOT}/artifacts/tetris-search/local-target.json`),client=await connectQuery(target.host,target.canister),status=await client.status();
 const model='0757d774c8c44397d189c5b479853897acef8f1e2b55ebf1f5a46969063225e0';
 if(!status.enabled||Buffer.from(status.model).toString('hex')!==model||target.wasm_sha256!==sha(readFileSync(`${ROOT}/build/compat-model-query/verdict-engine.wasm`)))throw new Error('Fixed query target mismatch');
 atomic(`${OUT}/local-target.json`,target);const run=randomUUID(),stats={actual:0,cached:0,max_tokens:0,max_instructions:0n};
 const originalFetch=globalThis.fetch;globalThis.fetch=(...args)=>{const url=String(args[0] instanceof Request?args[0].url:args[0]);if(/\/call(?:\?|$)/.test(url))throw new Error('Updates forbidden');return originalFetch(...args);};
 const choose=async(request:DecisionRequest):Promise<OracleReply>=>{
  const reply:ModelReply=await client.query(request);const call_id=`${run}:${++stats.actual}`,selected=validateReply(reply,request,status);
  if(reply.input_tokens>41||reply.measured_instructions<=0n)throw new Error('Query budget/provenance failure');
  const record={request,model,wasm:target.wasm_sha256,origin:target,reply:{...reply,model:Array.from(reply.model),measured_instructions:reply.measured_instructions.toString()}};
  const query_record=sha(JSON.stringify(record)),cache_key=sha(JSON.stringify({request,model,wasm:target.wasm_sha256})),path=`${OUT}/query-cache/${query_record}.json`;
  if(!existsSync(path))atomic(path,record);
  stats.max_tokens=Math.max(stats.max_tokens,reply.input_tokens);stats.max_instructions=stats.max_instructions>reply.measured_instructions?stats.max_instructions:reply.measured_instructions;
  return {selected,tokens:reply.input_tokens,instructions:reply.measured_instructions.toString(),scores:reply.probabilities,logits:reply.logits,model:Array.from(reply.model),cached:false,cache_key,query_record,call_id} as OracleReply;
 };
 return {choose,stats,target,close:()=>{globalThis.fetch=originalFetch;}};
}
