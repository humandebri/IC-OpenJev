import {expect,it} from 'vitest';
import {releasePolicy,optionLabels} from './placement-policy-ui';
import {choosePlacement} from './placement-query-api';
import {decisionRequest} from './placement-local';
it.each(['legacy','lookahead','learned','fixed-cost'] as const)('retains the configured non-v2 release policy: %s',policy=>{
 expect(releasePolicy({adopted:false,default_policy:policy},{default_policy:'legacy'})).toBe(policy);
});
it('uses the approved default and preserves the previous release when v2 is unapproved',()=>{
 expect(releasePolicy({adopted:true,default_policy:'value-v2'},{default_policy:'lookahead'})).toBe('value-v2');
 expect(releasePolicy({adopted:false,default_policy:'value-v2'},{default_policy:'lookahead'})).toBe('lookahead');
 expect(releasePolicy({adopted:false},{default_policy:'lookahead'})).toBe('lookahead');
});
it.each(['legacy','lookahead'] as const)('keeps the actual three-feature labels for %s',async policy=>{
 const game={id:0,seed:184,turn:0,mode:1,lines:0,board:Array(200).fill(0),over:false,policy};
 const result=await choosePlacement(game,{enabled:false,warmed:false,model:[],max_tokens:0},async()=>{throw new Error('Unexpected query');});
 const labels=optionLabels(result);expect(labels).toHaveLength(result.candidates.length);expect(labels.every(label=>label.includes('holes,')&&!label.startsWith('cost '))).toBe(true);
 if(policy==='legacy')expect(labels).toEqual(decisionRequest(result.candidates).options.map(option=>option.text));
 const request={question:'',state:'test',abstention:false,temperature:1,options:labels.map((text,i)=>({id:String(i),text}))};
 expect(optionLabels({...result,model_request:request})).toEqual(labels);
});
