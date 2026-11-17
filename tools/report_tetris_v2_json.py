"""Serialize NumPy booleans without modifying the preregistered statistical analysis."""
import hashlib
import json
import runpy
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
original_default = json.JSONEncoder.default

def numpy_boolean(self, value):
    if isinstance(value, np.bool_):
        return bool(value)
    return original_default(self, value)

if __name__ == '__main__':
    json.JSONEncoder.default = numpy_boolean
    try:
        runpy.run_path(str(ROOT / 'tools/report_tetris_v2.py'), run_name='__main__')
    finally:
        json.JSONEncoder.default = original_default
