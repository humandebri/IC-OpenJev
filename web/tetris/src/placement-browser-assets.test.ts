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
afterEach(()=>vi.unstubAllGlobals());
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
