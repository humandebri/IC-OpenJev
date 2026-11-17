import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import {chromium} from 'playwright';
import {ROOT,OUT,read,atomic,sha,hashes} from './v2-common';
import {POLICY_NAMES} from '../src/placement-policy-ui';
process.chdir(ROOT);const directory=`${OUT}/ui`;mkdirSync(directory,{recursive:true});
const approved=read(`${ROOT}/web/tetris/src/placement-v2-release.json`),bytes=readFileSync(`${ROOT}/web/tetris/public/tetris-value-v2.json`),candidate=JSON.parse(bytes.toString());candidate.alpha=.25;
const other=Buffer.from(JSON.stringify(candidate)+'\n'),corrupt=Buffer.from(bytes);corrupt[corrupt.indexOf(Buffer.from('"version":2'))+10]=51;
const browser=await chromium.launch({headless:true}),results=[];
try{
 for(const failure of ['missing','network','stalled','unapproved','corrupt','approved']){
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors:string[]=[],api:string[]=[];let modelRequests=0;
  page.on('pageerror',e=>errors.push(String(e)));await page.route('**/api/**',route=>{api.push(route.request().url());return route.abort();});
  if(failure==='stalled')await page.clock.install();
  let stalledRequest:()=>void=()=>{};const stalledStarted=new Promise<void>(resolve=>{stalledRequest=resolve;});
  if(failure!=='approved')await page.route('**/tetris-value-v2-manifest.json',route=>{
   if(failure==='stalled'){stalledRequest();return;}
   if(failure==='network')return route.abort('failed');
   if(failure==='missing')return route.fulfill({status:404,body:'Unavailable'});
   const body=failure==='unapproved'?other:bytes;return route.fulfill({contentType:'application/json',body:JSON.stringify({sha256:sha(body),bytes:body.length})});
  });
  await page.route('**/tetris-value-v2.json',route=>{modelRequests++;return route.fulfill({contentType:'application/json',body:failure==='unapproved'?other:failure==='corrupt'?corrupt:bytes});});
  await page.goto(process.env.UI_URL||'http://127.0.0.1:5179/');
  if(failure==='stalled'){await stalledStarted;await page.clock.fastForward(30_000);}
  const start=page.getByRole('button',{name:'Start game',exact:false});
  if(failure==='approved'){
   await page.waitForFunction(()=>!(document.querySelector('.primary') as HTMLButtonElement)?.disabled);assert(await start.isEnabled());
  }else{
   await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').innerText(),/LightGBM v2 unavailable/);assert(await start.isDisabled());
   assert.equal(await page.locator('.secondary').count(),0);if(failure==='unapproved')assert.equal(modelRequests,0);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.screenshot({path:`${directory}/release-guard-${failure}-390.png`,fullPage:true});
  }
  await page.getByText('Settings',{exact:true}).click();await page.getByRole('radio',{name:'Evaluator only',exact:true}).click();
  if(failure!=='approved'){
   assert(await start.isDisabled());assert.match(await page.getByRole('alert').innerText(),/Reload the page/);assert.equal(await page.getByLabel('Shortlist',{exact:true}).count(),0);assert.deepEqual(errors,[]);assert.equal(api.length,0);
   results.push({case:failure,passed:true,blocked_before_start:true,fallback_started:false,model_requests:modelRequests,canister_calls:api.length});await page.close();continue;
  }
  assert(await start.isEnabled());assert.equal(await page.getByRole('alert').count(),0);await start.click();await page.getByRole('button',{name:'Pause',exact:false}).click();
  await page.getByRole('button',{name:'Step once',exact:true}).click();await page.waitForFunction(()=>!(document.querySelector('.secondary button') as HTMLButtonElement)?.disabled);
  await page.locator('.pipeline').getByText(new RegExp(`^${failure==='approved'?'LightGBM v2':'Fixed search'} ·`)).waitFor();
  if(failure==='approved'){await page.getByText('Verify this run',{exact:true}).click();assert.equal(await page.locator('.model-hash').innerText(),approved.model_sha256);}
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);assert.equal(api.length,0);
  results.push({case:failure,passed:true,blocked_before_start:failure!=='approved',fallback_started:failure!=='approved',model_requests:modelRequests,canister_calls:api.length});await page.close();
 }
 for(const policy of ['lookahead','legacy','learned'] as const){
  const page=await browser.newPage({viewport:{width:390,height:844}}),api:string[]=[],errors:string[]=[];
  let modelRequests=0;page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/tetris-value-v2.json'))modelRequests++;});
  page.on('pageerror',e=>errors.push(String(e)));await page.route('**/api/**',route=>{api.push(route.request().url());return route.abort();});
  await page.route('**/src/placement-v2-release.json*',route=>route.fulfill({contentType:'application/javascript',body:`export default ${JSON.stringify({...approved,adopted:false,default_policy:policy})};`}));
  await page.goto(process.env.UI_URL||'http://127.0.0.1:5179/');await page.getByText('Settings',{exact:true}).click();
  assert.equal(await page.getByLabel('Shortlist',{exact:true}).count(),0);assert((await page.locator('.pipeline').innerText()).includes(`${POLICY_NAMES[policy]} shortlists`));
  await page.getByRole('radio',{name:'Evaluator only',exact:true}).click();await page.getByRole('button',{name:'Start game',exact:false}).click();await page.getByRole('button',{name:'Pause',exact:false}).click();
  await page.getByRole('button',{name:'Step once',exact:true}).click();await page.waitForFunction(()=>!(document.querySelector('.secondary button') as HTMLButtonElement)?.disabled);
  await page.locator('.pipeline').getByText(new RegExp(`^${POLICY_NAMES[policy]} ·`)).waitFor();
  const labels=await page.locator('.option .cost').allTextContents();assert(labels.length>=1&&labels.length<=4);assert(labels.every(text=>text.includes('holes,')&&!text.startsWith('cost ')));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);assert.equal(api.length,0);
  await page.screenshot({path:`${directory}/release-fallback-${policy}-390.png`,fullPage:true});results.push({case:`fallback-${policy}`,passed:true,blocked_before_start:false,fallback_started:true,model_requests:modelRequests,canister_calls:api.length});await page.close();
 }
 atomic(`${directory}/release-guard-result.json`,{passed:true,browser:browser.version(),viewport:390,approved_asset_sha256:sha(bytes),cases:results,source_hashes:hashes(['web/tetris/src/main.tsx','web/tetris/src/placement-policy-ui.ts','web/tetris/src/placement-browser-v2.ts','web/tetris/scripts/v2-release-guard-ui.ts'])});console.log(results);
}finally{await browser.close();}
