import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import {chromium} from 'playwright';
import {ROOT,OUT,read,atomic,sha,hashes} from './v2-common';
process.chdir(ROOT);const directory=`${OUT}/ui`;mkdirSync(directory,{recursive:true});
const approved=read(`${ROOT}/web/tetris/src/placement-v2-release.json`),bytes=readFileSync(`${ROOT}/web/tetris/public/tetris-value-v2.json`),candidate=JSON.parse(bytes.toString());candidate.alpha=.25;
const other=Buffer.from(JSON.stringify(candidate)+'\n'),corrupt=Buffer.from(bytes);corrupt[corrupt.indexOf(Buffer.from('"version":2'))+10]=51;
const browser=await chromium.launch({headless:true}),results=[];
try{
 for(const failure of ['missing','network','unapproved','corrupt','approved']){
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors:string[]=[],api:string[]=[];let modelRequests=0;
  page.on('pageerror',e=>errors.push(String(e)));await page.route('**/api/**',route=>{api.push(route.request().url());return route.abort();});
  if(failure!=='approved')await page.route('**/tetris-value-v2-manifest.json',route=>{
   if(failure==='network')return route.abort('failed');
   if(failure==='missing')return route.fulfill({status:404,body:'Unavailable'});
   const body=failure==='unapproved'?other:bytes;return route.fulfill({contentType:'application/json',body:JSON.stringify({sha256:sha(body),bytes:body.length})});
  });
  await page.route('**/tetris-value-v2.json',route=>{modelRequests++;return route.fulfill({contentType:'application/json',body:failure==='unapproved'?other:failure==='corrupt'?corrupt:bytes});});
  await page.goto(process.env.UI_URL||'http://127.0.0.1:5179/');
  const start=page.getByRole('button',{name:'Start game',exact:false});
  if(failure==='approved'){
   await page.waitForFunction(()=>!(document.querySelector('option[value="value-v2"]') as HTMLOptionElement)?.disabled);assert(await start.isEnabled());
  }else{
   await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').innerText(),/LightGBM v2 unavailable/);assert(await start.isDisabled());
   assert.equal(await page.locator('.play-actions').count(),0);if(failure==='unapproved')assert.equal(modelRequests,0);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.screenshot({path:`${directory}/release-guard-${failure}-390.png`,fullPage:true});
  }
  await page.getByText('Comparison mode & seed',{exact:true}).click();await page.getByLabel('Policy',{exact:true}).selectOption('1');
  if(failure!=='approved')await page.getByLabel('Browser assistance',{exact:true}).selectOption('fixed-cost');
  assert(await start.isEnabled());assert.equal(await page.getByRole('alert').count(),0);await start.click();await page.getByRole('button',{name:'Pause',exact:false}).click();
  await page.getByRole('button',{name:'Step once',exact:true}).click();await page.waitForFunction(()=>!(document.querySelector('.play-actions button') as HTMLButtonElement)?.disabled);
  await page.locator('.turn-details').getByText(failure==='approved'?'value-v2':'fixed-cost',{exact:true}).waitFor();
  if(failure==='approved')assert.equal(await page.locator('.model-hash').innerText(),approved.model_sha256);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);assert.equal(api.length,0);
  results.push({case:failure,passed:true,blocked_before_start:failure!=='approved',fallback_started:failure!=='approved',model_requests:modelRequests,canister_calls:api.length});await page.close();
 }
 atomic(`${directory}/release-guard-result.json`,{passed:true,browser:browser.version(),viewport:390,approved_asset_sha256:sha(bytes),cases:results,source_hashes:hashes(['web/tetris/src/main.tsx','web/tetris/src/placement-browser-v2.ts','web/tetris/scripts/v2-release-guard-ui.ts'])});console.log(results);
}finally{await browser.close();}
