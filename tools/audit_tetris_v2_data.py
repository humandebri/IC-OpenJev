"""Independent feature and label-accounting audit; never reads gameplay's hidden future."""
import hashlib
import json
import os
from collections import deque
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=Path(os.environ.get('TETRIS_V2_DIR',ROOT/'artifacts/tetris-lgbm-v2'))
def digest(v): return hashlib.sha256(v).hexdigest()
def features(rows):
    b=[[(row>>x)&1 for x in range(10)] for row in rows]
    heights=[next((20-y for y in range(20) if b[y][x]),0) for x in range(10)]
    holes=[sum(not b[y][x] for y in range(20-heights[x],20)) for x in range(10)]
    slopes=[heights[x+1]-heights[x] for x in range(9)]
    wells=[max(0,min(heights[x-1] if x else 20,heights[x+1] if x<9 else 20)-h) for x,h in enumerate(heights)]
    depth=sum(heights[x]-(20-y) for x in range(10) for y in range(20-heights[x],20) if not b[y][x])
    rt=sum(a!=c for row in b for a,c in zip([1]+row,row+[1]))
    ct=sum(a!=c for x in range(10) for a,c in zip([0]+[b[y][x] for y in range(20)],[b[y][x] for y in range(20)]+[1]))
    seen=set();closed=0
    for y in range(20):
        for x in range(10):
            if b[y][x] or (x,y) in seen: continue
            queue=deque([(x,y)]);seen.add((x,y));open_top=False
            while queue:
                cx,cy=queue.popleft();open_top |= cy==0
                for nx,ny in ((cx-1,cy),(cx+1,cy),(cx,cy-1),(cx,cy+1)):
                    if 0<=nx<10 and 0<=ny<20 and not b[ny][nx] and (nx,ny) not in seen:
                        seen.add((nx,ny));queue.append((nx,ny))
            closed += not open_top
    return heights+holes+slopes+wells+[sum(row) for row in b]+[sum(heights),sum(map(abs,slopes)),depth,rt,ct,closed,max(wells),sum(wells),-8*sum(holes)-max(heights)]+[v for row in b for v in row]
def main():
    manifest=json.loads((OUT/'dataset-manifest.json').read_text());protocol=json.loads((OUT/'data-protocol.json').read_text())
    all_sets=[set(v) for v in protocol['seeds'].values()]
    assert sum(map(len,all_sets))==len(set().union(*all_sets))
    rows=0;groups=0;counts={};maximum_future_lines=0
    for source in manifest['sources']:
        raw=(OUT/source['path']).read_bytes();assert digest(raw)==source['sha256'];shard=json.loads(raw)
        source_groups=json.loads((OUT/'groups'/Path(source['path']).name).read_text())['groups']
        lookup={(g['turn'],c['key']):(g,c) for g in source_groups for c in g['candidates']}
        for row in shard['rows']:
            group,candidate=lookup[row['turn'],row['key']]
            assert row['seed'] in protocol['seeds'][row['split']]
            assert row['terminal']==candidate['terminal'] and row['before']==group['board']
            assert row['features']==features(row['terminal'])
            assert row['base']==row['features'][67]
            assert [o['seed'] for o in row['outcomes']]==group['rollout_seeds']
            for i,o in enumerate(row['outcomes']):
                text=f"future:{row['split']}:{row['seed']}:{row['turn']}:{i}".encode()
                assert o['seed']==int.from_bytes(hashlib.sha256(text).digest()[:4],'little')
                assert 0<=o['survived']<=32 and 0<=o['lines']<=4*o['survived']
            mean=sum(o['lines'] for o in row['outcomes'])/8
            assert row['future_lines']==mean and row['residual_target']==10*mean-row['base']
            assert row['risk_target']==sum(o['ended'] for o in row['outcomes'])/8
            rows+=1;counts[row['split']]=counts.get(row['split'],0)+1;maximum_future_lines=max(maximum_future_lines,mean)
        groups+=shard['groups']
        if groups%256==0: print(f'audit {rows} rows',flush=True)
    assert rows==manifest['rows']
    result=dict(passed=True,rows=rows,groups=groups,split_counts=counts,features='independent Python implementation, every row',future='independent common-random seeds; known clears excluded from future target',dataset_sha256=digest((OUT/'dataset-manifest.json').read_bytes()),source_sha256=digest(Path(__file__).read_bytes()))
    (OUT/'data-audit.json').write_text(json.dumps(result,indent=2)+'\n');print(result,flush=True)
if __name__=='__main__': main()
