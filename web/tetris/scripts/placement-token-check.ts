import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
process.chdir(fileURLToPath(new URL('../../../',import.meta.url)));
const p=spawn('target/release/tetris_probe',['.']);
const lines=createInterface({input:p.stdout});const queue:((line:string)=>void)[]=[];
lines.on('line',line=>queue.shift()!(line));
const check=(labels:string[])=>new Promise<number>((resolve,reject)=>{
 queue.push(line=>resolve(JSON.parse(line).tokens));p.stdin.write(JSON.stringify({text:'Min holes',labels})+'\n');
});
const labels=['min','mid','max','equal'].flatMap(a=>['min','mid','max','equal'].flatMap(b=>['min','mid','max','equal'].map(c=>`${a} holes,${b} height,${c} missed`)));
let longest=labels[0],maxSingle=0;
for(const label of labels){const n=await check([label]);if(n>maxSingle){maxSingle=n;longest=label;}}
let maxTokens=0,checks=0;
for(let count=1;count<=4;count++)for(let at=0;at<count;at++)for(const label of labels){
 const options=Array(count).fill(longest);options[at]=label;maxTokens=Math.max(maxTokens,await check(options));checks++;
}
p.stdin.end();if(maxTokens>41)throw new Error(`Token bound exceeded: ${maxTokens}`);
writeFileSync('artifacts/tetris-search/token-check.json',JSON.stringify({labels:labels.length,checks,max_tokens:maxTokens,longest_label:longest,format_unchanged:true},null,2)+'\n');console.log({checks,maxTokens});
