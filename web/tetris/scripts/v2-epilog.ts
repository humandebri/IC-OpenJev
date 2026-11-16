import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,openSync,closeSync,readFileSync,readdirSync} from 'node:fs';
import {chromium} from 'playwright';
import {ROOT,OUT,read,atomic,sha,now} from './v2-common';
process.chdir(ROOT);
while(!existsSync(`${OUT}/test-report.json`)||!existsSync(`${OUT}/ui/tests-build.json`)){
 if(now()>=read(`${OUT}/budget.json`).overall_deadline_ms)throw new Error('Budget exhausted before completed gates');await new Promise(r=>setTimeout(r,2000));
}
async function run(args:string[],label:string,cwd=ROOT){
 const fd=openSync(`${OUT}/${label}.log`,'a');
 try{await new Promise<void>((resolve,reject)=>{const c=spawn(process.execPath,args,{cwd,stdio:['ignore',fd,fd]});c.on('error',reject);c.on('exit',code=>code===0?resolve():reject(new Error(`${label}: ${code}`)));});}finally{closeSync(fd);}
 console.log(`DONE ${label}`);
}
const node=(script:string)=>['--import',`${ROOT}/web/tetris/node_modules/tsx/dist/loader.mjs`,`${ROOT}/web/tetris/scripts/${script}`];
await run(node('v2-adopt.ts'),'adoption');
const release=read(`${ROOT}/web/tetris/src/placement-v2-release.json`),browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}});await page.goto('http://127.0.0.1:5178/');await page.waitForFunction(()=>!(document.querySelector('option[value="value-v2"]') as HTMLOptionElement)?.disabled);await page.getByText('Comparison mode & seed',{exact:true}).click();
 assert.equal(await page.getByLabel('Browser assistance',{exact:true}).inputValue(),release.default_policy);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:`${OUT}/ui/default-390.png`,fullPage:true});atomic(`${OUT}/ui/default-policy.json`,{passed:true,default_policy:release.default_policy,adopted:release.adopted,release_sha256:sha(readFileSync(`${ROOT}/web/tetris/src/placement-v2-release.json`))});
}finally{await browser.close();}
await run(['node_modules/typescript/bin/tsc','--noEmit'],'final-typecheck',`${ROOT}/web/tetris`);
await run(['node_modules/vite/bin/vite.js','build'],'final-build',`${ROOT}/web/tetris`);
await run(node('v2-document-results.ts'),'document-results');
const files=readdirSync(OUT).filter(name=>name.endsWith('.json')&&!name.includes('local-target')&&name!=='summary-sources.json');
atomic(`${OUT}/summary-sources.json`,{files:files.sort().map(path=>({path,sha256:sha(readFileSync(`${OUT}/${path}`))})),public_bundle:read(`${ROOT}/web/tetris/public/tetris-value-v2-manifest.json`),release_sha256:sha(readFileSync(`${ROOT}/web/tetris/src/placement-v2-release.json`)),documentation_sha256:sha(readFileSync(`${ROOT}/docs/TETRIS_LIGHTGBM_V2.md`)),source_sha256:sha(readFileSync(import.meta.filename))});
console.log({complete:true,adopted:release.adopted,default_policy:release.default_policy});
