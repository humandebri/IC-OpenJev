#!/usr/bin/env python3
"""Independently replay held-out placement logs and bind model turns to real replies."""
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts/tetris-search'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def piece_at(seed, index):
    state = seed & 0xffffffff or 0x9e3779b9
    for _ in range(index // 7 + 1):
        bag = list(range(7))
        for i in range(6, 0, -1):
            state ^= (state << 13) & 0xffffffff
            state ^= state >> 17
            state ^= (state << 5) & 0xffffffff
            j = state * (i + 1) // 4294967296
            bag[i], bag[j] = bag[j], bag[i]
    return bag[index % 7]


def after_board(before, piece, candidate):
    board = before[:]
    cells = candidate['cells']
    assert len(cells) == len(set(map(tuple, cells))) == 4
    for x, y in cells:
        assert 0 <= x < 10 and 0 <= y < 20 and board[y * 10 + x] == 0
        board[y * 10 + x] = piece + 1
    kept = [board[y:y + 10] for y in range(0, 200, 10) if 0 in board[y:y + 10]]
    lines = 20 - len(kept)
    board = [0] * (lines * 10) + [cell for row in kept for cell in row]
    holes = height = 0
    for x in range(10):
        covered = False
        for y in range(20):
            if board[y * 10 + x]:
                covered = True
                height = max(height, 20 - y)
            elif covered:
                holes += 1
    assert (lines, holes, height) == (candidate['lines'], candidate['holes'], candidate['height'])
    return board, lines


def main():
    summary = json.loads((OUT / 'test-summary.json').read_text())
    assert summary['complete'] and summary['authoritative']
    assert summary['query_errors'] == summary['budget_violations'] == 0
    protocol_raw = (OUT / 'test/protocol.json').read_bytes()
    assert sha(protocol_raw) == summary['protocol_sha256']
    protocol = json.loads(protocol_raw)
    assert protocol['seeds'] == list(range(30001, 30033))
    assert protocol['native'] is False
    assert sha((ROOT / 'web/tetris/public/tetris-evaluator.json').read_bytes()) == protocol['evaluator_hash']
    for path, expected in protocol['source_hashes'].items():
        assert sha((ROOT / path).read_bytes()) == expected, path
    validation = json.loads((OUT / 'validation-summary.json').read_text())
    assert validation['complete'] and len(validation['games']) == 384
    valid_protocol = json.loads((OUT / 'validation/protocol.json').read_text())
    assert valid_protocol['seeds'] == list(range(20001, 20065))
    assert valid_protocol['evaluator_hash'] == protocol['evaluator_hash']
    for path, expected in valid_protocol['source_hashes'].items():
        source = OUT / 'validation/runner-source.ts.txt' if path.endswith('/placement-study.ts') else ROOT / path
        assert sha(source.read_bytes()) == expected, path
    training = json.loads((OUT / 'training-summary.json').read_text())
    dataset = json.loads((OUT / 'dataset-summary.json').read_text())
    assert training['model_sha256'] == protocol['evaluator_hash']
    assert training['dataset_sha256'] == dataset['sha256']
    assert dataset['train_seeds'] == list(range(10001, 10257))
    assert dataset['valid_seeds'] == valid_protocol['seeds']
    assert not (set(dataset['train_seeds']) | set(dataset['valid_seeds'])) & set(protocol['seeds'])
    assert len(summary['games']) == len(summary['sources']) == 192
    seen, query_keys = set(), set()
    turns = model_turns = max_tokens = max_instructions = candidates_checked = 0
    for source in summary['sources']:
        raw = (OUT / source['path']).read_bytes()
        assert sha(raw) == source['sha256']
        game = json.loads(raw)
        key = (game['seed'], game['policy'])
        assert key not in seen
        seen.add(key)
        board, lines = [0] * 200, 0
        assert len(game['trace']) == game['pieces'] <= 128
        for turn, row in enumerate(game['trace']):
            assert row['turn'] == turn and row['before'] == board
            assert row['piece'] == piece_at(game['seed'], turn)
            assert row['next'] == piece_at(game['seed'], turn + 1)
            assert 0 <= row['selected'] < len(row['options'])
            for candidate in row['options']:
                after_board(board, row['piece'], candidate)
                candidates_checked += 1
            board, cleared = after_board(board, row['piece'], row['options'][row['selected']])
            assert board == row['after']
            lines += cleared
            if game['policy'].endswith('-model'):
                request, answer = row['request'], row['answer']
                assert answer['selected'] == row['selected']
                assert 1 <= answer['tokens'] <= 41
                assert 0 < int(answer['instructions']) < 5_000_000_000
                cache_key = sha(json.dumps(dict(request=request, model=protocol['model_digest'], host=protocol['target']['host'], canister=protocol['target']['canister']), separators=(',', ':')).encode())
                reply = json.loads((OUT / f'query-cache/{cache_key}.json').read_text())
                assert reply['selected'] == str(row['selected'])
                assert reply['ids'] == [o['id'] for o in request['options']]
                assert bytes(reply['model']).hex() == protocol['model_digest']
                assert reply['input_tokens'] == answer['tokens']
                assert int(reply['measured_instructions']) == int(answer['instructions'])
                assert all(math.isfinite(v) and 0 <= v <= 1 for v in reply['probabilities'])
                assert abs(sum(reply['probabilities']) - 1) <= .001
                assert reply['probabilities'][row['selected']] == max(reply['probabilities'])
                query_keys.add(cache_key)
                model_turns += 1
                max_tokens = max(max_tokens, answer['tokens'])
                max_instructions = max(max_instructions, int(answer['instructions']))
            else:
                assert row['request'] is None and row.get('answer') is None
                assert row['selected'] == row['recommended']
            turns += 1
        assert lines == game['lines']
        assert game['queries'] == (game['pieces'] if game['policy'].endswith('-model') else 0)
    assert seen == {(seed, policy) for seed in protocol['seeds'] for policy in protocol['policies']}
    def improves(a, b, factor):
        a, b = summary['summary'][a], summary['summary'][b]
        return (a['games'] == b['games'] == 32 and a['mean_lines'] >= b['mean_lines'] * factor
                and (factor == 1 or a['mean_lines'] > b['mean_lines'])
                and a['mean_pieces'] >= b['mean_pieces'] and a['early_rate'] <= b['early_rate'])
    lookahead = improves('lookahead-model', 'legacy-model', 1)
    learned = lookahead and improves('learned-model', 'lookahead-model', 1.1) and improves('learned-only', 'lookahead-only', 1.1)
    default = 'learned' if learned else 'lookahead' if lookahead else 'legacy'
    release = json.loads((ROOT / 'web/tetris/src/placement-release.json').read_text())
    assert release['default_policy'] == default
    assert release['lookahead'] == lookahead and release['learned'] == learned
    assert release['evidence_sha256'] == sha((OUT / 'test-summary.json').read_bytes())
    assert release['evaluator_hash'] == protocol['evaluator_hash']
    result = dict(passed=True, games=len(seen), turns=turns, model_turns=model_turns,
                  candidates_checked=candidates_checked, unique_real_replies=len(query_keys),
                  max_tokens=max_tokens, max_model_instructions=max_instructions,
                  protocol_sha256=sha(protocol_raw), audit_script_sha256=sha(Path(__file__).read_bytes()),
                  independent_checks=['seven-bag', 'board continuity', 'nonoverlapping four-cell placements',
                                      'line clears', 'holes and height', 'reply identity and selection',
                                      'cache provenance', 'query budget', 'seed/policy coverage', 'adoption gate and default configuration'])
    (OUT / 'audit.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
