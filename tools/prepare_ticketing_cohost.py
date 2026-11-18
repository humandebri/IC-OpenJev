#!/usr/bin/env python3
"""Freeze tested cohost artifacts locally. No network, deploy or identity access."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from attach_candid import metadata_content
from local_integration import decode_blobs

ROOT = Path(__file__).resolve().parents[1]
DEFAULT = ROOT/'build/ticketing-cohost-prep-20261118-r3'
DEFAULT_INPUTS = ROOT/'build/ticketing-cohost-prep-20261118'
EVIDENCE = ROOT/'artifacts/ticketing-ja/cohost/secp256k1'
FORMAT_VERSION = 2
INPUT_FILES = (
    'mainnet-before-status.json', 'mainnet-after-preparation-status.json',
    'mainnet-before-info.txt', 'mainnet-owner-probe.txt',
    'production-principal.txt', 'production-reference.wasm', 'mainnet-before.did',
)


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024*1024), b''): h.update(chunk)
    return h.hexdigest()


def read(path):
    return json.loads(path.read_text())


def write(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n')


def relative(name):
    path = Path(name)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError(f'Invalid bundle path: {name}')
    return path


def require_hash(path, expected, label):
    if sha(path) != expected:
        raise ValueError(f'{label} differs from verified artifact')


def verify_pack(pack):
    manifest = read(pack/'manifest.json')
    model = pack/'model.bin'
    if model.stat().st_size != manifest['total_bytes']:
        raise ValueError('Staged model length mismatch')
    require_hash(pack/'tokenizer.json', bytes(manifest['tokenizer_sha256']).hex(), 'Tokenizer')
    with model.open('rb') as f:
        for entry in manifest['tensors']:
            f.seek(entry['offset'])
            remaining = entry['length']
            digest = hashlib.sha256()
            while remaining:
                data = f.read(min(remaining, 1024*1024))
                if not data:
                    raise ValueError('Staged model truncated')
                digest.update(data)
                remaining -= len(data)
            if digest.digest() != bytes(entry['sha256']):
                raise ValueError(f'Staged tensor mismatch: {entry["name"]}')


def verify_payload(out):
    """Bind the copied payload to copied evidence, never to mutable build paths."""
    local = read(out/'verification/local.json')
    native = read(out/'verification/native.json')
    acceptance = read(out/'precision-acceptance.json')
    status = read(out/'mainnet-before-status.json')
    after = read(out/'mainnet-after-preparation-status.json')
    info = (out/'mainnet-before-info.txt').read_text()
    probe = (out/'mainnet-owner-probe.txt').read_text()
    principal = (out/'production-principal.txt').read_text().strip()
    if after['module_hash'] != status['module_hash']:
        raise ValueError('Live module changed during preparation')
    if decode_blobs(info)[0].hex()!=local['hashes']['legacy_manifest'] or 'warmed = true' not in info:
        raise ValueError('Live legacy model differs or is not warm')
    if 'callers = 0' not in info or 'TooLong' not in probe or 'Unauthorized' in probe:
        raise ValueError('Read-only owner probe did not establish owner access')
    if principal not in status['settings']['controllers']:
        raise ValueError('Production principal is not a captured controller')
    if local['state']!='passed' or not local['upload_cli']['success']:
        raise ValueError('Local cohost/CLI test incomplete')
    if not local.get('rollback_overlap_recovery', {}).get('passed'):
        raise ValueError('Rollback overlap recovery test missing')
    require_hash(out/'verdict-engine.wasm', local['hashes']['candidate_wasm'], 'Candidate')
    require_hash(out/'tools/ticketing-upload', local['upload_cli']['binary_sha256'], 'Uploader')
    if 'legacy_upload_cli' in local:
        if not local['legacy_upload_cli']['success']:
            raise ValueError('Legacy uploader test incomplete')
        require_hash(out/'tools/verdict-upload', local['legacy_upload_cli']['binary_sha256'], 'Legacy uploader')
    require_hash(out/'production-reference.wasm', status['module_hash'].removeprefix('0x'), 'Rollback')
    if local['hashes']['live_reference_wasm'] != status['module_hash'].removeprefix('0x'):
        raise ValueError('Local test used a different rollback module')
    for name, digest in local['source_hashes'].items():
        require_hash(out/'source'/relative(name), digest, f'Source {name}')
    pack = out/'ticketing-pack'
    pack_hash = sha(pack/'manifest.json')
    if any(pack_hash != value for value in [native['packs']['int8']['manifest_sha256'],
            local['hashes']['ticketing_manifest'], acceptance['manifest_sha256']]):
        raise ValueError('Precision acceptance and verification refer to different packs')
    if not acceptance['accepted'] or acceptance['checkpoint_sha256']!=native['source_checkpoint_sha256']:
        raise ValueError('Checkpoint acceptance differs')
    if bytes(read(pack/'manifest.json')['checkpoint_sha256']).hex()!=acceptance['checkpoint_sha256']:
        raise ValueError('Pack checkpoint differs from acceptance')
    verify_pack(pack)
    if metadata_content((out/'verdict-engine.wasm').read_bytes()) != [(out/'verdict-engine.did').read_bytes()]:
        raise ValueError('Candid differs from the verified Wasm metadata')
    return local, native, status, pack_hash, principal


def check(out):
    manifest = read(out/'manifest.json')
    if manifest.get('format_version') != FORMAT_VERSION:
        raise ValueError('Bundle predates artifact binding checks; regenerate it')
    required = {'verdict-engine.wasm', 'verdict-engine.did', 'readiness.json',
                'verification/local.json', 'ticketing-pack/model.bin'}
    if not required.issubset(manifest['files']):
        raise ValueError('Incomplete bundle inventory')
    for name, expected in manifest['files'].items():
        file = out/relative(name)
        if file.stat().st_size!=expected['bytes'] or sha(file)!=expected['sha256']:
            raise ValueError(f'Bundle mismatch: {name}')
    local, native, status, pack_hash, principal = verify_payload(out)
    ready = read(out/'readiness.json')
    expected = dict(state='prepared', deployed=False, expected_module=status['module_hash'],
                    candidate_module='0x'+local['hashes']['candidate_wasm'],
                    legacy_model=local['hashes']['legacy_manifest'], ticketing_model=pack_hash,
                    verified_owner_principal=principal, precision_gate=native['state'])
    if any(ready.get(key)!=value for key,value in expected.items()):
        raise ValueError('Readiness does not describe the verified payload')
    print(f'Bundle verified: {len(manifest["files"])} files; no network calls')


def copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def prepare(out, inputs=None, evidence=None):
    inputs = inputs or DEFAULT_INPUTS
    evidence = evidence or EVIDENCE
    if out.exists():
        raise FileExistsError('Output already exists; choose a new bundle or use --check')
    out.parent.mkdir(parents=True, exist_ok=True)
    # A private staging directory shares the output filesystem so publication is
    # atomic. Parallel builds may change ROOT/build, but cannot change this copy.
    with tempfile.TemporaryDirectory(prefix=out.name+'-staging-', dir=out.parent) as temp:
        stage = Path(temp)/'bundle'
        stage.mkdir()
        for name in INPUT_FILES:
            copy(inputs/name, stage/name)
        copies = {
            ROOT/'build/verdict-engine.wasm': 'verdict-engine.wasm',
            ROOT/'build/verdict-engine.did': 'verdict-engine.did',
            ROOT/'target/release/ticketing-upload': 'tools/ticketing-upload',
            ROOT/'target/release/verdict-upload': 'tools/verdict-upload',
            evidence/'local.json': 'verification/local.json',
            evidence/'native.json': 'verification/native.json',
            evidence/'precision-acceptance.json': 'precision-acceptance.json',
            ROOT/'docs/TICKETING_COHOST_PREPARATION.md': 'DEPLOYMENT.md',
            Path(__file__): 'source/tools/prepare_ticketing_cohost.py',
        }
        pack = ROOT/'models/ticketing-ja/optimized-seed29-v1/int8'
        copies.update({pack/name: 'ticketing-pack/'+name for name in ['manifest.json','model.bin','tokenizer.json']})
        for source, name in copies.items():
            copy(source, stage/name)
        for source in read(stage/'verification/local.json')['source_hashes']:
            name = relative(source)
            copy(ROOT/name, stage/'source'/name)
        local, native, status, pack_hash, principal = verify_payload(stage)
        if not local.get('legacy_upload_cli', {}).get('success'):
            raise ValueError('Legacy uploader verification required for new bundles')
        subprocess.run(['didc', 'check', str(stage/'verdict-engine.did'), str(stage/'mainnet-before.did')], check=True)
        subprocess.run([str(stage/'tools/ticketing-upload'), '--pack', str(stage/'ticketing-pack'), '--check-only'], check=True)
        write(stage/'readiness.json', dict(state='prepared', deployed=False,
            canister='qojfj-6qaaa-aaaam-qjkaq-cai', expected_module=status['module_hash'],
            candidate_module='0x'+local['hashes']['candidate_wasm'],
            legacy_model=local['hashes']['legacy_manifest'], ticketing_model=pack_hash,
            verified_owner_principal=principal, local_query_limit=local['query_limit'],
            api_backward_compatible=True, precision_gate=native['state'],
            precision_policy='accepted_by_user_for_this_pack', local_cohost_test='passed',
            signed_http_uploader_test='passed', rollback_test='passed',
            rollback_overlap_recovery_test='passed', mainnet_mutations=False,
            remaining='Explicit request to deploy; recheck live module, models, cycles and identity before mutation'))
        files = {str(p.relative_to(stage)): dict(bytes=p.stat().st_size, sha256=sha(p))
                 for p in sorted(stage.rglob('*')) if p.is_file()}
        write(stage/'manifest.json', dict(format_version=FORMAT_VERSION,
              created_at=datetime.now(timezone.utc).isoformat(), files=files))
        inventory = {name:entry['sha256'] for name,entry in files.items()}
        inventory['manifest.json'] = sha(stage/'manifest.json')
        (stage/'SHA256SUMS').write_text(''.join(f'{digest}  {name}\n' for name,digest in sorted(inventory.items())))
        check(stage)
        os.rename(stage, out)
    print(f'Prepared bundle: {out}')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--out', type=Path, default=DEFAULT)
    p.add_argument('--inputs', type=Path, default=DEFAULT_INPUTS)
    p.add_argument('--check', action='store_true')
    p.add_argument('--evidence', type=Path, default=EVIDENCE)
    args = p.parse_args()
    if args.check:
        check(args.out)
    else:
        prepare(args.out, args.inputs, args.evidence)


if __name__=='__main__': main()
