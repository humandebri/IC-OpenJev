import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / 'tools'
spec = importlib.util.spec_from_file_location('ticketing_optimization', TOOLS/'optimize_ticketing_model.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FrozenCorpusTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        reference = Path(tmp.name)/'reference.json'
        reference.write_text(json.dumps({'corpus_sha256':
            '065da26af5048086cf2f55b1e57aee90373405063e8c665ed15153527579f40c'}))
        patcher = patch.object(module, 'REFERENCE_REPORT', reference)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_frozen_corpus_is_complete(self):
        with patch.object(sys, 'path', [str(TOOLS), *sys.path]):
            data = module.frozen_corpus()
        self.assertEqual((len(data['validation']), len(data['test'])), (24, 48))

    def test_omitting_the_disagreement_cannot_pass_the_gate(self):
        data = json.loads(module.CORPUS.read_text())
        data['test'] = [r for r in data['test'] if r['id'] != 'test-it-10']
        with tempfile.TemporaryDirectory() as tmp:
            corpus = Path(tmp)/'cases.json'
            corpus.write_text(json.dumps(data))
            with patch.object(module, 'CORPUS', corpus), patch.object(sys, 'path', [str(TOOLS), *sys.path]):
                with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
                    module.frozen_corpus()
                # A deliberate new reference hash still cannot hide the missing row.
                reference = Path(tmp)/'reference.json'
                reference.write_text(json.dumps({'corpus_sha256': hashlib.sha256(corpus.read_bytes()).hexdigest()}))
                with patch.object(module, 'REFERENCE_REPORT', reference):
                    with self.assertRaisesRegex(ValueError, 'expected 48 cases'):
                        module.frozen_corpus()
