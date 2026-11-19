#!/usr/bin/env python3
"""Train small IT heads on frozen native INT8 encoder features. No network/deploy."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
from uuid import uuid4
ROOT = Path(__file__).resolve().parents[1]
QUEUES = ['account', 'device', 'network', 'review']
PRIORITIES = ['low', 'normal', 'high']
COUNTS = {'train':96, 'validation':24, 'test':48}
def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def save(path, value): path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def validate(data):
    seen_ids, seen_texts = set(), set()
    for split, count in COUNTS.items():
        rows = data[split]
        if len(rows)!=count: raise ValueError(f'{split}: expected {count} cases')
        for row in rows:
            if not row['text'].strip() or row['id'] in seen_ids or row['text'].strip() in seen_texts: raise ValueError('empty or overlapping cases')
            if row['queue'] not in QUEUES or row['priority'] not in PRIORITIES: raise ValueError('unknown label')
            seen_ids.add(row['id']); seen_texts.add(row['text'].strip())
        for q in QUEUES:
            for p in PRIORITIES:
                if sum(r['queue']==q and r['priority']==p for r in rows)!=count//12: raise ValueError('unbalanced corpus')
    return data

def decision(row, thresholds):
    if thresholds[0] >= 1.: return 'review'
    q,p = row['queue_probabilities'],row['priority_probabilities']
    qi=max(range(4),key=q.__getitem__);pi=max(range(3),key=p.__getitem__)
    ordered=sorted(q,reverse=True)
    review=qi==3 or q[qi]<thresholds[0] or ordered[0]-ordered[1]<thresholds[1] or p[pi]<thresholds[2]
    return 'review' if review else QUEUES[qi]

def metrics(rows, thresholds):
    automatic=[r for r in rows if decision(r,thresholds)!='review']
    correct=sum(decision(r,thresholds)==r['expected_queue'] and PRIORITIES[max(range(3),key=r['priority_probabilities'].__getitem__)]==r['expected_priority'] for r in automatic)
    outside=[r for r in rows if r['expected_queue']=='review']
    known=sum(r['expected_queue']!='review' for r in rows)
    return dict(cases=len(rows),queue_correct=sum(QUEUES[max(range(4),key=r['queue_probabilities'].__getitem__)]==r['expected_queue'] for r in rows),
        priority_correct=sum(PRIORITIES[max(range(3),key=r['priority_probabilities'].__getitem__)]==r['expected_priority'] for r in rows),
        suggested=len(automatic),suggested_joint_precision=correct/len(automatic) if automatic else None,
        in_scope_coverage=sum(r['expected_queue']!='review' for r in automatic)/known if known else 0,
        review_expected=len(outside),review_caught=sum(decision(r,thresholds)=='review' for r in outside))

def passes(m):
    return (m['suggested_joint_precision'] or 0)>=.95 and m['in_scope_coverage']>=.5 and m['review_caught']==m['review_expected']

def select_thresholds(rows):
    candidates=[]
    for q in [.5,.6,.7,.8,.9,.95,.98]:
        for margin in [.0,.1,.2,.3]:
            for priority in [.5,.6,.7,.8,.9,.95]:
                thresholds=(q,margin,priority);m=metrics(rows,thresholds)
                if passes(m): candidates.append((m['suggested'],m['suggested_joint_precision'],q,margin,priority))
    if not candidates: return (1.,1.,1.),False
    chosen=max(candidates)
    return chosen[2:],True

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--pack',type=Path,default=ROOT/'models/ticketing-ja/optimized-seed29-v1/int8')
    p.add_argument('--corpus',type=Path,default=ROOT/'fixtures/ticketing-ja/it-routing/cases.json')
    p.add_argument('--out',type=Path)
    args=p.parse_args()
    data=validate(json.loads(args.corpus.read_text()))
    run_id=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+str(uuid4())[:8]
    out=args.out or ROOT/'artifacts/ticketing-ja/it-routing'/run_id
    out.mkdir(parents=True,exist_ok=False)
    import torch
    torch.set_num_threads(4)
    report=dict(state='running',base_model=sha(args.pack/'manifest.json'),corpus_sha256=sha(args.corpus),script_sha256=sha(__file__),
        feature_binary_sha256=sha(ROOT/'target/release/ticketing-infer'),
        protocol=dict(frozen_encoder=True,frozen_original_heads=True,native_int8_features=True,seeds=[17,29,43],epochs=400,
            checkpoint_selection='validation mean accuracy, ties validation loss',threshold_selection='validation only; joint precision >= .95, review recall 1, in-scope coverage >= .5',test_used_for_selection=False),
        limitations=['Hand-authored synthetic convenience corpus, not enterprise data.','Thresholds are not calibrated probabilities.','The API suggests queues; it does not create or assign tickets.'])
    save(out/'report.json',report)
    examples=[dict(r,split=s) for s in COUNTS for r in data[s]]
    payload=''.join(json.dumps({'text':r['text']},ensure_ascii=False)+'\n' for r in examples)
    try:
        features=subprocess.run([str(ROOT/'target/release/ticketing-infer'),str(args.pack),'--features'],input=payload,text=True,capture_output=True,check=True)
        raw=[json.loads(line) for line in features.stdout.splitlines()]
        if len(raw)!=len(examples) or any('error' in r or len(r['features'])!=512 or len(r['ids'])>64 for r in raw): raise ValueError('Incomplete, invalid, or over-64-token features')
        save(out/'features.json',raw)
        xs={s:torch.tensor([f['features'] for e,f in zip(examples,raw) if e['split']==s],dtype=torch.float32) for s in COUNTS}
        ys={s:[torch.tensor([labels.index(r[key]) for r in data[s]]) for key,labels in [('queue',QUEUES),('priority',PRIORITIES)]] for s in COUNTS}
        trials=[];best=None
        for seed in report['protocol']['seeds']:
            torch.manual_seed(seed)
            heads=torch.nn.ModuleList([torch.nn.Linear(512,4),torch.nn.Linear(512,3)])
            optimizer=torch.optim.AdamW(heads.parameters(),lr=.005,weight_decay=.01)
            checkpoint=None;history=[]
            for epoch in range(1,401):
                optimizer.zero_grad(set_to_none=True)
                loss=sum(torch.nn.functional.cross_entropy(h(xs['train']),y) for h,y in zip(heads,ys['train']))/2
                loss.backward();optimizer.step()
                with torch.no_grad():
                    val=[h(xs['validation']) for h in heads]
                    accuracy=sum((logits.argmax(-1)==y).float().mean().item() for logits,y in zip(val,ys['validation']))/2
                    val_loss=sum(torch.nn.functional.cross_entropy(logits,y).item() for logits,y in zip(val,ys['validation']))/2
                criterion=(accuracy,-val_loss)
                if checkpoint is None or criterion>checkpoint['criterion']:
                    checkpoint=dict(criterion=criterion,epoch=epoch,state={k:v.detach().clone() for k,v in heads.state_dict().items()})
                if epoch%50==0:history.append(dict(epoch=epoch,train_loss=loss.item(),validation_accuracy=accuracy,validation_loss=val_loss))
            heads.load_state_dict(checkpoint['state'])
            trial=dict(seed=seed,selected_epoch=checkpoint['epoch'],validation_accuracy=checkpoint['criterion'][0],validation_loss=-checkpoint['criterion'][1],history=history)
            trials.append(trial)
            if best is None or checkpoint['criterion']>best['criterion']:best=dict(criterion=checkpoint['criterion'],heads=heads,seed=seed)
        heads=best['heads']
        def predictions(split):
            with torch.no_grad(): probs=[h(xs[split]).softmax(-1).tolist() for h in heads]
            return [dict(id=r['id'],expected_queue=r['queue'],expected_priority=r['priority'],queue_probabilities=probs[0][i],priority_probabilities=probs[1][i]) for i,r in enumerate(data[split])]
        validation=predictions('validation')
        thresholds,val_pass=select_thresholds(validation)
        test=predictions('test')
        report.update(trials=trials,selected_seed=best['seed'],thresholds=thresholds,validation=metrics(validation,thresholds),test=metrics(test,thresholds))
        accepted=val_pass and passes(report['test'])
        head=dict(format='ic-it-routing-head-v1',validated=accepted,base_model=list(bytes.fromhex(report['base_model'])),corpus_sha256=list(bytes.fromhex(report['corpus_sha256'])),
            queue_weights=heads[0].weight.detach().flatten().tolist(),queue_bias=heads[0].bias.detach().tolist(),
            priority_weights=heads[1].weight.detach().flatten().tolist(),priority_bias=heads[1].bias.detach().tolist(),
            queue_threshold=thresholds[0],margin_threshold=thresholds[1],priority_threshold=thresholds[2])
        save(out/'head.json',head)
        native=subprocess.run([str(ROOT/'target/release/it-routing-infer'),str(args.pack),str(out/'head.json')],input=payload,text=True,capture_output=True,check=True)
        actual=[json.loads(line) for line in native.stdout.splitlines()]
        if len(actual)!=len(examples) or any('error' in r for r in actual):raise ValueError('Native routing inference failed')
        rows=[]
        for split in ['validation','test']:
            expected=validation if split=='validation' else test
            by_id={r['id']:r for r in expected}
            for e,r in zip(examples,actual):
                if e['split']!=split:continue
                py=by_id[e['id']];value=r['result']
                if value['decision']!=(decision(py,thresholds) if accepted else 'review') or value['queue']['selected']!=QUEUES[max(range(4),key=py['queue_probabilities'].__getitem__)] or value['priority']['selected']!=PRIORITIES[max(range(3),key=py['priority_probabilities'].__getitem__)]:raise ValueError('Native/Python decision mismatch')
                rows.append(dict(id=e['id'],split=split,text=e['text'],result=value))
        report.update(state='passed' if val_pass and passes(report['test']) else 'rejected',head_sha256=sha(out/'head.json'),head_bytes=(out/'head.json').stat().st_size,native_binary_sha256=sha(ROOT/'target/release/it-routing-infer'),rows=rows)
        save(out/'report.json',report)
        print(json.dumps({k:report[k] for k in ['state','selected_seed','validation','test','thresholds','head_bytes']},indent=2),flush=True)
        print('Report:',out/'report.json',flush=True)
        if report['state']!='passed':raise SystemExit(2)
    except Exception as e:
        report.update(state='failed',error=repr(e));save(out/'report.json',report);raise
if __name__=='__main__':main()
