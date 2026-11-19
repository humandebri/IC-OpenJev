import { Actor, HttpAgent } from '@icp-sdk/core/agent';
import { IDL } from '@icp-sdk/core/candid';
import { CANISTER, HOST, ModelChangedError } from '../model';
export const queues = { account: 'アカウント・権限', device: '端末・ソフトウェア', network: 'ネットワーク・VPN', review: '要確認' } as const;
export const priorities = { low: '低', normal: '通常', high: '高' } as const;
export type Queue = keyof typeof queues;
export type Classification = { selected: string; labels: string[]; probabilities: number[] };
export type Info = { model: Uint8Array | number[]; base_model: Uint8Array | number[]; ready: boolean; validated: boolean; max_tokens: number; target_instructions?: bigint; runtime?: 'local' };
export type Reply = { model: Uint8Array | number[]; base_model: Uint8Array | number[]; input_tokens: number; measured_instructions?: bigint; elapsed_ms?: number;
  result: { queue: Classification; priority: Classification; decision: string; review_reasons: string[] } };
export function validateReply(reply: Reply, info: Info): Reply {
  for (const [value, labels] of [[reply.result.queue, Object.keys(queues)], [reply.result.priority, Object.keys(priorities)]] as const) {
    const selected = labels.indexOf(value.selected);
    if (selected < 0 || value.labels.length !== labels.length || value.labels.some((x,i)=>x!==labels[i]) || value.probabilities.length !== labels.length
      || value.probabilities.some(x=>!Number.isFinite(x)||x<0||x>1) || Math.abs(value.probabilities.reduce((a,b)=>a+b,0)-1)>.001
      || value.probabilities.some((p,i)=>p>value.probabilities[selected]||(p===value.probabilities[selected]&&i<selected))) throw new Error('Invalid routing response');
  }
  const same = (a: Uint8Array | number[], b: Uint8Array | number[]) => a.length===32 && b.length===32 && Array.from(a).every((x,i)=>Number.isInteger(x)&&x>=0&&x<=255&&x===b[i]);
  if (!same(reply.model,info.model)||!same(reply.base_model,info.base_model)) throw new ModelChangedError();
  if (!Number.isInteger(reply.input_tokens)||reply.input_tokens<2||reply.input_tokens>info.max_tokens) throw new Error('Invalid routing response');
  const reasons = ['outside_scope','uncertain_queue','uncertain_priority','validation_failed'];
  if (!Array.isArray(reply.result.review_reasons)||reply.result.review_reasons.some(r=>!reasons.includes(r))
    || !Object.keys(queues).includes(reply.result.decision)
    || ((!info.validated || reply.result.queue.selected==='review' || reply.result.review_reasons.length>0) && reply.result.decision!=='review')
    || (reply.result.decision!=='review' && reply.result.decision!==reply.result.queue.selected)) throw new Error('Invalid routing decision');
  if (info.runtime==='local') {
    if (typeof reply.elapsed_ms !== 'number'||!Number.isFinite(reply.elapsed_ms)||reply.elapsed_ms<0) throw new Error('Invalid routing response');
  } else if (typeof reply.measured_instructions!=='bigint'||reply.measured_instructions<0n||!info.target_instructions||reply.measured_instructions>info.target_instructions) throw new Error('Invalid routing response');
  return reply;
}
const classification=IDL.Record({selected:IDL.Text,labels:IDL.Vec(IDL.Text),probabilities:IDL.Vec(IDL.Float32)});
const errors=IDL.Variant({...Object.fromEntries(['Unauthorized','Storage','Capacity','Numeric','TooLong','Transition','BindingMismatch','NonceGap','IdConflict','Expired','NotFound','Uncalibrated','Busy','NonceConsumed','OperationUsed','Budget','Stale','ReportOnly','LiveDisabled','OutcomeUnknown'].map(k=>[k,IDL.Null])),Invalid:IDL.Text,Denied:IDL.Text,ModelUnavailable:IDL.Text});
const idl=()=>IDL.Service({
  it_routing_info:IDL.Func([],[IDL.Record({model:IDL.Vec(IDL.Nat8),base_model:IDL.Vec(IDL.Nat8),ready:IDL.Bool,validated:IDL.Bool,max_tokens:IDL.Nat32,target_instructions:IDL.Nat64})],['query']),
  route_it_ticket:IDL.Func([IDL.Text],[IDL.Variant({Ok:IDL.Record({model:IDL.Vec(IDL.Nat8),base_model:IDL.Vec(IDL.Nat8),input_tokens:IDL.Nat32,measured_instructions:IDL.Nat64,result:IDL.Record({queue:classification,priority:classification,decision:IDL.Text,review_reasons:IDL.Vec(IDL.Text)})}),Err:errors})],['query']),
});
export async function connect(local=false) {
  let info: Info;
  let classify:(text:string)=>Promise<Reply>;
  if(local){
    const response=await fetch('/api/it-routing/info');if(!response.ok)throw new Error('Local routing API unavailable');info=await response.json();info.runtime='local';
    classify=async text=>{const response=await fetch('/api/it-routing/classify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});const value=await response.json();if(!response.ok)throw new Error(value.error||'Routing failed');return value;};
  } else {
    const agent=await HttpAgent.create({host:HOST});
    const actor=Actor.createActor<{it_routing_info:()=>Promise<Info>;route_it_ticket:(text:string)=>Promise<{Ok:Reply}|{Err:unknown}>}>(idl,{agent,canisterId:CANISTER});
    info=await actor.it_routing_info();
    classify=async text=>{const response=await actor.route_it_ticket(text);if('Err'in response)throw new Error(`Routing failed: ${JSON.stringify(response.Err)}`);return response.Ok;};
  }
  if(!info.ready||info.model.length!==32||info.base_model.length!==32||!Number.isInteger(info.max_tokens)||info.max_tokens<2)throw new Error('Routing model unavailable');
  return {info,async classify(text:string){return validateReply(await classify(text),info);}};
}
