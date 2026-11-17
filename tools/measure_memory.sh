#!/usr/bin/env bash
# Disposable local PocketIC only. The immutable baseline is never rebuilt here.
set -euo pipefail
cd "$(dirname "$0")/.."
# Publishing sealed evidence does not use PocketIC or Cargo.
if [[ "${1:-final}" == publish ]] || { [[ "${1:-final}" == resume ]] && [[ -f "${2:-}/approved.json" ]]; }; then
  exec python3 tools/memory_run.py "$@"
fi
memory_pocketic_bin="${POCKET_IC_BIN:-}"
if [[ -z "$memory_pocketic_bin" ]] || ! "$memory_pocketic_bin" --version 2>/dev/null | rg -q '15\.0\.'; then
  memory_pocketic_bin="${TMPDIR:-/tmp}/pocket-ic-server-15.0.0/pocket-ic"
fi
"$memory_pocketic_bin" --version | rg -q '15\.0\.' || { echo 'Set POCKET_IC_BIN to a PocketIC 15 executable.' >&2; exit 1; }
export POCKET_IC_BIN="$memory_pocketic_bin"
exec python3 tools/memory_run.py "$@"
