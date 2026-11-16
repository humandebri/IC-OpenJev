"""Check new episode seed partitions against locally retained prior experiment metadata."""
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=Path(os.environ.get('TETRIS_V2_DIR',ROOT/'artifacts/tetris-lgbm-v2'))
def main():
    files=subprocess.check_output(['rg','--files','--no-ignore','artifacts','-g','*.json','-g','!**/tetris-lgbm-v2/**'],cwd=ROOT,text=True).splitlines()
    seeds=set();sources=[]
    def values(v):
        if isinstance(v,int) and not isinstance(v,bool): seeds.add(v)
        elif isinstance(v,list):
            for x in v: values(x)
        elif isinstance(v,dict):
            for x in v.values(): values(x)
    def walk(v):
        if isinstance(v,dict):
            for key,x in v.items():
                if key=='seed' or key=='seeds' or key.endswith('_seeds'): values(x)
                else: walk(x)
        elif isinstance(v,list):
            for x in v: walk(x)
    for path in files:
        absolute=(ROOT/path).resolve()
        if absolute.is_relative_to(OUT.resolve()): continue
        raw=absolute.read_bytes()
        if not re.search(rb'"(?:seed|seeds|[a-z_]+_seeds)"\s*:',raw): continue
        try: record=json.loads(raw)
        except ValueError: continue
        walk(record);sources.append(dict(path=path,sha256=hashlib.sha256(raw).hexdigest()))
    new=json.loads((OUT/'data-protocol.json').read_text())['seeds']
    overlap={key:sorted(set(v)&seeds) for key,v in new.items()}
    assert not any(overlap.values()),overlap
    result=dict(passed=True,prior_json_files_scanned=len(files),prior_seed_metadata_files=len(sources),prior_unique_seed_values=len(seeds),overlap=overlap,
                sources_sha256=hashlib.sha256(json.dumps(sources,sort_keys=True).encode()).hexdigest(),source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    (OUT/'prior-seed-audit.json').write_text(json.dumps(result,indent=2)+'\n');print(result)
if __name__=='__main__': main()
