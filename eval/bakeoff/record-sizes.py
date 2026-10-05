#!/usr/bin/env python3
"""Record raw / deflate sizes, sha256 and parameter counts of every exported file
into eval/bakeoff/model-files.json under "<name>".exports.

  eval/bakeoff/.cache/venv/bin/python eval/bakeoff/record-sizes.py
Deflate = gzip level 6 (what scripts/pack.mjs reports; `zip` defaults to deflate level 6).
Vision-tower parameter count comes from the fp32 ONNX initialisers.
"""
import gzip, hashlib, json, zlib
from pathlib import Path
import numpy as np, onnx

HERE = Path(__file__).resolve().parent
CACHE = HERE.parent / '.model-cache' / 'bakeoff'
LOCK = HERE / 'model-files.json'


def params(path):
    m = onnx.load(str(path))
    return int(sum(int(np.prod(t.dims)) for t in m.graph.initializer))


lock = json.loads(LOCK.read_text())
for d in sorted(p for p in CACHE.iterdir() if (p / 'onnx').exists()):
    out = {}
    for f in sorted((d / 'onnx').glob('*.onnx')) + [d / 'config.json', d / 'preprocessor_config.json']:
        if not f.exists():
            continue
        b = f.read_bytes()
        out[f.name] = {'bytes': len(b), 'deflate_bytes': len(zlib.compress(b, 6)),
                       'sha256': hashlib.sha256(b).hexdigest()}
        if f.name in ('vision_model.onnx', 'text_model.onnx'):
            out[f.name]['params'] = params(f)
    ent = lock.setdefault(d.name, {})
    ent['exports'] = out
    print(d.name, {k: (round(v['bytes'] / 1e6, 1), round(v['deflate_bytes'] / 1e6, 1)) for k, v in out.items() if k.endswith('.onnx')})
LOCK.write_text(json.dumps(lock, indent=2) + '\n')
