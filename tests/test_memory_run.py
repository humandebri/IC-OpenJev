"""Publication must never replace approved evidence on failure."""
import json
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import memory_run as runner
import test_memory_compare as fixtures


class Publication(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Path(self.tmp.name).resolve()
        self.directory = self.store / 'runs/example'
        self.directory.mkdir(parents=True)
        self.pointer = self.store / 'current.json'
        self.pointer.write_text('{"run":"previous"}\n')
        self.previous = self.pointer.read_bytes()
        for name in runner.FILES:
            path = self.directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(name.encode())
        self.code = patch.object(runner, 'code_hashes', return_value={'source': 'unchanged'})
        self.code.start()
        self.addCleanup(self.code.stop)
        manifest = runner.seal(self.directory)
        report = fixtures.ReviewRegressions().final_evidence()
        report['artifact_hashes'] = manifest['files']
        report['upgrade']['wasm_sha256'] = manifest['files']['selected.wasm']
        for run in report['runs'].values():
            run['wasm_sha256'] = manifest['files']['baseline/source.wasm' if run['mode'] == 255 else 'bench.wasm']
        self.report = report
        self.write_report()

    def write_report(self):
        (self.directory / 'final.json').write_text(json.dumps(self.report))

    def test_failed_validation_preserves_approved_pointer_and_wasm(self):
        self.report['upgrade']['after_update']['management_memory_bytes'] = 1000
        self.write_report()
        with self.assertRaises(ValueError): runner.publish(self.directory, self.store)
        self.assertEqual(self.pointer.read_bytes(), self.previous)
        self.assertEqual((self.directory / 'selected.wasm').read_bytes(), b'selected.wasm')

    def test_modified_or_mismatched_artifact_is_rejected(self):
        self.report['runs']['candidate']['wasm_sha256'] = 'wrong'
        self.write_report()
        with self.assertRaisesRegex(ValueError, 'Wasm'): runner.publish(self.directory, self.store)
        self.assertEqual(self.pointer.read_bytes(), self.previous)
        path = self.directory / 'selected.wasm'
        path.chmod(0o644)
        path.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'artifact changed'): runner.verify(self.directory)

    def test_resume_refuses_changed_source(self):
        with patch.object(runner, 'code_hashes', return_value={'source': 'changed'}):
            with self.assertRaisesRegex(ValueError, 'source changed'): runner.verify(self.directory)

    def test_unrelated_addition_does_not_invalidate_frozen_build_inventory(self):
        with patch.object(runner, 'code_hashes', return_value={'source': 'unchanged', 'unrelated.py': 'new'}):
            runner.verify(self.directory)

    def test_success_publishes_one_pointer_to_verified_evidence(self):
        runner.publish(self.directory, self.store)
        pointer = json.loads(self.pointer.read_text())
        self.assertEqual(pointer['run'], 'runs/example')
        self.assertEqual(pointer['report_sha256'], runner.digest(self.directory / 'final.json'))
        self.assertEqual(pointer['wasm_sha256'], runner.digest(self.directory / 'selected.wasm'))

    def test_approved_run_cannot_be_replayed_and_mutate_published_evidence(self):
        runner.publish(self.directory, self.store)
        with self.assertRaisesRegex(ValueError, 'immutable'):
            runner.require_resumable(self.directory)

    def test_interrupted_pointer_replacement_preserves_old_approval(self):
        original_replace = runner.os.replace
        def interrupt_pointer(src, dest):
            if dest == self.pointer:
                raise OSError('interrupted')
            return original_replace(src, dest)
        with patch.object(runner.os, 'replace', side_effect=interrupt_pointer):
            with self.assertRaises(OSError): runner.publish(self.directory, self.store)
        self.assertEqual(self.pointer.read_bytes(), self.previous)

    def evidence_snapshot(self):
        paths = [self.directory / name for name in runner.FILES]
        paths += [self.directory / name for name in ('manifest.json', 'final.json', 'final.summary.json', 'approved.json')]
        paths.append(self.pointer)
        return {path: (path.read_bytes(), path.stat().st_mtime_ns) for path in paths}

    def assert_snapshot_unchanged(self, snapshot):
        for path, (data, modified) in snapshot.items():
            self.assertEqual(path.read_bytes(), data, str(path))
            self.assertEqual(path.stat().st_mtime_ns, modified, str(path))

    def retry_through_cli(self, action):
        with patch.object(runner, 'STORE', self.store), \
             patch.object(sys, 'argv', ['memory_run.py', action, str(self.directory)]), \
             patch.object(runner, 'run') as execution:
            runner.main()
            execution.assert_not_called()  # No build, PocketIC, upload or inference.

    def interrupted_publish_then_retry(self, filename, after=False):
        destination = self.pointer if filename == 'current.json' else self.directory / filename
        original_replace = runner.os.replace
        def interrupt(src, dest):
            if dest == destination:
                if after:
                    original_replace(src, dest)
                raise OSError('interrupted publication')
            return original_replace(src, dest)
        with patch.object(runner.os, 'replace', side_effect=interrupt):
            with self.assertRaises(OSError): runner.publish(self.directory, self.store)
        if filename != 'current.json' or not after:
            self.assertEqual(self.pointer.read_bytes(), self.previous)
        sealed_before = None
        if (self.directory / 'approved.json').exists():
            sealed_before = {path: (path.read_bytes(), path.stat().st_mtime_ns)
                             for path in self.directory.iterdir() if path.is_file()}
        action = 'resume' if (self.directory / 'approved.json').exists() else 'publish'
        self.retry_through_cli(action)
        if sealed_before is not None:
            self.assert_snapshot_unchanged(sealed_before)
        pointer = json.loads(self.pointer.read_text())
        self.assertEqual(pointer['report_sha256'], runner.digest(self.directory / 'final.json'))
        self.assertEqual(pointer['summary_sha256'], runner.digest(self.directory / 'final.summary.json'))
        snapshot = self.evidence_snapshot()
        # Repeated retries are a no-op, including file modification times.
        with patch.object(runner, 'atomic_json', side_effect=AssertionError('unexpected rewrite')):
            self.retry_through_cli('publish')
            self.retry_through_cli('resume')
        self.assert_snapshot_unchanged(snapshot)

    def test_retry_after_summary_write_failure_without_measurement(self):
        self.interrupted_publish_then_retry('final.summary.json')

    def test_retry_after_approval_write_failure_without_measurement(self):
        self.interrupted_publish_then_retry('approved.json')

    def test_resume_finishes_interrupted_pointer_publication_without_measurement(self):
        self.interrupted_publish_then_retry('current.json')

    def test_retry_after_pointer_committed_before_interruption_is_noop(self):
        self.interrupted_publish_then_retry('current.json', after=True)

    def test_approved_report_change_is_rejected_without_replacing_pointer(self):
        runner.publish(self.directory, self.store)
        snapshot = self.evidence_snapshot()
        self.report['upgrade']['after_update']['management_memory_bytes'] = 899
        self.write_report()
        with self.assertRaisesRegex(ValueError, 'approved report changed'):
            runner.publish(self.directory, self.store)
        self.assert_snapshot_unchanged({p: v for p,v in snapshot.items() if p.name != 'final.json'})

    def test_approved_summary_bytes_are_pinned(self):
        runner.publish(self.directory, self.store)
        original_pointer = self.pointer.read_bytes()
        summary = self.directory / 'final.summary.json'
        summary.write_bytes(summary.read_bytes() + b'\n')
        with self.assertRaisesRegex(ValueError, 'summary_sha256'):
            runner.publish(self.directory, self.store)
        self.assertEqual(self.pointer.read_bytes(), original_pointer)

    def test_legacy_approval_retry_keeps_existing_summary_and_marker(self):
        runner.publish(self.directory, self.store)
        approval = self.directory / 'approved.json'
        old = json.loads(approval.read_text())
        runner.atomic_json(approval, {k:old[k] for k in ('report_sha256', 'wasm_sha256')})
        self.pointer.write_bytes(self.previous)
        snapshot = {p: (p.read_bytes(), p.stat().st_mtime_ns)
                    for p in self.directory.iterdir() if p.is_file()}
        self.retry_through_cli('resume')
        self.assert_snapshot_unchanged(snapshot)
        self.assertEqual(json.loads(self.pointer.read_text())['run'], 'runs/example')

    def analyze(self, *args):
        return subprocess.run([sys.executable, str(fixtures.MODULE), str(self.directory / 'final.json'), *args],
                              capture_output=True, text=True)

    def test_analyzer_default_and_final_leave_approved_evidence_unchanged(self):
        runner.publish(self.directory, self.store)
        snapshot = self.evidence_snapshot()
        for flags in ((), ('--final',)):
            result = self.analyze(*flags)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('read-only', result.stdout)
            self.assert_snapshot_unchanged(snapshot)

    def test_analyzer_writes_only_explicit_new_output(self):
        runner.publish(self.directory, self.store)
        snapshot = self.evidence_snapshot()
        output = self.store / 'rechecked.json'
        result = self.analyze('--final', '--output', str(output))
        self.assertEqual(result.returncode, 0, result.stderr)
        derived = json.loads(output.read_text())
        self.assertEqual(derived['normal_total_bytes'], 900)
        self.assertEqual(derived['raw_report_sha256'], runner.digest(self.directory / 'final.json'))
        self.assertIn('analyzer_sha256', derived)
        self.assert_snapshot_unchanged(snapshot)

    def test_analyzer_refuses_existing_paths_and_symlinks(self):
        runner.publish(self.directory, self.store)
        snapshot = self.evidence_snapshot()
        alias = self.store / 'alias.json'
        alias.symlink_to(self.directory / 'final.summary.json')
        for output in (self.directory / 'final.summary.json', self.directory / 'final.json', self.pointer, alias):
            result = self.analyze('--final', '--output', str(output))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('FileExistsError', result.stderr)
            self.assert_snapshot_unchanged(snapshot)


if __name__ == '__main__': unittest.main()
