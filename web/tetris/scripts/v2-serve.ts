import {spawn} from 'node:child_process';
import {ROOT,read} from './v2-common';
const target=read(`${ROOT}/artifacts/tetris-search/local-target.json`),port=Number(process.argv[2]||5178);
if(!['localhost','127.0.0.1','[::1]'].includes(new URL(target.host).hostname)||!Number.isInteger(port)||port<1||port>65535)throw new Error('Expected a local PocketIC target and a valid localhost port');
const child=spawn(process.execPath,[`${ROOT}/web/tetris/node_modules/vite/bin/vite.js`,'--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:`${ROOT}/web/tetris`,env:{...process.env,VITE_IC_HOST:target.host,VITE_CANISTER_ID:target.canister},stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>child.kill(signal));
await new Promise<void>((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>{process.exitCode=code??1;resolve();});});
