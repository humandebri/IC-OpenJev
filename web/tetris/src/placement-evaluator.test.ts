import {afterEach,expect,it,vi} from 'vitest';
import {loadBrowserEvaluator} from './placement-evaluator';
afterEach(()=>vi.unstubAllGlobals());
it('refuses a changed evaluator asset before using its predictions',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({sha256:'0'.repeat(64)})})
  .mockResolvedValueOnce({ok:true,arrayBuffer:async()=>new TextEncoder().encode('{"changed":true}').buffer});
 vi.stubGlobal('fetch',fetch);
 await expect(loadBrowserEvaluator('/assets/')).rejects.toThrow('Evaluator hash mismatch');
 expect(fetch.mock.calls.map(([path])=>path)).toEqual(['/assets/tetris-evaluator-manifest.json','/assets/tetris-evaluator.json']);
});
it('reports unavailable evaluator assets without requesting a model decision',async()=>{
 const fetch=vi.fn().mockResolvedValue({ok:false});vi.stubGlobal('fetch',fetch);
 await expect(loadBrowserEvaluator('/')).rejects.toThrow('Evaluator manifest unavailable');
 expect(fetch).toHaveBeenCalledTimes(1);
});
