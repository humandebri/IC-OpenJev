import { describe,it,expect } from 'vitest';
import { validateReply, type Reply, type Info } from './client';
import { ModelChangedError } from '../model';
const info:Info={model:Array(32).fill(1),base_model:Array(32).fill(2),ready:true,validated:false,max_tokens:64,runtime:'local'};
const reply=():Reply=>({model:[...info.model],base_model:[...info.base_model],input_tokens:12,elapsed_ms:42,result:{queue:{labels:['account','device','network','review'],selected:'account',probabilities:[.9,.05,.03,.02]},priority:{labels:['low','normal','high'],selected:'normal',probabilities:[.05,.9,.05]},decision:'review',review_reasons:['validation_failed']}});
describe('IT routing response contract',()=>{
 it('retains the candidate while requiring a human for an unvalidated head',()=>{const r=validateReply(reply(),info);expect(r.result.queue.selected).toBe('account');expect(r.result.decision).toBe('review');});
 it('rejects an automatic destination from an unvalidated head',()=>{const r=reply();r.result.decision='account';r.result.review_reasons=[];expect(()=>validateReply(r,info)).toThrow('Invalid routing decision');});
 it('invalidates results when either the routing head or encoder changes',()=>{for(const field of ['model','base_model'] as const){const r=reply();r[field]=Array(32).fill(3);expect(()=>validateReply(r,info)).toThrow(ModelChangedError);}});
 it('rejects invalid labels, score distributions and token counts',()=>{const a=reply();a.result.queue.probabilities=[1,1,1,1];expect(()=>validateReply(a,info)).toThrow();const b=reply();b.result.priority.labels.reverse();expect(()=>validateReply(b,info)).toThrow();const c=reply();c.input_tokens=65;expect(()=>validateReply(c,info)).toThrow();});
 it('requires a real instruction measurement for canister responses',()=>{expect(()=>validateReply(reply(),{...info,runtime:undefined,target_instructions:4_500_000_000n})).toThrow();const r=reply();r.measured_instructions=1_000_000n;expect(()=>validateReply(r,{...info,runtime:undefined,target_instructions:4_500_000_000n})).not.toThrow();});
});
