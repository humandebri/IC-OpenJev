#!/usr/bin/env python3
"""Offline export/parity gate for the frozen seed29 Japanese ticket classifier.

Run with the existing ticketing-comparison Python environment. Never downloads,
trains, deploys, overwrites a pack, or changes the frozen comparison corpus.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
REVISION = '28c180b16463ba6f3fa79b48756fbf21586fe23e'
RUN = '20261118T012521Z-bc177d61'
SNAPSHOT = ROOT / 'models/ticketing-ja/hf-cache/models--sbintuitions--modernbert-ja-130m/snapshots' / REVISION
CHECKPOINT = ROOT / 'models/ticketing-ja' / RUN / 'modernbert-ja-130m-seed29.pt'
REFERENCE_REPORT = ROOT / 'artifacts/ticketing-ja/model-comparison' / RUN / 'report.json'
CORPUS = ROOT / 'fixtures/ticketing-ja/comparison/cases.json'
DEFAULT_OUT = ROOT / 'models/ticketing-ja/optimized-seed29-v1'
EDGES = ['パソコンが起動しません。', 'VPN Error 403、接続できません。',
         '経費精算\n領収書を添付します。', 'ＡＢＣ１２３とABC123、半角ｶﾅ',
         '申請をお願いします🙂🚀', '𠮷野さんの人事手続き', '<s>設定</s><mask>について',
         '  前後の空白  ', 'a\tb\r\nc', '日本語\u3000全角空白']


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for b in iter(lambda: f.read(8 * 1024 * 1024), b''): h.update(b)
    return h.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def source_state():
    import torch
    report = json.loads(REFERENCE_REPORT.read_text())
    model = next(m for m in report['models'] if m['name'].endswith('130m'))
    trial = next(t for t in model['trials'] if t['seed'] == 29)
    # Bind the actual checkpoint to the recorded experiment before exporting it.
    recorded = trial['checkpoint_sha256']
    if sha(CHECKPOINT) != recorded: raise ValueError('Checkpoint differs from frozen experiment')
    for name in ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'tokenizer.model']:
        if sha(SNAPSHOT/name) != model['source_files'][name]:
            raise ValueError(f'Source artifact differs from frozen experiment: {name}')
    return torch.load(CHECKPOINT, map_location='cpu', weights_only=True)


def frozen_corpus():
    from compare_ticketing_models import validate_data
    reference = json.loads(REFERENCE_REPORT.read_text())
    if sha(CORPUS) != reference['corpus_sha256']:
        raise ValueError('Frozen comparison corpus SHA-256 mismatch')
    data = json.loads(CORPUS.read_text())
    validate_data(data)
    return data


def prepare(out):
    import numpy as np
    state = source_state()
    config = json.loads((SNAPSHOT/'config.json').read_text())
    required = dict(hidden_size=512, num_hidden_layers=19, num_attention_heads=8,
                    vocab_size=102400, intermediate_size=2048, global_attn_every_n_layers=3,
                    local_attention=128, global_rope_theta=160000., local_rope_theta=10000.,
                    norm_eps=1e-5, hidden_activation='gelu', attention_bias=False,
                    mlp_bias=False, norm_bias=False)
    if any(config.get(k) != v for k, v in required.items()): raise ValueError('Unsupported architecture')
    out.mkdir(parents=True, exist_ok=False)
    for reference in [True, False]:
        target = out / ('fp32' if reference else 'int8'); target.mkdir()
        entries, pos = [], 0
        with (target/'model.bin').open('xb') as f:
            for name, tensor in sorted(state.items()):
                a = tensor.detach().float().numpy()
                quant = not reference and name.startswith('encoder.') and a.ndim == 2
                if quant:
                    scale = np.maximum(np.abs(a).max(axis=1) / np.float32(127), np.float32(1e-8))
                    q = np.clip(np.rint(a / scale[:, None]), -127, 127).astype('i1')
                    raw = q.tobytes() + scale.astype('<f4').tobytes()
                else: raw = a.astype('<f4').tobytes()
                f.write(raw)
                entries.append(dict(name=name, shape=list(a.shape), offset=pos, length=len(raw),
                                    encoding='i8_row_symmetric' if quant else 'f32_le',
                                    sha256=list(hashlib.sha256(raw).digest())))
                pos += len(raw)
        shutil.copyfile(SNAPSHOT/'tokenizer.json', target/'tokenizer.json')
        manifest = dict(format='ic-ticketing-ja-pack-v1', source_repo='sbintuitions/modernbert-ja-130m',
                        source_revision=REVISION, checkpoint_sha256=list(bytes.fromhex(sha(CHECKPOINT))),
                        tokenizer_sha256=list(bytes.fromhex(sha(target/'tokenizer.json'))),
                        config_sha256=list(bytes.fromhex(sha(SNAPSHOT/'config.json'))),
                        reference_f32=reference, total_bytes=pos, tensors=entries)
        write_json(target/'manifest.json', manifest)
        print(target, pos, 'bytes', flush=True)


def validate(out, report_path):
    data = frozen_corpus()
    import torch
    from transformers import AutoConfig, AutoModel, AutoTokenizer
    from compare_ticketing_models import metrics
    torch.set_num_threads(4)
    state = source_state()
    config = AutoConfig.from_pretrained(SNAPSHOT, local_files_only=True)
    config.reference_compile = False
    encoder = AutoModel.from_config(config, attn_implementation='eager')
    encoder.load_state_dict({k.removeprefix('encoder.'): v for k, v in state.items() if k.startswith('encoder.')})
    encoder.eval()
    tok = AutoTokenizer.from_pretrained(SNAPSHOT, local_files_only=True)
    examples = [dict(r, split=s) for s in ['validation','test'] for r in data[s]]
    examples += [dict(id=f'edge-{i}', text=t, split='edge') for i,t in enumerate(EDGES)]
    # Exact token counts for the local canister calibration, with no truncation.
    for n in [8,16,18,24,32,40,48,64,96,128,129]:
        text = 'x ' * (n-3)
        assert len(tok(text)['input_ids']) == n
        examples.append(dict(id=f'length-{n}', text=text, split='length'))
    python = []
    with torch.inference_mode():
        for row in examples:
            inputs = tok(row['text'], return_tensors='pt')
            ids = inputs['input_ids'][0].tolist()
            if len(ids)>128:
                python.append(dict(ids=ids, error='too long')); continue
            features = encoder(**inputs).last_hidden_state[:,0]
            heads = {name: torch.nn.functional.linear(features,state[name+'.weight'],state[name+'.bias'])[0].tolist()
                     for name in ['department','priority']}
            python.append(dict(ids=ids, **heads))
    payload = ''.join(json.dumps(dict(text=r['text']),ensure_ascii=False)+'\n' for r in examples)
    native = {}
    binary = ROOT/'target/release/ticketing-infer'
    for name in ['fp32','int8']:
        command = [str(binary), str(out/name)] + (['--reference-f32'] if name=='fp32' else [])
        result = subprocess.run(command, input=payload, text=True, capture_output=True, check=True)
        native[name] = [json.loads(line) for line in result.stdout.splitlines()]
        if len(native[name])!=len(examples): raise ValueError('Incomplete native results')
    rows, max_diff, max_probability_diff, mismatches = [], dict(fp32=0., int8=0.), 0., []
    labels = dict(department=['it','hr','finance','admin'], priority=['low','normal','high'])
    for i,row in enumerate(examples):
        py = python[i]; result = dict(id=row['id'],split=row['split'],text=row['text'],python=py,
                                     fp32=native['fp32'][i], int8=native['int8'][i])
        for name in native:
            actual = native[name][i]
            if 'error' in py:
                if 'error' not in actual: raise ValueError('Missing length rejection')
                continue
            if actual.get('ids')!=py['ids']: raise ValueError(f'Tokenizer mismatch: {row["id"]}')
            for task in labels:
                delta = max(abs(a-b) for a,b in zip(py[task],actual[task]))
                max_diff[name] = max(max_diff[name],delta)
                if name=='fp32' and delta>0.001: raise ValueError(f'FP32 logit mismatch: {row["id"]}: {delta}')
                if row['split'] in ['validation','test'] and max(range(len(labels[task])),key=actual[task].__getitem__)!=max(range(len(labels[task])),key=py[task].__getitem__):
                    mismatches.append(dict(id=row['id'],variant=name,task=task))
                prob_delta=(torch.tensor(actual[task]).softmax(-1)-torch.tensor(py[task]).softmax(-1)).abs().max().item()
                if name=='int8': max_probability_diff=max(max_probability_diff,prob_delta)
        rows.append(result)
    summary = {}
    for name, predictions in [('python',python),*native.items()]:
        summary[name] = {}
        for split in ['validation','test']:
            scored = []
            for row,p in zip(examples,predictions):
                if row['split']!=split: continue
                scored.append({task: dict(expected=row[task], selected=labels[task][max(range(len(labels[task])),key=p[task].__getitem__)]) for task in labels})
            summary[name][split] = metrics(scored)
    report = dict(format_version=1, state='passed' if not mismatches else 'rejected',
                  created_at=datetime.now(timezone.utc).isoformat(), source_checkpoint_sha256=sha(CHECKPOINT),
                  corpus_sha256=sha(CORPUS), script_sha256=sha(__file__), native_binary_sha256=sha(binary),
                  packs={n:dict(manifest_sha256=sha(out/n/'manifest.json'),bytes=(out/n/'model.bin').stat().st_size) for n in native},
                  max_logit_difference=max_diff, max_int8_probability_difference=max_probability_diff,
                  label_mismatches=mismatches, summary=summary, rows=rows,
                  limitations=['Synthetic pilot corpus; parity is not real-world accuracy.',
                               'Existing test set is a regression check, not a fresh holdout.'])
    report_path.parent.mkdir(parents=True,exist_ok=True)
    if report_path.exists(): raise FileExistsError(report_path)
    write_json(report_path,report)
    print(json.dumps({k:v for k,v in report.items() if k not in ['rows','summary']},indent=2))
    if mismatches: raise SystemExit(2)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('phase',choices=['prepare','validate'])
    p.add_argument('--out',type=Path,default=DEFAULT_OUT)
    p.add_argument('--report',type=Path,default=ROOT/'artifacts/ticketing-ja/optimization/native.json')
    args=p.parse_args()
    if args.phase=='prepare': prepare(args.out)
    else: validate(args.out,args.report)


if __name__=='__main__': main()
