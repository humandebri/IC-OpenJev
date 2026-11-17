import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {connectBrowserQuery,loadValueBundle} from './placement-browser-v2';
import {featureNames,type ValueBundle} from './placement-value-v2';
import release from './placement-v2-release.json';
vi.mock('./placement-v2-release.json',()=>({default:{adopted:true,model_sha256:'0'.repeat(64)}}));
const fixture=()=>{
 const bundle:ValueBundle={version:2,geometry:false,feature_names:featureNames(false),residual:{trees:[[[-1,12,0,0]]],link:'identity'},risk:{trees:[[[-1,0,0,0]]],link:'sigmoid'},alpha:.5,beta:0,horizon:32,metadata:{}};
 const bytes=new TextEncoder().encode(JSON.stringify(bundle)),hash=createHash('sha256').update(bytes).digest('hex');return {bundle,bytes,hash};
};
const assetFetch=(bytes:Uint8Array,hash:string)=>vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({sha256:hash,bytes:bytes.byteLength})}).mockResolvedValueOnce({ok:true,arrayBuffer:async()=>bytes.buffer});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it.each(['','invalid','A'.repeat(64)])('rejects malformed approval metadata: %j',async hash=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 await expect(loadValueBundle('/assets/',hash)).rejects.toThrow('Invalid approved release hash');expect(fetch).not.toHaveBeenCalled();
});
it.each(['v1 headers','v1 body','v2 headers','v2 body'])('bounds stalled %s and preserves unassisted play',async stalled=>{
 vi.useFakeTimers();const signals:AbortSignal[]=[];
 vi.stubGlobal('fetch',vi.fn(async(path:string,options:{signal:AbortSignal})=>{
  signals.push(options.signal);const version=path.includes('tetris-value')?'v2':'v1';
  if(version!==stalled.slice(0,2))return {ok:false};
  if(stalled.endsWith('headers'))return new Promise(()=>{});
  if(path.includes('manifest'))return {ok:true,json:async()=>({sha256:release.model_sha256,bytes:1})};
  return {ok:true,arrayBuffer:()=>new Promise(()=>{})};
 }));
 const pending=connectBrowserQuery('http://localhost','',100);
 await vi.advanceTimersByTimeAsync(100);const client=await pending;
 expect(client.availabilityError(stalled.startsWith('v1')?'learned':'value-v2')).toContain('timed out');
 expect(signals.every(signal=>signal.aborted)).toBe(true);expect(vi.getTimerCount()).toBe(0);
 const game=client.start(184,1,'fixed-cost');expect((await client.step(game)).query_count).toBe(0);
});
it('rejects a self-consistent candidate manifest that differs from the adopted release',async()=>{
 const {bytes,hash}=fixture();expect(hash).not.toBe(release.model_sha256);const fetch=assetFetch(bytes,hash);vi.stubGlobal('fetch',fetch);
 await expect(loadValueBundle('/assets/')).rejects.toThrow('approved release');expect(fetch).toHaveBeenCalledTimes(1);
});
it('loads the approved bytes and permits an explicitly experimental bundle without adoption',async()=>{
 const {bytes,hash,bundle}=fixture();vi.stubGlobal('fetch',assetFetch(bytes,hash));expect(await loadValueBundle('/assets/',hash)).toEqual({bundle,hash});
 vi.stubGlobal('fetch',assetFetch(bytes,hash));expect(await loadValueBundle('/assets/',null)).toEqual({bundle,hash});
});
it('still rejects changed model bytes even when the manifest names the approved hash',async()=>{
 const {bytes,hash}=fixture(),changed=new TextEncoder().encode(new TextDecoder().decode(bytes).replace('12','13'));vi.stubGlobal('fetch',assetFetch(changed,hash));
 await expect(loadValueBundle('/assets/',hash)).rejects.toThrow('hash mismatch');
});
it.each(['missing','network','unapproved'] as const)('blocks unavailable default play before a query: %s',async failure=>{
 const fetch=vi.fn(async(path:string)=>{
  if(path.includes('tetris-evaluator-manifest'))return {ok:false};
  if(failure==='network')throw new Error('offline');
  if(failure==='unapproved')return {ok:true,json:async()=>({sha256:fixture().hash,bytes:fixture().bytes.length})};
  return {ok:false};
 });vi.stubGlobal('fetch',fetch);
 const client=await connectBrowserQuery('http://localhost','');expect(client.availability.v2).toBe(false);expect(client.availabilityError('value-v2')).toContain('LightGBM v2 unavailable');
 expect(()=>client.start(184,0,'value-v2')).toThrow('LightGBM v2 unavailable');
 await expect(client.step({id:0,seed:184,mode:0,policy:'value-v2',board:Array(200).fill(0),turn:0,lines:0,over:false})).rejects.toThrow('LightGBM v2 unavailable');
 expect(fetch.mock.calls).toHaveLength(2);
 const game=client.start(184,1,'fixed-cost');expect(client.availabilityError('fixed-cost')).toBeNull();expect((await client.step(game)).query_count).toBe(0);
});
