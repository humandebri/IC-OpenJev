import {describe,expect,it} from 'vitest';
import {cropTop,expectedLines,movePreview} from './move-preview';

describe('move preview',()=>{
 it('marks the current piece and outlines NEXT on an empty board',()=>{
  const p=movePreview(Array(200).fill(0),0,[[0,19],[1,19],[2,19],[3,19]],1,{r:0,x:8,y:18});
  expect(p.linesNow).toBe(0);
  expect(p.cells.filter(c=>c.current).length).toBe(4);
  expect(p.cells.filter(c=>c.next).map((_,i)=>i).length).toBe(4);
  expect(p.cells[19*10+8].next).toBe(true);
 });
 it('clears completed rows before placing the NEXT outline',()=>{
  const before=Array(200).fill(0);for(let x=0;x<6;x++)before[190+x]=2;
  const p=movePreview(before,0,[[6,19],[7,19],[8,19],[9,19]],1,{r:0,x:0,y:18});
  expect(p.linesNow).toBe(1);
  expect(p.cells.slice(190).every(c=>c.next||!c.value)).toBe(true);
 });
 it('crops to a shared frame',()=>{
  const p=movePreview(Array(200).fill(0),0,[[0,19],[1,19],[2,19],[3,19]],1,null);
  expect(cropTop([p])).toBe(13);
 });
 it('converts the residual into expected future lines',()=>{
  const terminal=Array(20).fill(0);terminal[19]=1;
  expect(expectedLines({residual:41,terminal})).toBeCloseTo(4);
  expect(expectedLines({residual:0,terminal:null})).toBeNull();
 });
});
