import contextlib
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1]/'tools'
with patch.object(sys, 'path', [str(TOOLS), *sys.path]):
    spec = importlib.util.spec_from_file_location('prepare_cohost', TOOLS/'prepare_ticketing_cohost.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    from attach_candid import attach, MAGIC


class BundleFreezeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)/'repo'
        self.inputs = Path(self.temp.name)/'inputs'
        self.out = Path(self.temp.name)/'release'
        self.evidence = self.root/'evidence'
        self.wasm = self.root/'build/verdict-engine.wasm'
        self.did = b'service : { classify_ticket : (text) -> (text) query; }\n'
        self.good_wasm = attach(MAGIC, self.did)
        self.other_wasm = attach(MAGIC, b'service : {}\n')
        self.put(self.wasm, self.good_wasm)
        self.put(self.root/'build/verdict-engine.did', self.did)
        self.put(self.root/'target/release/ticketing-upload', b'tested uploader')
        self.put(self.root/'target/release/verdict-upload', b'legacy uploader')
        self.put(self.root/'docs/TICKETING_COHOST_PREPARATION.md', b'runbook')
        self.put(self.root/'code.rs', b'tested source')
        pack = self.root/'models/ticketing-ja/optimized-seed29-v1/int8'
        self.put(pack/'model.bin', b'weights')
        self.put(pack/'tokenizer.json', b'tokenizer')
        checkpoint = '12'*32
        self.write(pack/'manifest.json', dict(total_bytes=7, checkpoint_sha256=list(bytes.fromhex(checkpoint)),
            tokenizer_sha256=list(hashlib.sha256(b'tokenizer').digest()),
            tensors=[dict(name='weight', offset=0, length=7, sha256=list(hashlib.sha256(b'weights').digest()))]))
        pack_hash = module.sha(pack/'manifest.json')
        legacy = bytes(range(32)).hex()
        status = dict(module_hash='0x'+hashlib.sha256(self.other_wasm).hexdigest(), settings=dict(controllers=['owner']))
        for name in ['mainnet-before-status.json', 'mainnet-after-preparation-status.json']:
            self.write(self.inputs/name, status)
        self.put(self.inputs/'mainnet-before-info.txt',
            ('model = blob "'+''.join(f'\\{n:02x}' for n in range(32))+'"; warmed = true; callers = 0;').encode())
        self.put(self.inputs/'mainnet-owner-probe.txt', b'Err TooLong')
        self.put(self.inputs/'production-principal.txt', b'owner')
        self.put(self.inputs/'production-reference.wasm', self.other_wasm)
        self.put(self.inputs/'mainnet-before.did', b'service : {}\n')
        self.write(self.evidence/'local.json', dict(state='passed', query_limit=65,
            rollback_overlap_recovery=dict(passed=True),
            upload_cli=dict(success=True, binary_sha256=module.sha(self.root/'target/release/ticketing-upload')),
            source_hashes={'code.rs': module.sha(self.root/'code.rs')},
            hashes=dict(candidate_wasm=hashlib.sha256(self.good_wasm).hexdigest(),
                live_reference_wasm=status['module_hash'][2:], legacy_manifest=legacy, ticketing_manifest=pack_hash)))
        self.write(self.evidence/'native.json', dict(state='rejected', source_checkpoint_sha256=checkpoint,
            packs=dict(int8=dict(manifest_sha256=pack_hash))))
        self.write(self.evidence/'precision-acceptance.json', dict(accepted=True,
            checkpoint_sha256=checkpoint, manifest_sha256=pack_hash))

    @staticmethod
    def put(path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    @classmethod
    def write(cls, path, data):
        cls.put(path, json.dumps(data).encode())

    def prepare(self, run=None):
        with patch.object(module, 'ROOT', self.root), patch.object(module, 'EVIDENCE', self.evidence), \
             patch.object(module.subprocess, 'run', side_effect=run), contextlib.redirect_stdout(__import__('io').StringIO()):
            module.prepare(self.out, self.inputs)

    def test_parallel_rebuild_after_copy_cannot_change_the_frozen_payload(self):
        executed = []
        def rebuild(command, **kwargs):
            executed.append(Path(command[0]))
            self.wasm.write_bytes(self.other_wasm)
        self.prepare(run=rebuild)
        self.assertEqual(self.wasm.read_bytes(), self.other_wasm)
        self.assertEqual((self.out/'verdict-engine.wasm').read_bytes(), self.good_wasm)
        self.assertTrue(all(path == Path('didc') or 'staging-' in str(path) for path in executed))
        module.check(self.out)

    def test_rebuild_before_copy_is_rejected_without_publishing_output(self):
        original_copy = shutil.copy2
        def rebuild(source, target, **kwargs):
            if Path(source) == self.wasm:
                self.wasm.write_bytes(self.other_wasm)
            return original_copy(source, target, **kwargs)
        with patch.object(module.shutil, 'copy2', side_effect=rebuild):
            with self.assertRaisesRegex(ValueError, 'Candidate differs'):
                self.prepare()
        self.assertFalse(self.out.exists())
        self.assertFalse(list(self.out.parent.glob(self.out.name+'-staging-*')))

    def test_unverified_uploader_is_never_executed(self):
        original_copy = shutil.copy2
        def rebuild(source, target, **kwargs):
            if Path(source) == self.root/'target/release/ticketing-upload':
                Path(source).write_bytes(b'untested uploader')
            return original_copy(source, target, **kwargs)
        with patch.object(module.shutil, 'copy2', side_effect=rebuild), \
             patch.object(module.subprocess, 'run') as run:
            with patch.object(module, 'ROOT', self.root), patch.object(module, 'EVIDENCE', self.evidence):
                with self.assertRaisesRegex(ValueError, 'Uploader differs'):
                    module.prepare(self.out, self.inputs)
            run.assert_not_called()
        self.assertFalse(self.out.exists())

    def test_corrupted_copied_weights_are_rejected(self):
        path = self.root/'models/ticketing-ja/optimized-seed29-v1/int8/model.bin'
        path.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'Staged tensor mismatch'):
            self.prepare()
        self.assertFalse(self.out.exists())

    def test_check_binds_readiness_even_when_inventory_was_updated(self):
        self.prepare()
        ready = module.read(self.out/'readiness.json')
        ready['candidate_module'] = '0x'+hashlib.sha256(self.other_wasm).hexdigest()
        self.write(self.out/'readiness.json', ready)
        inventory = module.read(self.out/'manifest.json')
        inventory['files']['readiness.json'] = dict(bytes=(self.out/'readiness.json').stat().st_size,
            sha256=module.sha(self.out/'readiness.json'))
        self.write(self.out/'manifest.json', inventory)
        with self.assertRaisesRegex(ValueError, 'Readiness does not describe'):
            module.check(self.out)

    def test_existing_output_is_never_overwritten(self):
        self.out.mkdir()
        self.put(self.out/'keep', b'original')
        with self.assertRaises(FileExistsError):
            self.prepare()
        self.assertEqual((self.out/'keep').read_bytes(), b'original')

    def test_legacy_bundle_format_requires_regeneration(self):
        self.write(self.out/'manifest.json', dict(format_version=1, files={}))
        with self.assertRaisesRegex(ValueError, 'regenerate'):
            module.check(self.out)
