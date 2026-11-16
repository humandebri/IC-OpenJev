#!/usr/bin/env python3
"""Replay the new Jev policy search and quantify paired held-out gains."""
import hashlib
import json
import random
import statistics
import sys
from pathlib import Path
from audit_tetris_search import piece_at, after_board

ROOT = Path(__file__).resolve().parents[1]
OUT = (ROOT / sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / 'artifacts/tetris-jev-search'

def sha(data):
    return hashlib.sha256(data).hexdigest()

def rank(value, values):
    return 'equal' if min(values) == max(values) else 'min' if value == min(values) else 'max' if value == max(values) else 'mid'

def paired_ci(values):
    rng = random.Random(1729)
    means = sorted(sum(values[rng.randrange(len(values))] for _ in values) / len(values) for _ in range(10000))
    return dict(ci95=[means[249], means[9749]], ci97_5=[means[124], means[9874]])

def main():
    protocol_raw = (OUT / 'protocol.json').read_bytes()
    protocol = json.loads(protocol_raw)
    for path, expected in protocol['sources'].items():
        source = ROOT / path
        if sha(source.read_bytes()) != expected and (path.endswith('/jev-cost-confirmation.ts') or path.endswith('/jev-search.ts')):
            source = OUT / 'runner-source.ts.txt'
        assert sha(source.read_bytes()) == expected, path
    confirmation = 'primary_config' in protocol
    if confirmation:
        parent = ROOT / 'artifacts/tetris-jev-search'
        assert sha((parent / 'protocol.json').read_bytes()) == protocol['parent_development_protocol_sha256']
        phases = {'test': json.loads((OUT / 'test-summary.json').read_text())}
        selected = protocol['primary_config']
        assert selected == 'top2-cost' and protocol['secondary_config'] == 'top2'
        assert len(phases['test']['games']) == 192
        assert protocol['test_seeds'] == list(range(50001, 50033))
        assert not set(protocol['test_seeds']) & set(range(40001, 40033))
    else:
        phases = {phase: json.loads((OUT / f'{phase}-summary.json').read_text()) for phase in ('screen', 'validate', 'test')}
        assert len(phases['screen']['games']) == 128 and len(phases['validate']['games']) == 32 and len(phases['test']['games']) == 160
        selected = json.loads((OUT / 'selection.json').read_text())['selected']
        assert selected == next(v['config'] for v in phases['validate']['summary'] if v['config'] != 'current')
        assert protocol['test_seeds'] == list(range(40001, 40033))
    assert all(v['complete'] and v['protocol_sha256'] == sha(protocol_raw) for v in phases.values())
    assert not set(protocol['test_seeds']) & set(protocol['development_seeds'] + protocol['validation_seeds'] + list(range(30001, 30033)))
    target = json.loads((OUT / 'test-target.json').read_text())
    assert target['wasm_sha256'] == sha((ROOT / 'build/compat-model-query/verdict-engine.wasm').read_bytes())
    games, seen, cache_keys = {}, set(), set()
    turns = model_turns = candidates = one_option = max_tokens = max_instructions = 0
    roles = {}
    for source in phases['test']['sources']:
        raw = (OUT / source['path']).read_bytes()
        assert sha(raw) == source['sha256']
        game = json.loads(raw)
        key = (game['seed'], game['config'], game['policy'])
        assert key not in seen
        seen.add(key)
        games[key] = game
        board, lines = [0] * 200, 0
        config = next(c for c in protocol['configs'] if c['id'] == game['config'])
        assert len(game['trace']) == game['pieces'] <= 128
        for turn, row in enumerate(game['trace']):
            assert row['turn'] == turn and row['before'] == board
            assert row['piece'] == piece_at(game['seed'], turn) and row['next'] == piece_at(game['seed'], turn + 1)
            resulting = set()
            for c in row['options']:
                result, _ = after_board(board, row['piece'], c)
                resulting.add(tuple(bool(v) for v in result))
                candidates += 1
            assert len(resulting) == len(row['options'])
            board, clears = after_board(board, row['piece'], row['options'][row['selected']])
            assert row['after'] == board
            lines += clears
            if game['policy'] == 'model':
                request, reply = row['request'], row['reply']
                assert row['selected'] == reply['selected']
                assert len(request['options']) == len(row['options'])
                assert reply['tokens'] <= 41 and 0 < int(reply['instructions']) < 5_000_000_000
                f = [c['search'] for c in row['options']]
                if config['prompt'] == 'relative':
                    holes, heights, totals = [v['holes'] for v in f], [v['height'] for v in f], [v['total_lines'] for v in f]
                    missed = [max(totals) - t for t in totals]
                    assert [o['text'] for o in request['options']] == [f'{rank(h, holes)} holes,{rank(y, heights)} height,{rank(m, missed)} missed' for h, y, m in zip(holes, heights, missed)]
                elif config['prompt'] == 'cost':
                    best = max(v['score'] for v in f)
                    assert request['state'] == 'Min cost'
                    assert [o['text'] for o in request['options']] == [f"cost {best - v['score']}" for v in f]
                cache_key = sha(json.dumps(dict(request=request, model=protocol['model_digest'], target=target), separators=(',', ':')).encode())
                actual = json.loads((OUT / f'query-cache/{cache_key}.json').read_text())
                assert actual['selected'] == str(row['selected'])
                assert actual['ids'] == [o['id'] for o in request['options']]
                assert bytes(actual['model']).hex() == protocol['model_digest']
                assert actual['input_tokens'] == reply['tokens'] and int(actual['measured_instructions']) == int(reply['instructions'])
                cache_keys.add(cache_key)
                r = roles.setdefault(game['config'], dict(turns=0, choices_with_two_or_more=0, first_choice=0, non_best_score=0, differing_from_recommendation=0, indistinguishable_descriptions=0))
                r['turns'] += 1
                r['choices_with_two_or_more'] += len(row['options']) > 1
                r['first_choice'] += row['selected'] == 0
                r['non_best_score'] += f[row['selected']]['score'] < max(v['score'] for v in f)
                r['differing_from_recommendation'] += row['selected'] != row['recommended']
                r['indistinguishable_descriptions'] += len(set(o['text'] for o in request['options'])) == 1
                one_option += len(row['options']) == 1
                model_turns += 1
                max_tokens = max(max_tokens, reply['tokens'])
                max_instructions = max(max_instructions, int(reply['instructions']))
            else:
                assert row['request'] is None and row['reply'] is None
                if game['policy'] in ('evaluator', 'full'):
                    assert row['selected'] == row['recommended']
            turns += 1
        assert game['lines'] == lines
    required = {(seed, cfg, policy) for seed in protocol['test_seeds'] for cfg, policy in [('current', 'model'), (selected, 'model'), (selected, 'evaluator'), (selected, 'random'), (selected, 'full')]}
    if confirmation:
        required |= {(seed, protocol['secondary_config'], 'model') for seed in protocol['test_seeds']}
    assert seen == required
    comparisons = {}
    controls = [('current_Jev', 'current', 'model'), ('same_candidates_evaluator', selected, 'evaluator'), ('same_candidates_random', selected, 'random'), ('full_search', selected, 'full')]
    if confirmation: controls.append(('relative_top2_Jev', protocol['secondary_config'], 'model'))
    for name, cfg, policy in controls:
        differences = [games[seed, selected, 'model']['lines'] - games[seed, cfg, policy]['lines'] for seed in protocol['test_seeds']]
        ci=paired_ci(differences)
        comparisons[name] = dict(mean_line_gain=statistics.mean(differences), paired_bootstrap_95pct=ci['ci95'],paired_bootstrap_97_5pct=ci['ci97_5'], wins=sum(v > 0 for v in differences), ties=sum(v == 0 for v in differences), losses=sum(v < 0 for v in differences))
    result = dict(passed=True, games=len(seen), turns=turns, model_turns=model_turns, candidates_checked=candidates,
                  distinct_actual_query_replies=len(cache_keys), single_option_model_turns=one_option,
                  max_tokens=max_tokens, max_instructions=max_instructions, selected=selected,
                  model_role=roles, comparisons=comparisons, protocol_sha256=sha(protocol_raw),
                  selected_policy_sha256=sha(json.dumps(next(c for c in protocol['configs'] if c['id']==selected),sort_keys=True).encode()),
                  audit_source_sha256=sha(Path(__file__).read_bytes()),
                  target_wasm_sha256=target['wasm_sha256'], model_digest=protocol['model_digest'])
    (OUT / 'audit.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))

if __name__ == '__main__':
    main()
