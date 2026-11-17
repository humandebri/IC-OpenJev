#!/usr/bin/env python3
"""Run and publish a disposable local comparison. Publication is one atomic pointer."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tarfile
import uuid
from datetime import datetime, timezone

from memory_compare import summarize, require

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / 'artifacts/memory-optimization'
FILES = ('bench.wasm', 'selected.wasm', 'selected.did', 'baseline/source.wasm',
         'baseline/source.did', 'selected-names.json')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic_json(path, value):
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as f:
        tmp = Path(f.name)
        try:
            json.dump(value, f, indent=2)
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
    try:
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def code_hashes():
    paths = [p for folder in ('canisters', 'crates', 'tools', 'tests', '.cargo') for p in (ROOT / folder).rglob('*')
             if p.is_file() and p.suffix in ('.rs', '.toml', '.py', '.sh', '.wat')]
    paths += [ROOT / p for p in ('Cargo.lock', 'Cargo.toml', 'rust-toolchain.toml')]
    return {str(p.relative_to(ROOT)): digest(p) for p in sorted(paths)}


def seal(directory):
    require(not (directory / 'manifest.json').exists(), 'run is already sealed')
    manifest = {'files': {name: digest(directory / name) for name in FILES},
                'source_hashes': code_hashes()}
    atomic_json(directory / 'manifest.json', manifest)
    for name in FILES:
        (directory / name).chmod(0o444)
    return manifest


def verify(directory):
    manifest = json.loads((directory / 'manifest.json').read_text())
    for name in FILES:
        require(digest(directory / name) == manifest['files'][name], f'artifact changed: {name}')
    current = code_hashes()
    # The build inventory is frozen in the manifest/archive. Unrelated files
    # added after sealing do not change the frozen images or existing harness.
    require(all(current.get(name) == value for name, value in manifest['source_hashes'].items()),
            'source changed since run was sealed; start a new run')
    return manifest


def publish(directory, store=STORE):
    directory, store = directory.resolve(), store.resolve()
    run_relative = str(directory.relative_to(store))
    manifest = verify(directory)
    report_path = directory / 'final.json'
    raw = report_path.read_bytes()
    report = json.loads(raw)
    for name in ('bench.wasm', 'selected.wasm', 'baseline/source.wasm'):
        require(report['artifact_hashes'].get(name) == manifest['files'][name], f'report artifact mismatch: {name}')
    for run in report['runs'].values():
        name = 'baseline/source.wasm' if run['mode'] == 255 else 'bench.wasm'
        require(run['wasm_sha256'] == manifest['files'][name], 'measured Wasm hash mismatch')
    summary = summarize(report, final=True)
    summary['raw_report_sha256'] = hashlib.sha256(raw).hexdigest()
    approval_path = directory / 'approved.json'
    summary_path = directory / 'final.summary.json'
    report_hash = summary['raw_report_sha256']
    wasm_hash = manifest['files']['selected.wasm']
    manifest_hash = digest(directory / 'manifest.json')
    if approval_path.exists():
        # A completed validation seals the evidence, even if publishing the
        # pointer was interrupted. Retry only that pointer; never rewrite evidence.
        approval = json.loads(approval_path.read_text())
        require(approval.get('report_sha256') == report_hash, 'approved report changed')
        require(approval.get('wasm_sha256') == wasm_hash, 'approved Wasm changed')
        require(json.loads(summary_path.read_text()) == summary, 'approved summary changed')
        summary_hash = digest(summary_path)
        # Older approvals pinned only the report and Wasm. Recompute the strict
        # summary above to validate them without modifying their saved marker.
        for key, value in [('manifest_sha256', manifest_hash), ('summary_sha256', summary_hash)]:
            require(approval.get(key, value) == value, f'approved {key} changed')
    else:
        atomic_json(summary_path, summary)
        summary_hash = digest(summary_path)
        atomic_json(approval_path, {
            'report_sha256': report_hash,
            'wasm_sha256': wasm_hash,
            'manifest_sha256': manifest_hash,
            'summary_sha256': summary_hash,
        })
    pointer = {
        'run': run_relative,
        'manifest_sha256': manifest_hash,
        'report_sha256': report_hash,
        'summary_sha256': summary_hash,
        'wasm_sha256': wasm_hash,
    }
    pointer_path = store / 'current.json'
    if not pointer_path.exists() or json.loads(pointer_path.read_text()) != pointer:
        atomic_json(pointer_path, pointer)
    return summary


def require_resumable(directory):
    require(not (directory / 'approved.json').exists(), 'approved runs are immutable; start a new run')


def run(cmd, env=None, **kwargs):
    return subprocess.run(cmd, cwd=ROOT, env=env, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('final', 'resume', 'publish'), nargs='?', default='final')
    parser.add_argument('directory', nargs='?', type=Path)
    args = parser.parse_args()
    if args.action in ('resume', 'publish'):
        require(args.directory is not None, f'{args.action} requires an explicit sealed run directory')
        directory = args.directory.resolve()
        require(directory.parent == (STORE / 'runs').resolve(), 'run directory must be inside memory-optimization/runs')
    else:
        require(args.directory is None, 'final creates a unique run directory')
        run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8]
        directory = STORE / 'runs' / run_id
        directory.mkdir(parents=True)
    # Prevent concurrent resume/publication of this run. The OS releases it after interruption.
    with (directory / '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == 'publish' or (args.action == 'resume' and (directory / 'approved.json').exists()):
            result = publish(directory, STORE)
            print(f"Published {directory}: saved {result['normal_saved_bytes']} bytes; best={result['best']}")
            return
        if args.action == 'resume':
            require_resumable(directory)
        print(f'Measurement directory: {directory}', flush=True)
        env = os.environ.copy()
        if args.action == 'final':
            (directory / 'baseline').mkdir()
            for name in ('baseline/source.wasm', 'baseline/source.did', 'selected-names.json'):
                shutil.copyfile(STORE / name, directory / name)
            (directory / 'source.diff').write_bytes(run(['git', 'diff', '--binary', 'HEAD'], stdout=subprocess.PIPE).stdout)
            (directory / 'toolchain.txt').write_bytes(run(['rustc', '-Vv'], stdout=subprocess.PIPE).stdout)
            initial_sources = code_hashes()
            with tarfile.open(directory / 'source.tar.gz', 'w:gz') as archive:
                for name in initial_sources:
                    archive.add(ROOT / name, arcname=name, recursive=False)
            build_env = env.copy()
            metadata = json.loads(run(['cargo', 'metadata', '--no-deps', '--format-version', '1'], env, stdout=subprocess.PIPE).stdout)
            build_target = Path(metadata['target_directory']) / 'memory-runs' / directory.name
            build_env['CARGO_TARGET_DIR'] = str(build_target)
            run(['cargo', 'build', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'verdict-engine', '--lib', '--features', 'memory-bench'], build_env)
            wasm = build_target / 'wasm32-unknown-unknown/release/verdict_engine.wasm'
            shutil.copyfile(wasm, directory / 'bench.wasm')
            run(['cargo', 'build', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'verdict-engine', '--lib'], build_env)
            shutil.copyfile(wasm, directory / 'selected.wasm')
            with (directory / 'selected.did').open('wb') as f:
                run(['cargo', 'run', '--quiet', '-p', 'verdict-engine', '--example', 'verdict-engine-export'], build_env, stdout=f)
            require((directory / 'selected.did').read_bytes() == (directory / 'baseline/source.did').read_bytes(), 'public Candid changed')
            run(['python3', 'tools/attach_candid.py', 'embed', str(directory / 'selected.wasm'), str(directory / 'selected.did')])
            require(initial_sources == code_hashes(), 'source changed during build; start a new run')
            seal(directory)
        verify(directory)
        env.update(MEMORY_ARTIFACT_DIR=str(directory), MEMORY_NAMES_FILE=str(directory / 'selected-names.json'),
                   MEMORY_OUT=str(directory / 'final.json'), MEMORY_REPEATS='15', MEMORY_EXTRA_DIAGNOSTICS='1',
                   MEMORY_UPGRADE='1', MEMORY_RUNS='source:255:262144,legacy:0:262144,selected:7:1048576:18')
        for key in ('MEMORY_CASE_FILTER', 'MEMORY_WARM_ONLY', 'MEMORY_RESUME'):
            env.pop(key, None)
        if args.action == 'resume':
            require((directory / 'final.json').exists(), 'resume checkpoint missing')
            env['MEMORY_RESUME'] = '1'
        run(['cargo', 'test', '-p', 'verdict-engine', '--test', 'memory_optimization', '--', '--ignored', '--nocapture'], env)
        result = publish(directory)
        print(f"Published {directory}: saved {result['normal_saved_bytes']} bytes; best={result['best']}")


if __name__ == '__main__':
    main()
