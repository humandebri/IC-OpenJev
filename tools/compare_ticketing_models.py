#!/usr/bin/env python3
"""Controlled local fine-tuning pilot: Japanese ModernBERT 70M versus 130M.

Uses fixed synthetic train/validation/test splits, never deploys to ICP.
"""
import argparse
import gc
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import random
import statistics
import time
from datetime import datetime, timezone
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
DEPARTMENTS = ['it', 'hr', 'finance', 'admin']
PRIORITIES = ['low', 'normal', 'high']
MODELS = ['sbintuitions/modernbert-ja-70m', 'sbintuitions/modernbert-ja-130m']
PROTOCOL = dict(seeds=[17, 29, 43], epochs=8, batch_size=16, max_tokens=128,
                backbone_learning_rate=3e-5, head_learning_rate=1e-3, weight_decay=0.01,
                gradient_clip=1.0, dtype='float32', attention='eager', pooling='first token (<s>)',
                head='independent linear department(4) and priority(3) heads',
                loss='mean of department and priority cross-entropy',
                selection='highest validation mean accuracy; ties: lowest validation loss',
                latency='batch=1, 5 warm-ups, all test cases, tokenizer+device transfer+forward+softmax; no model loading',
                threads=4, test_used_for_selection=False)


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def validate_data(data):
    ids, texts = set(), set()
    for split, size in [('train', 132), ('validation', 24), ('test', 48)]:
        rows = data[split]
        if len(rows) != size:
            raise ValueError(f'{split}: expected {size} cases')
        for row in rows:
            if row['id'] in ids or row['text'].strip() in texts:
                raise ValueError('Overlapping IDs or texts')
            ids.add(row['id']); texts.add(row['text'].strip())
            if not row['text'].strip() or row['department'] not in DEPARTMENTS or row['priority'] not in PRIORITIES:
                raise ValueError('Invalid labels or empty text')
        for department in DEPARTMENTS:
            for priority in PRIORITIES:
                expected = {'train': 11, 'validation': 2, 'test': 4}[split]
                if sum(r['department'] == department and r['priority'] == priority for r in rows) != expected:
                    raise ValueError(f'{split}: unbalanced labels')


def metrics(rows):
    result = {'cases': len(rows)}
    for name, labels in [('department', DEPARTMENTS), ('priority', PRIORITIES)]:
        matrix = [[0] * len(labels) for _ in labels]
        for row in rows:
            matrix[labels.index(row[name]['expected'])][labels.index(row[name]['selected'])] += 1
        correct = sum(matrix[i][i] for i in range(len(labels)))
        f1 = []
        for i in range(len(labels)):
            denominator = sum(matrix[i]) + sum(row[i] for row in matrix)
            f1.append(2 * matrix[i][i] / denominator if denominator else 0)
        result[name] = dict(correct=correct, accuracy=correct / len(rows), macro_f1=sum(f1)/len(f1), confusion=matrix)
    high = [r for r in rows if r['priority']['expected'] == 'high']
    result['high_priority'] = dict(correct=sum(r['priority']['selected'] == 'high' for r in high), total=len(high))
    result['joint_correct'] = sum(all(r[t]['expected'] == r[t]['selected'] for t in ['department', 'priority']) for r in rows)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device', choices=['auto', 'cpu', 'mps'], default='auto')
    args = parser.parse_args()
    os.environ['HF_HUB_DISABLE_IMPLICIT_TOKEN'] = '1'
    os.environ['TOKENIZERS_PARALLELISM'] = 'false'
    import numpy as np
    import torch
    from huggingface_hub import HfApi, snapshot_download
    from transformers import AutoModel, AutoTokenizer

    torch.set_num_threads(PROTOCOL['threads'])
    device = 'mps' if args.device == 'auto' and torch.backends.mps.is_available() else 'cpu' if args.device == 'auto' else args.device
    if device == 'mps' and not torch.backends.mps.is_available():
        raise RuntimeError('Requested MPS is unavailable')
    source = ROOT / 'fixtures/ticketing-ja/comparison/cases.json'
    data = json.loads(source.read_text())
    validate_data(data)
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + str(uuid4())[:8]
    output = ROOT / 'artifacts/ticketing-ja/model-comparison' / run_id
    output.mkdir(parents=True, exist_ok=False)
    checkpoint_root = ROOT / 'models/ticketing-ja' / run_id
    checkpoint_root.mkdir(parents=True, exist_ok=False)
    report = dict(format_version=1, run_id=run_id, state='running', started_at=datetime.now(timezone.utc).isoformat(),
                  protocol=PROTOCOL, corpus_sha256=digest(source), script_sha256=digest(__file__),
                  requirements_sha256=digest(ROOT/'tools/requirements-ticketing-models.lock.txt'),
                  environment=dict(python=platform.python_version(), machine=platform.machine(), device=device,
                                   packages={name: importlib.metadata.version(name) for name in ['torch','transformers','numpy','huggingface-hub','safetensors','tokenizers']}),
                  models=[], limitations=['Synthetic hand-authored convenience sample, not real enterprise data.',
                  'Train data is partly templated; this is a pilot, not a production or independent benchmark.',
                  'Test examples are not used for checkpoint or hyperparameter selection.',
                  'No quantization, no ICP deployment or instruction measurement; local latency is not canister latency.'])

    def save():
        temporary = output / 'report.tmp'
        temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        temporary.replace(output/'report.json')

    def sync():
        if device == 'mps': torch.mps.synchronize()

    class Classifier(torch.nn.Module):
        def __init__(self, path):
            super().__init__()
            self.encoder = AutoModel.from_pretrained(path, local_files_only=True, use_safetensors=True,
                                                       attn_implementation='eager', reference_compile=False)
            width = self.encoder.config.hidden_size
            self.department = torch.nn.Linear(width, len(DEPARTMENTS))
            self.priority = torch.nn.Linear(width, len(PRIORITIES))

        def forward(self, inputs):
            features = self.encoder(**inputs).last_hidden_state[:, 0]
            return self.department(features), self.priority(features)

    def evaluate(model, tokenizer, rows):
        model.eval()
        predictions, total_loss = [], 0.0
        with torch.inference_mode():
            for start in range(0, len(rows), PROTOCOL['batch_size']):
                batch = rows[start:start+PROTOCOL['batch_size']]
                inputs = tokenizer([r['text'] for r in batch], padding=True, return_tensors='pt').to(device)
                heads = model(inputs)
                for logits, name, labels in zip(heads, ['department','priority'], [DEPARTMENTS,PRIORITIES]):
                    targets = torch.tensor([labels.index(r[name]) for r in batch], device=device)
                    total_loss += torch.nn.functional.cross_entropy(logits, targets).item() * len(batch) / 2
                probs = [torch.softmax(head, -1).cpu().tolist() for head in heads]
                for i, row in enumerate(batch):
                    result = {'id': row['id']}
                    for head, name, labels in zip(probs, ['department','priority'], [DEPARTMENTS,PRIORITIES]):
                        result[name] = dict(expected=row[name], selected=labels[int(np.argmax(head[i]))], probabilities=head[i])
                    predictions.append(result)
        return metrics(predictions), total_loss/len(rows), predictions

    save()
    print('Output:', output, 'Device:', device, flush=True)
    try:
        # Pin both upstream revisions before either model is trained.
        api = HfApi(token=False)
        revisions = {name: api.model_info(name).sha for name in MODELS}
        report['revisions'] = revisions
        save()
        for name in MODELS:
            print('Downloading', name, revisions[name], flush=True)
            snapshot = Path(snapshot_download(name, revision=revisions[name], token=False,
                           cache_dir=ROOT/'models/ticketing-ja/hf-cache',
                           allow_patterns=['config.json','model.safetensors','tokenizer*','special_tokens_map.json','added_tokens.json','vocab*','*.model']))
            tokenizer = AutoTokenizer.from_pretrained(snapshot, local_files_only=True)
            lengths = {split: [len(tokenizer(r['text'])['input_ids']) for r in rows] for split, rows in data.items() if split in ['train','validation','test']}
            if max(max(v) for v in lengths.values()) > PROTOCOL['max_tokens']:
                raise RuntimeError('Input exceeds frozen token limit; no truncation permitted')
            model_result = dict(name=name, revision=revisions[name], source_files={p.name:digest(p) for p in snapshot.iterdir() if p.is_file()},
                                max_tokens={s:max(v) for s,v in lengths.items()}, trials=[])
            report['models'].append(model_result); save()
            for seed in PROTOCOL['seeds']:
                print('Training', name, 'seed', seed, flush=True)
                random.seed(seed); np.random.seed(seed); torch.manual_seed(seed)
                model = Classifier(snapshot).to(device)
                params = sum(p.numel() for p in model.parameters())
                optimizer = torch.optim.AdamW([
                    {'params': model.encoder.parameters(), 'lr': PROTOCOL['backbone_learning_rate']},
                    {'params': list(model.department.parameters())+list(model.priority.parameters()), 'lr': PROTOCOL['head_learning_rate']}],
                    weight_decay=PROTOCOL['weight_decay'])
                rng = np.random.default_rng(seed)
                history, best, best_epoch = [], (-1.0, float('-inf')), 0
                checkpoint = checkpoint_root/f'{name.split("/")[-1]}-seed{seed}.pt'
                sync(); began = time.perf_counter()
                for epoch in range(1, PROTOCOL['epochs']+1):
                    model.train(); epoch_loss = 0.0
                    order = rng.permutation(len(data['train']))
                    for start in range(0, len(order), PROTOCOL['batch_size']):
                        batch = [data['train'][int(i)] for i in order[start:start+PROTOCOL['batch_size']]]
                        inputs = tokenizer([r['text'] for r in batch], padding=True, return_tensors='pt').to(device)
                        optimizer.zero_grad(set_to_none=True)
                        d, p = model(inputs)
                        dy = torch.tensor([DEPARTMENTS.index(r['department']) for r in batch], device=device)
                        py = torch.tensor([PRIORITIES.index(r['priority']) for r in batch], device=device)
                        loss = (torch.nn.functional.cross_entropy(d,dy)+torch.nn.functional.cross_entropy(p,py))/2
                        if not torch.isfinite(loss).item(): raise RuntimeError('Non-finite training loss')
                        loss.backward(); torch.nn.utils.clip_grad_norm_(model.parameters(), PROTOCOL['gradient_clip']); optimizer.step()
                        epoch_loss += loss.item()*len(batch)
                    validation, val_loss, _ = evaluate(model, tokenizer, data['validation'])
                    criterion = ((validation['department']['accuracy']+validation['priority']['accuracy'])/2, -val_loss)
                    history.append(dict(epoch=epoch, train_loss=epoch_loss/len(order), validation_loss=val_loss, validation=validation))
                    if criterion > best:
                        best, best_epoch = criterion, epoch
                        torch.save({key:value.detach().cpu() for key,value in model.state_dict().items()}, checkpoint)
                    print(f'{name.split("/")[-1]} seed={seed} epoch={epoch} validation_dept={validation["department"]["correct"]}/24 priority={validation["priority"]["correct"]}/24', flush=True)
                sync(); train_seconds = time.perf_counter()-began
                del optimizer
                model.load_state_dict(torch.load(checkpoint, map_location='cpu', weights_only=True))
                test_metrics, test_loss, predictions = evaluate(model, tokenizer, data['test'])
                # Warm up and time complete batch=1 requests using exactly the same test texts for both models.
                latencies = []
                model.eval()
                with torch.inference_mode():
                    for index, row in enumerate(data['test'][:5]+data['test']):
                        sync(); began = time.perf_counter()
                        inputs = tokenizer(row['text'], return_tensors='pt').to(device)
                        heads = model(inputs)
                        [torch.softmax(head,-1).cpu().tolist() for head in heads]
                        sync()
                        if index >= 5: latencies.append((time.perf_counter()-began)*1000)
                trial = dict(seed=seed, parameters=params, selected_epoch=best_epoch, training_seconds=train_seconds,
                             checkpoint_bytes=checkpoint.stat().st_size, checkpoint_sha256=digest(checkpoint),
                             checkpoint=str(checkpoint.relative_to(ROOT)), history=history, test=test_metrics,
                             test_loss=test_loss, predictions=predictions, latency_ms=dict(p50=float(np.percentile(latencies,50)),p95=float(np.percentile(latencies,95)),samples=latencies))
                model_result['trials'].append(trial); save()
                print('RESULT', name, seed, json.dumps(test_metrics), flush=True)
                del model; gc.collect()
                if device == 'mps': torch.mps.empty_cache()
        for result in report['models']:
            result['aggregate'] = {task:dict(mean_accuracy=statistics.mean(t['test'][task]['accuracy'] for t in result['trials']),
                std_accuracy=statistics.stdev(t['test'][task]['accuracy'] for t in result['trials']),
                mean_macro_f1=statistics.mean(t['test'][task]['macro_f1'] for t in result['trials'])) for task in ['department','priority']}
            result['aggregate']['mean_latency_p50_ms'] = statistics.mean(t['latency_ms']['p50'] for t in result['trials'])
        report['state']='completed'
    except BaseException as error:
        report['state']='failed'; report['error']=repr(error)
        raise
    finally:
        report['finished_at']=datetime.now(timezone.utc).isoformat(); save()
    print('Saved', output/'report.json', flush=True)


if __name__ == '__main__':
    main()
