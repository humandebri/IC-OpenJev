import {existsSync,readFileSync} from 'node:fs';
import {connectQuery,validateReply,type ModelReply} from '../src/placement-query-api';
import {ROOT,OUT,sha,atomic,read} from './v2-common';
import type {OracleReply,Request} from './v2-oracle';
export async function realOracle(){
 const target=read(`${ROOT}/artifacts/tetris-search/local-target.json`),client=await connectQuery(target.host,target.canister),status=await client.status();
 const model='0757d774c8c44397d189c5b479853897acef8f1e2b55ebf1f5a46969063225e0';
 if(!status.enabled||Buffer.from(status.model).toString('hex')!==model||target.wasm_sha256!==sha(readFileSync(`${ROOT}/build/compat-model-query/verdict-engine.wasm`)))throw new Error('Fixed query target mismatch');
 atomic(`${OUT}/local-target.json`,target);
 const pending=new Map<string,Promise<OracleReply>>();const stats={actual:0,cached:0,max_tokens:0,max_instructions:0n};
 const fetch=globalThis.fetch;globalThis.fetch=(...args)=>{const url=String(args[0] instanceof Request?args[0].url:args[0]);if(/\/call(?:\?|$)/.test(url))throw new Error('Updates forbidden');return fetch(...args);};
 const choose=async(request:Request):Promise<OracleReply>=>{
  const key=sha(JSON.stringify({request,model,wasm:target.wasm_sha256}));
  const saved=pending.get(key);if(saved){stats.cached++;return {...await saved,cached:true};}
  const work=(async()=>{
   const path=`${OUT}/query-cache/${key}.json`,cached=existsSync(path);
   const record=cached?read(path):null;
   const reply:ModelReply=cached?{...record.reply,measured_instructions:BigInt(record.reply.measured_instructions)}:await client.query(request);
   const selected=validateReply(reply,request,status);
   if(reply.input_tokens>41||reply.measured_instructions<=0n)throw new Error('Query budget/provenance failure');
   if(!cached){atomic(path,{request,model,wasm:target.wasm_sha256,origin:target,reply:{...reply,model:Array.from(reply.model),measured_instructions:reply.measured_instructions.toString()}});stats.actual++;}else stats.cached++;
   stats.max_tokens=Math.max(stats.max_tokens,reply.input_tokens);stats.max_instructions=stats.max_instructions>reply.measured_instructions?stats.max_instructions:reply.measured_instructions;
   return {selected,tokens:reply.input_tokens,instructions:reply.measured_instructions.toString(),scores:reply.probabilities,logits:reply.logits,model:Array.from(reply.model),cached,cache_key:key};
  })();pending.set(key,work);try{return await work;}catch(error){pending.delete(key);throw error;}
 };
 return {choose,stats,target,close:()=>{globalThis.fetch=fetch;}};
}
