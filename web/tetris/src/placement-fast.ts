// Occupancy-only reference-equivalent physics. No animation paths or hidden pieces.
import {shapes} from './placement-local';
export type MaskBoard=Uint16Array;
export type FastPlacement={r:number;x:number;y:number;key:number;board:MaskBoard;lines:number;holes:number;height:number;value:number};
export type FastChoice=FastPlacement&{next:FastPlacement|null;total_lines:number;base:number;score:number;safe:boolean};
const FULL=1023;
export const POP=Uint8Array.from({length:1024},(_,i)=>{let n=0;for(;i;i&=i-1)n++;return n;});
const ROT=Array.from({length:7},(_,p)=>shapes(p).map(cells=>{
 const width=Math.max(...cells.map(c=>c[0]))+1,height=Math.max(...cells.map(c=>c[1]))+1;
 const rows=Array(height).fill(0);for(const [x,y] of cells)rows[y]|=1<<x;
 return {width,height,rows,cells};
}));
export function masks(board:readonly number[]):MaskBoard{
 if(board.length!==200)throw new Error('Invalid board');
 const out=new Uint16Array(20);for(let i=0;i<200;i++)if(board[i])out[Math.floor(i/10)]|=1<<(i%10);return out;
}
export function expand(board:ArrayLike<number>):number[]{return Array.from({length:200},(_,i)=>Number(!!(board[Math.floor(i/10)]&(1<<(i%10)))));}
export function maskFeatures(board:ArrayLike<number>){
 let covered=0,holes=0,height=0;
 for(let y=0;y<20;y++){const row=board[y];if(row&&!height)height=20-y;covered|=row;holes+=POP[covered&~row&FULL];}
 return {holes,height};
}
export function lock(board:MaskBoard,piece:number,r:number,x:number,y:number):FastPlacement{
 const out=new Uint16Array(board),rotation=ROT[piece][r];
 for(let i=0;i<rotation.height;i++)out[y+i]|=rotation.rows[i]<<x;
 let kept=19,lines=0;
 for(let at=19;at>=0;at--)if(out[at]===FULL)lines++;else out[kept--]=out[at];
 while(kept>=0)out[kept--]=0;
 const f=maskFeatures(out);
 return {r,x,y,key:r*200+x*20+y,board:out,lines,...f,value:10*lines-8*f.holes-f.height};
}
// Rotation, left, right, down; legal states exactly match the browser BFS.
function walk(board:MaskBoard,piece:number,bestOnly:boolean):FastPlacement[]{
 const rotations=ROT[piece];if(!rotations)throw new Error('Invalid piece');
 const fits=(r:number,x:number,y:number)=>{
  const s=rotations[r];if(x<0||x+s.width>10||y<0||y+s.height>20)return false;
  for(let i=0;i<s.height;i++)if(board[y+i]&(s.rows[i]<<x))return false;return true;
 };
 const start=Math.floor((10-rotations[0].width)/2);if(!fits(0,start,0))return [];
 const queue=new Uint16Array(800),seen=new Uint8Array(800);let head=0,tail=0;
 const add=(r:number,x:number,y:number)=>{if(!fits(r,x,y))return;const k=r*200+y*10+x;if(!seen[k]){seen[k]=1;queue[tail++]=k;}};
 add(0,start,0);const result:FastPlacement[]=[];let best:FastPlacement|undefined;
 while(head<tail){
  const k=queue[head++],r=Math.floor(k/200),y=Math.floor(k%200/10),x=k%10;
  if(!fits(r,x,y+1)){
   const c=lock(board,piece,r,x,y);
   if(bestOnly){if(!best||c.value>best.value||(c.value===best.value&&c.key<best.key))best=c;}else result.push(c);
  }
  add((r+1)%rotations.length,x,y);add(r,x-1,y);add(r,x+1,y);add(r,x,y+1);
 }
 return bestOnly?(best?[best]:[]):result.sort((a,b)=>a.key-b.key);
}
export const fastPlacements=(board:MaskBoard,piece:number)=>walk(board,piece,false);
export const fastBest=(board:MaskBoard,piece:number)=>walk(board,piece,true)[0]??null;
export function hashBoard(board:MaskBoard,piece=0,next=0){
 let h=(2166136261^piece^next<<4)>>>0;for(let y=0;y<20;y++)h=Math.imul(h^board[y],16777619)>>>0;return h;
}
export const sameBoard=(a:MaskBoard,b:MaskBoard)=>a.every((v,i)=>v===b[i]);
export function fastChoices(board:MaskBoard,piece:number,next:number):FastChoice[]{
 const buckets=new Map<number,MaskBoard[]>(),choices:FastChoice[]=[];
 for(const c of fastPlacements(board,piece)){
  const hash=hashBoard(c.board),bucket=buckets.get(hash)??[];if(bucket.some(b=>sameBoard(b,c.board)))continue;
  bucket.push(c.board);buckets.set(hash,bucket);
  const response=fastBest(c.board,next),total_lines=c.lines+(response?.lines??0),base=response?-8*response.holes-response.height:-8*c.holes-c.height;
  choices.push({...c,next:response,total_lines,base,score:10*total_lines+base,safe:!!response});
 }
 return choices.some(c=>c.safe)?choices.filter(c=>c.safe):choices;
}
export function bestChoice(choices:FastChoice[]):FastChoice|null{return choices.reduce<FastChoice|null>((a,b)=>!a||b.score>a.score?b:a,null);}
// Bounded collision-checked memoization affects speed only, never the policy.
export class Teacher {
 private cache=new Map<number,{board:MaskBoard;piece:number;next:number;choice:FastChoice|null}[]>();private size=0;
 hits=0;misses=0;
 constructor(private limit=12000){}
 choose(board:MaskBoard,piece:number,next:number){
  const key=hashBoard(board,piece,next),bucket=this.cache.get(key);
  const match=bucket?.find(v=>v.piece===piece&&v.next===next&&sameBoard(v.board,board));
  if(match){this.hits++;return match.choice;}
  this.misses++;const choice=bestChoice(fastChoices(board,piece,next));
  if(this.size>=this.limit){this.cache.clear();this.size=0;}
  const list=this.cache.get(key)??[];list.push({board:new Uint16Array(board),piece,next,choice});this.cache.set(key,list);this.size++;return choice;
 }
}
export function pieceStream(seed:number,count:number){
 let state=(seed>>>0)||0x9e3779b9;const out:number[]=[];
 while(out.length<count){const bag=[0,1,2,3,4,5,6];for(let i=6;i>0;i--){state^=state<<13;state^=state>>>17;state^=state<<5;const j=Math.floor((state>>>0)*(i+1)/4294967296);[bag[i],bag[j]]=[bag[j],bag[i]];}out.push(...bag);}
 return out.slice(0,count);
}
