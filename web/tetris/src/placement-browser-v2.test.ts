import {expect,it,vi} from 'vitest';
import {chooseAssisted,prepareAssisted,FROZEN_JEV,type Game} from './placement-browser-v2';
import {featureNames,type ValueBundle} from './placement-value-v2';
import {landed,pieceAt} from './placement-local';
const game=():Game=>({id:0,seed:184,mode:0,board:Array(200).fill(0),turn:0,lines:0,over:false,policy:'fixed-cost'});
const status={enabled:true,warmed:true,model:Array.from(Buffer.from(FROZEN_JEV,'hex')),max_tokens:41};
const reply=(selected:number,count:number)=>({ids:Array.from({length:count},(_,i)=>String(i)),selected:String(selected),model:status.model,probabilities:Array.from({length:count},(_,i)=>i===selected?1:0),logits:Array.from({length:count},(_,i)=>i===selected?1:0),confidence:1,input_tokens:20,measured_instructions:1n});
it('uses Jev selection even when it differs from the evaluator, with one query and immutable input',async()=>{
 const g=game(),before=structuredClone(g),prepared=prepareAssisted(g),selected=1-prepared.recommended,query=vi.fn(async()=>reply(selected,2));
 const result=await chooseAssisted(g,status,query);expect(query).toHaveBeenCalledTimes(1);expect(result.selected).toBe(selected);expect(result.after).toEqual(landed(g.board,pieceAt(g.seed,0),prepared.candidates[selected].cells).board);expect(g).toEqual(before);expect(result.model_request?.state).toBe('Min cost');expect(result.candidates).toHaveLength(2);
});
it('keeps the board on failed and invalid queries',async()=>{
 const g=game(),before=structuredClone(g);
 await expect(chooseAssisted(g,status,async()=>{throw new Error('offline');})).rejects.toThrow('offline');
 await expect(chooseAssisted(g,status,async()=>reply(2,2))).rejects.toThrow('Invalid model response');expect(g).toEqual(before);
});
it('rejects changed Jev weights before querying or applying a move',async()=>{
 const g=game(),before=structuredClone(g),query=vi.fn();await expect(chooseAssisted(g,{...status,model:Array(32).fill(0)},query)).rejects.toThrow('frozen Jev');expect(query).not.toHaveBeenCalled();expect(g).toEqual(before);
});
it('queries Jev for a single remaining placement even when every placement blocks NEXT',async()=>{
 const board=Array(200).fill(1);for(let y=0;y<20;y++)board[y*10]=0;for(const i of [4,5,14,15])board[i]=0;
 const seed=Array.from({length:100},(_,i)=>i+1).find(s=>pieceAt(s,0)===1)!,g={...game(),seed,board};
 expect(prepareAssisted(g).candidates).toHaveLength(1);const query=vi.fn(async()=>reply(0,1));
 const result=await chooseAssisted(g,status,query);expect(query).toHaveBeenCalledTimes(1);expect(result.over).toBe(true);expect(result.query_count).toBe(1);
});
it('evaluator-only mode has no query and stops at the normal 128-turn cap',async()=>{
 const g={...game(),mode:1,turn:127},query=vi.fn();const result=await chooseAssisted(g,status,query);expect(result.over).toBe(true);expect(query).not.toHaveBeenCalled();expect(result.query_count).toBe(0);
});
it('v2 zero coefficients reproduce the browser fixed top-two choices and costs',()=>{
 const leaf={trees:[[[-1,12,0,0]]],link:'identity' as const};const bundle:ValueBundle={version:2,geometry:true,feature_names:featureNames(true),residual:leaf,risk:{...leaf,link:'sigmoid'},alpha:0,beta:0,horizon:32,metadata:{}};
 const g=game(),base=prepareAssisted(g),v2=prepareAssisted({...g,policy:'value-v2'},{bundle,hash:'test'});expect(v2.request).toEqual(base.request);expect(v2.candidates.map(c=>c.pose)).toEqual(base.candidates.map(c=>c.pose));
});
