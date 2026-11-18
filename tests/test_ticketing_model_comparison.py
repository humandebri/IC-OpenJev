"""Offline checks for the fixed comparison splits and reported metrics."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('compare_ticketing_models', ROOT/'tools/compare_ticketing_models.py')
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)


class TicketingComparisonTests(unittest.TestCase):
    def setUp(self):
        self.data = json.loads((ROOT/'fixtures/ticketing-ja/comparison/cases.json').read_text())

    def test_fixed_splits_are_disjoint_balanced_and_valid(self):
        comparison.validate_data(self.data)
        old = json.loads((ROOT/'fixtures/ticketing-ja/cases.json').read_text())
        old_evaluation = {row['text'] for row in old['evaluation']}
        self.assertFalse(old_evaluation & {row['text'] for split in ['train', 'validation', 'test'] for row in self.data[split]})

    def test_leakage_is_rejected(self):
        self.data['test'][0]['text'] = self.data['train'][0]['text']
        with self.assertRaisesRegex(ValueError, 'Overlapping'):
            comparison.validate_data(self.data)

    def test_changed_counts_and_labels_are_rejected(self):
        invalid = copy.deepcopy(self.data)
        invalid['validation'].pop()
        with self.assertRaises(ValueError):
            comparison.validate_data(invalid)
        self.data['test'][0]['department'] = 'unknown'
        with self.assertRaisesRegex(ValueError, 'Invalid labels'):
            comparison.validate_data(self.data)

    def test_always_high_is_not_high_priority_accuracy(self):
        rows = [dict(id=row['id'],
                     department=dict(expected=row['department'], selected='it'),
                     priority=dict(expected=row['priority'], selected='high')) for row in self.data['test']]
        result = comparison.metrics(rows)
        self.assertEqual(result['department']['accuracy'], 0.25)
        self.assertAlmostEqual(result['department']['macro_f1'], 0.1)
        self.assertEqual(result['priority']['accuracy'], 1/3)
        self.assertAlmostEqual(result['priority']['macro_f1'], 1/6)
        self.assertEqual(result['high_priority'], {'correct': 16, 'total': 16})
        self.assertEqual(result['joint_correct'], 4)


if __name__ == '__main__':
    unittest.main()
