"""Acceptance-gate tests: corrupted evidence and regressions must fail closed."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

MODULE = Path(__file__).resolve().parents[1] / 'tools' / 'memory_compare.py'
spec = importlib.util.spec_from_file_location('memory_compare', MODULE)
compare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compare)


def evidence():
    corpus = [{'name': 'short', 'ids': [1, 3, 2], 'request': {}, 'require_decision_query': True}]
    digest = hashlib.sha256(json.dumps(corpus, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    regular = {'query': 'ok', 'model': 'frozen', 'tokens': 3,
               'logit_bits': [1065353216], 'model_instructions': 100,
               'decision_query': 'ok', 'decision': {'logit_bits': [1065353216], 'probability_bits': [1065353216], 'selected': '0', 'tokens': 3, 'model_instructions': 100}}
    diag = {'logit_bits': regular['logit_bits'], 'instructions_through_argument_decode': 200,
            'io': {'heap_peak': 300, 'bytes': 0, 'calls': 0}}
    def run(mode, total):
        return {'mode': mode, 'warmup_seconds': 1,
                'stable_sha256_before_samples': 'unchanged', 'stable_sha256_after_samples': 'unchanged',
                'after_update': {'management_memory_bytes': total, 'heap_bytes': 300, 'stable_bytes': 600},
                'cases': [{'name': 'short', 'regular': copy.deepcopy(regular),
                           **({'diagnostic': copy.deepcopy(diag)} if mode != 255 else {})}], 'samples': []}
    return {'corpus': corpus, 'corpus_sha256': digest,
            'runs': {'source': run(255, 1000), 'legacy': run(0, 1000), 'candidate': run(7, 900)}}


def add_upgrade(report):
    report['artifact_hashes'] = {'selected.wasm': 'a'*64}
    report['upgrade'] = {'passed': True, 'candidate': 'candidate', 'wasm_sha256': 'a'*64,
        'after_update': {'management_memory_bytes': 900},
        'cases': [{'name': 'short', 'regular': copy.deepcopy(report['runs']['source']['cases'][0]['regular'])}]}


class MemoryAcceptance(unittest.TestCase):
    def candidate(self, report, **kwargs):
        return next(c for c in compare.summarize(report, **kwargs)['candidates'] if c['name'] == 'candidate')

    def test_five_percent_is_cumulative_against_frozen_source(self):
        report = evidence()
        report['runs']['candidate']['cases'][0]['regular']['model_instructions'] = 105
        self.assertTrue(self.candidate(report)['accepted'])
        report['runs']['candidate']['cases'][0]['regular']['model_instructions'] = 106
        self.assertFalse(self.candidate(report)['accepted'])

    def test_handler_budget_is_separate_from_forward_counter(self):
        report = evidence()
        report['runs']['candidate']['cases'][0]['diagnostic']['instructions_through_argument_decode'] = 211
        self.assertFalse(self.candidate(report)['accepted'])

    def test_bit_drift_and_lost_query_availability_are_rejected(self):
        for field, value in [('logit_bits', [1065353217]), ('query', 'replica:instruction_limit')]:
            report = evidence()
            report['runs']['candidate']['cases'][0]['regular'][field] = value
            self.assertFalse(self.candidate(report)['accepted'])

    def test_incomplete_candidate_or_changed_corpus_does_not_pass(self):
        report = evidence()
        report['runs']['candidate']['cases'] = []
        self.assertFalse(self.candidate(report)['accepted'])
        report = evidence()
        report['corpus'][0]['ids'][0] = 99
        with self.assertRaisesRegex(ValueError, 'corpus hash'):
            self.candidate(report)

    def test_final_run_requires_fifteen_matching_samples(self):
        report = evidence()
        add_upgrade(report)
        for name in ['legacy', 'candidate']:
            report['runs'][name]['samples'] = [
                {'name': 'short', 'round': i//5, 'repeat': i%5,
                 'result': {'nonce': i, 'logit_bits': [1065353216],
                            'wall_seconds': 1, 'path': 'query', 'instructions_through_argument_decode': 200}} for i in range(15)]
        self.assertTrue(self.candidate(report, final=True)['accepted'])
        report['runs']['candidate']['samples'].pop()
        with self.assertRaises(ValueError): self.candidate(report, final=True)

    def test_final_report_cannot_omit_upgrade_verification(self):
        with self.assertRaisesRegex(ValueError, 'upgrade'):
            compare.summarize(evidence(), final=True)

    def test_repeated_nonces_do_not_count_as_independent_trials(self):
        report = evidence()
        add_upgrade(report)
        for name in ['legacy', 'candidate']:
            report['runs'][name]['samples'] = [
                {'name': 'short', 'round': i//5, 'repeat': i%5,
                 'result': {'nonce': 0, 'logit_bits': [1065353216],
                            'wall_seconds': 1, 'path': 'query', 'instructions_through_argument_decode': 200}} for i in range(15)]
        with self.assertRaises(ValueError): self.candidate(report, final=True)

    def test_memory_growth_during_repetitions_cannot_be_hidden(self):
        report = evidence()
        report['runs']['candidate']['after_samples'] = {
            'management_memory_bytes': 2000, 'heap_bytes': 1300}
        result = self.candidate(report)
        self.assertEqual(result['total_bytes'], 2000)
        self.assertEqual(result['saved_bytes'], -1000)
        self.assertIsNone(compare.summarize(report)['best'])



class ReviewRegressions(unittest.TestCase):
    def final_evidence(self):
        report=evidence()
        add_upgrade(report)
        for name in ['legacy','candidate']:
            report['runs'][name]['samples']=[{'name':'short','round':i//5,'repeat':i%5,'result':{'nonce':i,'logit_bits':[1065353216],'wall_seconds':1,'path':'query','instructions_through_argument_decode':200}} for i in range(15)]
        return report
    def test_repeated_handler_regression_is_rejected(self):
        report=self.final_evidence()
        report['runs']['candidate']['samples'][0]['result']['instructions_through_argument_decode']=211
        with self.assertRaises(ValueError): compare.summarize(report, final=True)
    def test_corrupt_upgrade_evidence_cannot_be_accepted_by_passed_flag(self):
        report=self.final_evidence()
        report['upgrade']['cases'][0]['regular']['logit_bits']=[0]
        with self.assertRaises(ValueError):compare.summarize(report,final=True)

    def test_transient_query_peak_must_reduce_capacity_to_be_eligible(self):
        report=evidence()
        report['runs']['candidate']['cases'][0]['diagnostic']['io']['heap_peak']=1500
        self.assertIsNone(compare.summarize(report)['best'])
    def test_changed_stable_state_rejects_final_evidence(self):
        report=self.final_evidence()
        report['runs']['candidate']['stable_sha256_after_samples']='changed'
        with self.assertRaises(ValueError):compare.summarize(report,final=True)
    def test_non_finite_instruction_counter_is_not_a_passing_ratio(self):
        report=evidence()
        report['runs']['candidate']['cases'][0]['regular']['model_instructions']=float('nan')
        with self.assertRaises(ValueError):compare.summarize(report)


class PublicQueryAndNormalCapacity(unittest.TestCase):
    final_evidence = ReviewRegressions.final_evidence
    def test_public_query_failure_cannot_hide_behind_successful_update(self):
        report = evidence()
        report['runs']['candidate']['cases'][0]['regular']['decision_query'] = 'application:unavailable'
        self.assertFalse(next(c for c in compare.summarize(report)['candidates'] if c['name']=='candidate')['accepted'])

    def test_public_query_upgrade_regression_is_rejected(self):
        report = self.final_evidence()
        report['upgrade']['cases'][0]['regular']['decision_query'] = 'replica:limit'
        with self.assertRaisesRegex(ValueError, 'public query'): compare.summarize(report, final=True)

    def test_normal_build_memory_and_artifact_are_required(self):
        for value in (None, 0, -1, float('nan'), 1000, 2000):
            report = self.final_evidence()
            report['upgrade']['after_update']['management_memory_bytes'] = value
            with self.subTest(value=value), self.assertRaises(ValueError): compare.summarize(report, final=True)
        report = self.final_evidence()
        report['upgrade']['wasm_sha256'] = 'b'*64
        with self.assertRaisesRegex(ValueError, 'hash'): compare.summarize(report, final=True)

    def test_normal_build_must_remain_close_to_selected_policy(self):
        report = self.final_evidence()
        report['runs']['source']['after_update']['management_memory_bytes'] = 10_000_000
        report['upgrade']['after_update']['management_memory_bytes'] = 2_000_000
        with self.assertRaisesRegex(ValueError, '1 MiB'): compare.summarize(report, final=True)

    def test_missing_baseline_public_success_is_rejected(self):
        report = self.final_evidence()
        report['runs']['source']['cases'][0]['regular']['decision_query'] = 'application:unavailable'
        with self.assertRaisesRegex(ValueError, 'witness'): compare.summarize(report, final=True)


if __name__ == '__main__':
    unittest.main()
