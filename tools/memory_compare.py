#!/usr/bin/env python3
"""Summarize immutable local PocketIC measurements; fail closed on missing evidence.

python3 tools/memory_compare.py artifacts/memory-optimization/screen.json
No deployment or mainnet operations are performed.
"""
import argparse
import collections
import hashlib
import json
import math
from pathlib import Path
import statistics


def percentile(values, p):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * p) - 1)] if ordered else None


def require(condition, message):
    # Acceptance checks must remain enabled under PYTHONOPTIMIZE / python -O.
    if not condition:
        raise ValueError(message)


def instruction_ratio(value, baseline):
    require(type(value) is int and value > 0, 'invalid instruction counter')
    require(type(baseline) is int and baseline > 0, 'invalid baseline instruction counter')
    return value / baseline


def summarize(report, reference='source', final=False):
    corpus = report['corpus']
    encoded = json.dumps(corpus, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()
    require(hashlib.sha256(encoded).hexdigest() == report['corpus_sha256'], 'corpus hash mismatch')
    expected = [c['name'] for c in corpus]
    require(bool(expected) and len(expected) == len(set(expected)), 'empty or duplicate case names')
    ref = report['runs'][reference]
    reference_rows = {c['name']: c for c in ref['cases']}
    require(set(reference_rows) == set(expected) and len(ref['cases']) == len(expected), 'baseline corpus incomplete')
    if final:
        require(report.get('upgrade', {}).get('passed') is True, 'missing successful normal-build upgrade verification')
        require(len(report['upgrade'].get('cases', [])) == len(expected), 'upgrade corpus incomplete')
    if final:
        witnesses = [c for c in corpus if c.get('require_decision_query')]
        require(bool(witnesses), 'missing required public query cases')
        for case in witnesses:
            require(reference_rows[case['name']]['regular'].get('decision_query') == 'ok', 'baseline public query witness failed')
    resident = next((run for run in report['runs'].values() if run['mode'] == 0), None)
    if final:
        require(resident is not None, 'missing resident diagnostic baseline')
        for name, run in report['runs'].items():
            before = run.get('stable_sha256_before_samples')
            require(isinstance(before, str) and bool(before) and before == run.get('stable_sha256_after_samples'), f'{name}: missing or changed stable memory evidence')
        upgrade_rows = {row['name']: row for row in report['upgrade']['cases']}
        require(set(upgrade_rows) == set(expected), 'upgrade corpus names mismatch')
        for key in expected:
            a = reference_rows[key]['regular']
            b = upgrade_rows[key].get('regular', {})
            for field in ['logit_bits', 'model', 'tokens']:
                require(a[field] == b.get(field), f'{key}: upgrade {field} mismatch')
            require(a['query'] != 'ok' or b.get('query') == 'ok', f'{key}: upgrade query failed')
            require(instruction_ratio(b.get('model_instructions'), a['model_instructions']) <= 1.05, f'{key}: upgrade instructions exceed 5%')
            if 'decision' in a:
                require(isinstance(a.get('decision_query'), str) and isinstance(b.get('decision_query'), str), f'{key}: missing public query status')
                require(a['decision_query'] != 'ok' or b['decision_query'] == 'ok', f'{key}: upgrade public query failed')
                decision = b.get('decision', {})
                for field in ['logit_bits', 'probability_bits', 'selected', 'tokens']:
                    require(a['decision'][field] == decision.get(field), f'{key}: upgrade decision {field} mismatch')
                require(instruction_ratio(decision.get('model_instructions'), a['decision']['model_instructions']) <= 1.05, f'{key}: upgrade decision instructions exceed 5%')
    resident_samples = {(x['name'], x.get('round'), x.get('repeat')): x['result'] for x in (resident or {}).get('samples', [])}
    baseline_memory = max(ref['after_update']['management_memory_bytes'], ref.get('after_samples', ref['after_update'])['management_memory_bytes'])
    summary = {'reference': reference, 'corpus_sha256': report['corpus_sha256'],
               'case_count': len(expected), 'baseline_total_bytes': baseline_memory, 'candidates': []}
    for name, run in report['runs'].items():
        failures = []
        rows = {c['name']: c for c in run['cases']}
        if set(rows) != set(expected) or len(run['cases']) != len(expected) or 'after_update' not in run:
            summary['candidates'].append({'name': name, 'accepted': False, 'failures': ['incomplete measurement']})
            continue
        ratios = []
        handler_ratios = []
        decision_ratios = []
        max_query_heap = 0
        reads = []
        for key in expected:
            a = reference_rows[key]['regular']
            b = rows[key]['regular']
            for field in ['logit_bits', 'model', 'tokens']:
                if a[field] != b[field]:
                    failures.append(f'{key}: {field} mismatch')
            if a['query'] == 'ok' and b['query'] != 'ok':
                failures.append(f'{key}: previously successful query failed')
            ratio = instruction_ratio(b['model_instructions'], a['model_instructions'])
            ratios.append((ratio, key))
            if ratio > 1.05:
                failures.append(f'{key}: inference instructions +{(ratio-1)*100:.3f}%')
            if 'decision' in a:
                if not isinstance(a.get('decision_query'), str) or not isinstance(b.get('decision_query'), str) or (a['decision_query'] == 'ok' and b['decision_query'] != 'ok'):
                    failures.append(f'{key}: public query unavailable or missing status')
                for field in ['logit_bits', 'probability_bits', 'selected', 'tokens']:
                    if a['decision'][field] != b['decision'][field]:
                        failures.append(f'{key}: decision {field} mismatch')
                ratio = instruction_ratio(b['decision']['model_instructions'], a['decision']['model_instructions'])
                decision_ratios.append((ratio, key))
                if ratio > 1.05:
                    failures.append(f'{key}: decision instructions +{(ratio-1)*100:.3f}%')
            d = rows[key].get('diagnostic')
            if final and run['mode'] != 255 and not d:
                failures.append(f'{key}: missing diagnostic result')
            if d:
                diag_reference = next((r for r in report['runs'].values() if r['mode'] == 0), None)
                if diag_reference:
                    ref_d = next((r['diagnostic'] for r in diag_reference['cases'] if r['name'] == key), None)
                    if final and not ref_d:
                        failures.append(f'{key}: missing resident diagnostic result')
                    if ref_d:
                        ratio = instruction_ratio(d['instructions_through_argument_decode'], ref_d['instructions_through_argument_decode'])
                        handler_ratios.append((ratio, key))
                        if ratio > 1.05:
                            failures.append(f'{key}: diagnostic handler instructions +{(ratio-1)*100:.3f}%')
                elif final:
                    failures.append('missing fixed resident diagnostic baseline')
                if d['logit_bits'] != a['logit_bits']:
                    failures.append(f'{key}: diagnostic logits mismatch')
                max_query_heap = max(max_query_heap, d['io']['heap_peak'])
                reads.append(d['io'])
        repeated_handler_ratios = []
        samples = collections.defaultdict(list)
        for sample in run.get('samples', []):
            key = sample['name']
            r = sample['result']
            if r['logit_bits'] != reference_rows[key]['regular']['logit_bits']:
                failures.append(f'{key}: repeated inference mismatch')
            if final:
                baseline_sample = resident_samples.get((key, sample.get('round'), sample.get('repeat')))
                if baseline_sample is None:
                    failures.append(f'{key}: missing paired resident sample')
                else:
                    ratio = instruction_ratio(r.get('instructions_through_argument_decode'), baseline_sample.get('instructions_through_argument_decode'))
                    repeated_handler_ratios.append((ratio, key))
                    if ratio > 1.05:
                        failures.append(f'{key}: repeated handler instructions exceed 5%')
                if not math.isfinite(r['wall_seconds']) or r['wall_seconds'] < 0:
                    failures.append(f'{key}: invalid timing sample')
            samples[key].append(r)
            max_query_heap = max(max_query_heap, r.get('io', {}).get('heap_peak', 0))
        if final and run['mode'] != 255:
            for key in expected:
                values = samples[key]
                records = [x for x in run.get('samples', []) if x['name'] == key]
                if len(values) != 15 or len({x.get('nonce') for x in values}) != 15:
                    failures.append(f'{key}: requires 15 independent nonce samples')
                if {(x.get('round'), x.get('repeat')) for x in records} != {(r, n) for r in range(3) for n in range(5)}:
                    failures.append(f'{key}: incomplete 5 x 3 schedule')
        all_ratios = ratios + decision_ratios
        worst = max(all_ratios)
        final_stats = run.get('after_samples', run['after_update'])
        total = max(run['after_update']['management_memory_bytes'], final_stats['management_memory_bytes'])
        # A query's transient allocations are discarded: include its heap peak in
        # capacity reporting instead of treating the next info() as the peak.
        stable = run['after_update'].get('stable_bytes')
        committed_heap = max(run['after_update']['heap_bytes'], final_stats['heap_bytes'])
        total_peak = total + max(0, max_query_heap - committed_heap)
        times = [s['wall_seconds'] for values in samples.values() for s in values]
        timing = {key: {'samples': len(values),
                        'median_seconds': statistics.median(v['wall_seconds'] for v in values),
                        'p95_seconds': percentile([v['wall_seconds'] for v in values], .95),
                        'path': sorted(set(v['path'] for v in values))}
                  for key, values in samples.items()}
        summary['candidates'].append({'name': name, 'mode': run['mode'], 'accepted': not failures,
            'failures': failures, 'total_bytes': total, 'total_peak_bytes': total_peak,
            'saved_bytes': baseline_memory-total, 'saved_percent': (1-total/baseline_memory)*100,
            'heap_bytes': committed_heap, 'stable_bytes': stable,
            'scratch_capacity': run['after_update'].get('scratch_capacity'),
            'worst_instruction_increase_percent': (worst[0]-1)*100, 'worst_case': worst[1],
            'worst_repeated_handler_increase_percent': (max(repeated_handler_ratios)[0]-1)*100 if repeated_handler_ratios else None,
            'worst_handler_increase_percent': (max(handler_ratios)[0]-1)*100 if handler_ratios else None,
            'stable_read_bytes_max': max((r['bytes'] for r in reads), default=None),
            'stable_read_calls_max': max((r['calls'] for r in reads), default=None),
            'warmup_seconds': run['warmup_seconds'],
            'timing': timing, 'aggregate_timing_note': 'aggregate mixes input lengths; use per-case comparisons',
            'aggregate_median_seconds': statistics.median(times) if times else None})
    eligible = [c for c in summary['candidates'] if c['accepted'] and c.get('mode') not in (0, 255) and c.get('total_peak_bytes', baseline_memory) < baseline_memory]
    summary['best'] = min(eligible, key=lambda c: c['total_peak_bytes'])['name'] if eligible else None
    if final:
        upgrade = report['upgrade']
        require(upgrade.get('candidate') == summary['best'] and summary['best'] is not None,
                'normal build must match the best eligible measured candidate')
        require(upgrade.get('wasm_sha256') == report.get('artifact_hashes', {}).get('selected.wasm')
                and isinstance(upgrade.get('wasm_sha256'), str) and len(upgrade['wasm_sha256']) == 64,
                'normal build artifact hash mismatch')
        normal = upgrade.get('after_update', {}).get('management_memory_bytes')
        require(type(normal) is int and normal > 0, 'invalid normal build memory')
        selected = next(c for c in summary['candidates'] if c['name'] == summary['best'])
        require(normal < baseline_memory, 'normal build does not reduce memory')
        require(normal <= selected['total_peak_bytes'] + 1048576,
                'normal build exceeds measured candidate memory by more than 1 MiB')
        summary['normal_total_bytes'] = normal
        summary['normal_saved_bytes'] = baseline_memory - normal
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    parser.add_argument('--reference', default='source')
    parser.add_argument('--final', action='store_true')
    parser.add_argument('--output', type=Path,
                        help='Write JSON to a new file; existing files are never overwritten')
    args = parser.parse_args()
    raw = args.report.read_bytes()
    summary = summarize(json.loads(raw), args.reference, args.final)
    summary['raw_report_sha256'] = hashlib.sha256(raw).hexdigest()
    summary['analyzer_sha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    if args.output is not None:
        # Exclusive creation also refuses symlinks and output/report aliases.
        with args.output.open('x') as output:
            output.write(json.dumps(summary, indent=2)+'\n')
    print('| candidate | total MB | saved MB | worst instructions | accepted |')
    print('|---|---:|---:|---:|---|')
    for row in summary['candidates']:
        if 'total_bytes' not in row:
            print(f"| {row['name']} | — | — | — | incomplete |")
            continue
        print(f"| {row['name']} | {row['total_bytes']/1e6:.2f} | {row['saved_bytes']/1e6:.2f} | {row['worst_instruction_increase_percent']:+.3f}% | {row['accepted']} |")
    print(f"Best eligible candidate: {summary['best']}; JSON: {args.output or 'not written (read-only)'}")
    if args.final and summary['best'] is None:
        raise SystemExit('No final candidate passed all gates')


if __name__ == '__main__':
    main()
