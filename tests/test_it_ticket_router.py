import importlib.util
import json
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('it_router',ROOT/'tools/train_it_ticket_router.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class ITTicketRoutingTests(unittest.TestCase):
    def test_fixed_corpus_has_disjoint_balanced_splits(self):
        data=module.validate(json.loads((ROOT/'fixtures/ticketing-ja/it-routing/cases.json').read_text()))
        self.assertEqual([len(data[s]) for s in module.COUNTS],[96,24,48])
        data['test'][0]['text']=data['train'][0]['text']
        with self.assertRaisesRegex(ValueError,'overlapping'):module.validate(data)
    def test_outside_scope_escape_disables_routing_instead_of_relaxing_the_gate(self):
        known=dict(expected_queue='account',expected_priority='normal',queue_probabilities=[1.,0.,0.,0.],priority_probabilities=[0.,1.,0.])
        rows=[dict(known,id=str(i)) for i in range(8)]+[dict(known,id='outside',expected_queue='review')]
        thresholds,passed=module.select_thresholds(rows)
        self.assertFalse(passed)
        self.assertTrue(all(module.decision(r,thresholds)=='review' for r in rows))
        metric=module.metrics(rows,(.5,0,.5))
        self.assertEqual(metric['in_scope_coverage'],1)
        self.assertEqual(metric['review_caught'],0)
        self.assertFalse(module.passes(metric))
