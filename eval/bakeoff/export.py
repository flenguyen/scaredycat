#!/usr/bin/env python3
"""Bake-off ONNX export. Usage (from the repo root):

  eval/bakeoff/.cache/venv/bin/python eval/bakeoff/export.py <name> [--force] [--no-text]
  eval/bakeoff/.cache/venv/bin/python eval/bakeoff/export.py --convert-only <fp32.onnx> <outdir>

Reads eval/.model-cache/bakeoff/<name>/src (from fetch-models.mjs) and the
entry in candidates.json, writes eval/.model-cache/bakeoff/<name>/:
  config.json, preprocessor_config.json (+ tokenizer files for CLIP models)
  onnx/vision_model.onnx            fp32, opset 17, pixel_values -> image_embeds
  onnx/vision_model_fp16.onnx       onnxconverter-common, keep_io_types=True
                                    (fp32 I/O + Cast nodes: same as the shipped
                                    MobileCLIP fp16 file, see .cache/notes/mobileclip-io.md)
  onnx/vision_model_quantized.onnx  int8 dynamic quantisation (transformers.js "q8")
  onnx/text_model.onnx              CLIP-family only, fp32, input_ids/attention_mask -> text_embeds

Approach (candidates.json `approach`, or inferred): hf-clip | open-clip | hf-backbone | timm.
Idempotent: existing outputs are skipped unless --force.
"""
import argparse, json, shutil, sys
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CACHE = ROOT / 'eval' / '.model-cache' / 'bakeoff'
OPSET = 17


def load_candidate(name):
    for c in json.loads((HERE / 'candidates.json').read_text()):
        if c['name'] == name:
            return c
    sys.exit(f'{name}: not in candidates.json')


def infer_approach(c, src):
    if c.get('family') in ('hf-clip', 'open-clip', 'hf-backbone', 'timm'):
        return c['family']
    cfg = json.loads((src / 'config.json').read_text()) if (src / 'config.json').exists() else {}
    if cfg.get('model_type') == 'clip':
        return 'hf-clip'
    if (src / 'open_clip_config.json').exists():
        return 'open-clip'
    if 'architecture' in cfg and 'pretrained_cfg' in cfg:
        return 'timm'
    return 'hf-backbone'


def preproc_from(size, mean, std, crop_pct, interp):
    resample = {'bilinear': 2, 'bicubic': 3, 'nearest': 0, 'lanczos': 1}.get(str(interp).lower().split('.')[-1], 3)
    return {'image_processor_type': 'CLIPFeatureExtractor', 'feature_extractor_type': 'CLIPFeatureExtractor',
            'do_resize': True, 'size': {'shortest_edge': int(round(size / crop_pct))}, 'resample': resample,
            'do_center_crop': True, 'crop_size': {'height': size, 'width': size},
            'do_rescale': True, 'rescale_factor': 1 / 255, 'do_normalize': True,
            'image_mean': list(mean), 'image_std': list(std), 'do_convert_rgb': True}


def build_towers(approach, src):
    """Returns (vision_module, text_module|None, size, preprocessor_config|None, config_json)."""
    import torch

    def vwrap(fn):
        class V(torch.nn.Module):
            def forward(s, pixel_values): return fn(pixel_values)
        return V().eval()

    def twrap(fn):
        class T(torch.nn.Module):
            def forward(s, input_ids, attention_mask): return fn(input_ids, attention_mask)
        return T().eval()

    if approach == 'hf-clip':
        from transformers import CLIPModel
        # Built from the full CLIPModel so the projection sizes come from the checkpoint itself.
        model = CLIPModel.from_pretrained(src).eval()
        cfg = json.loads((src / 'config.json').read_text())
        pp = json.loads((src / 'preprocessor_config.json').read_text()) if (src / 'preprocessor_config.json').exists() else None
        V = vwrap(lambda x: model.visual_projection(model.vision_model(pixel_values=x).pooler_output)); V.keep = model
        T = twrap(lambda i, m: model.text_projection(model.text_model(input_ids=i, attention_mask=m).pooler_output)); T.keep = model
        return V, T, model.config.vision_config.image_size, pp, {'model_type': 'clip', 'projection_dim': model.config.projection_dim}
    if approach == 'open-clip':
        import open_clip
        model, _, _ = open_clip.create_model_and_transforms(f'local-dir:{src}')
        model.eval()
        pc = getattr(model.visual, 'preprocess_cfg', {}) or {}
        size = pc.get('size') or getattr(model.visual, 'image_size', 224)
        size = size[0] if isinstance(size, (tuple, list)) else size
        pp = preproc_from(size, pc.get('mean', (0.48145466, 0.4578275, 0.40821073)), pc.get('std', (0.26862954, 0.26130258, 0.27577711)), 1.0, pc.get('interpolation', 'bicubic'))
        with torch.no_grad():
            dim = model.encode_image(torch.zeros(1, 3, size, size)).shape[-1]
        V = vwrap(lambda x: model.encode_image(x)); V.keep = model
        T = twrap(lambda i, m: model.encode_text(i)); T.keep = model
        return V, T, size, pp, {'model_type': 'clip', 'projection_dim': int(dim)}
    if approach == 'hf-backbone':
        from transformers import AutoModel
        m = AutoModel.from_pretrained(src).eval()
        cfg = json.loads((src / 'config.json').read_text())
        pp = json.loads((src / 'preprocessor_config.json').read_text()) if (src / 'preprocessor_config.json').exists() else None
        size = (pp or {}).get('crop_size', {}).get('height', 224)
        emb = getattr(m, 'embeddings', None)
        if emb is not None and hasattr(emb, 'interpolate_pos_encoding'):
            # The input size is fixed, so bake the (bicubic) position-embedding interpolation into a constant.
            # Otherwise the graph carries a Resize node that cannot run in fp16.
            with torch.no_grad():
                dummy = torch.zeros(1, 1 + (size // cfg.get('patch_size', 14)) ** 2, cfg['hidden_size'])
                pe = emb.interpolate_pos_encoding(dummy, size, size).detach()
            emb.interpolate_pos_encoding = lambda *a, **k: pe

        def fwd(x):
            o = m(pixel_values=x)
            return o.pooler_output if getattr(o, 'pooler_output', None) is not None else o.last_hidden_state[:, 0]
        V = vwrap(fwd); V.keep = m
        return V, None, size, pp, {'model_type': cfg.get('model_type', 'dinov2'), 'hidden_size': cfg.get('hidden_size')}
    if approach == 'timm':
        import timm
        cfg = json.loads((src / 'config.json').read_text())
        weights = (sorted(src.glob('*.safetensors')) or sorted(src.glob('*.bin')))[0]
        m = timm.create_model(cfg['architecture'], pretrained=True, num_classes=0, pretrained_cfg_overlay=dict(file=str(weights))).eval()
        pcfg = m.pretrained_cfg
        size = pcfg['input_size'][-1]
        pp = preproc_from(size, pcfg['mean'], pcfg['std'], pcfg.get('crop_pct', 0.875), pcfg.get('interpolation', 'bicubic'))
        V = vwrap(lambda x: m(x)); V.keep = m  # pooled pre-classifier features
        return V, None, size, pp, {'model_type': 'timm', 'architecture': cfg['architecture'], 'num_features': getattr(m, 'head_hidden_size', None) or m.num_features}
    sys.exit(f'unknown approach {approach}')


def export_fp32(mod, size, dest):
    import torch
    x = torch.randn(1, 3, size, size)
    torch.onnx.export(mod, (x,), str(dest), opset_version=OPSET, input_names=['pixel_values'], output_names=['image_embeds'],
                      dynamic_axes={'pixel_values': {0: 'batch_size'}, 'image_embeds': {0: 'batch_size'}}, dynamo=False)
    return x


def ort_session(path):
    import onnxruntime as ort
    o = ort.SessionOptions(); o.log_severity_level = 3
    return ort.InferenceSession(str(path), o, providers=['CPUExecutionProvider'])


def verify_fp32(mod, x, path):
    import torch
    with torch.no_grad():
        ref = mod(x).numpy()
    got = ort_session(path).run(None, {'pixel_values': x.numpy()})[0]
    d = float(np.abs(ref - got).max())
    print(f'  fp32 onnx vs torch max abs diff {d:.2e} (embedding dim {got.shape[-1]})')
    if d > 1e-3:
        sys.exit(f'{path}: fp32 export differs from PyTorch by {d}')


def convert(fp32, outdir, force=False):
    """fp16 (keep_io_types) and int8 dynamic-quantised copies of an fp32 vision ONNX."""
    import onnx
    from onnxconverter_common import float16
    from onnxruntime.quantization import quantize_dynamic, QuantType
    outdir.mkdir(parents=True, exist_ok=True)
    fp16, q8 = outdir / 'vision_model_fp16.onnx', outdir / 'vision_model_quantized.onnx'
    if force or not fp16.exists():
        from onnxruntime.transformers.float16 import convert_float_to_float16 as ort_fp16
        attempts = [
            ('onnxconverter-common', lambda: float16.convert_float_to_float16(onnx.load(str(fp32)), keep_io_types=True)),
            ('onnxconverter-common, Resize kept fp32', lambda: float16.convert_float_to_float16(onnx.load(str(fp32)), keep_io_types=True, op_block_list=['Resize'] + float16.DEFAULT_OP_BLOCK_LIST)),
            ('onnxruntime.transformers.float16', lambda: ort_fp16(onnx.load(str(fp32)), keep_io_types=True)),
            ('onnxruntime.transformers.float16, Resize kept fp32', lambda: ort_fp16(onnx.load(str(fp32)), keep_io_types=True, op_block_list=['Resize'])),
        ]
        shp = [d.dim_value or 1 for d in onnx.load(str(fp32), load_external_data=False).graph.input[0].type.tensor_type.shape.dim]
        probe = np.random.RandomState(0).rand(*shp).astype(np.float32)
        for label, make in attempts:
            try:
                onnx.save(make(), str(fp16))
                ort_session(fp16).run(None, {'pixel_values': probe})  # load AND run: some graphs only fail at run time
                y = ort_session(fp16).run(None, {'pixel_values': probe})[0]
                if not np.isfinite(y).all():
                    raise RuntimeError('non-finite output')
                print(f'  fp16 via {label}')
                break
            except Exception as e:
                print(f'  fp16 via {label} failed: {str(e)[-110:]}')
        else:
            sys.exit('no fp16 conversion produced a runnable model')
        print(f'  wrote {fp16.name} ({fp16.stat().st_size / 1e6:.1f}MB)')
    if force or not q8.exists():
        quantize_dynamic(str(fp32), str(q8), weight_type=QuantType.QInt8)
        print(f'  wrote {q8.name} ({q8.stat().st_size / 1e6:.1f}MB)')
    return fp16, q8


def check_loads(onnxdir, size, files):
    x = np.random.RandomState(0).rand(1, 3, size, size).astype(np.float32)  # [0,1], like a rescaled image
    outs = {}
    for f in files:
        try:
            s = ort_session(onnxdir / f)
            i, o = s.get_inputs()[0], s.get_outputs()[0]
            y = s.run(None, {i.name: x})[0]
            outs[f] = y
            print(f'  loads: {f} in={i.name}/{i.type} out={o.name}/{o.type} shape={list(y.shape)}')
        except Exception as e:  # report, never hide (e.g. fp16 ops missing on the CPU EP)
            print(f'  LOAD FAILED: {f}: {str(e)[:200]}')
            outs[f] = None
    base = outs.get(files[0])
    if base is not None:
        for f, y in outs.items():
            if y is not None and f != files[0]:
                cos = float((y * base).sum() / (np.linalg.norm(y) * np.linalg.norm(base)))
                print(f'  {f}: cosine vs fp32 {cos:.5f}, max abs diff {np.abs(y - base).max():.3e}')
    return outs


def export_text(mod, dest, ctx=77):
    import torch
    ids = torch.randint(1, 1000, (1, ctx)); mask = torch.ones(1, ctx, dtype=torch.long)
    torch.onnx.export(mod, (ids, mask), str(dest), opset_version=OPSET, input_names=['input_ids', 'attention_mask'], output_names=['text_embeds'],
                      dynamic_axes={'input_ids': {0: 'batch_size', 1: 'sequence_length'}, 'attention_mask': {0: 'batch_size', 1: 'sequence_length'}, 'text_embeds': {0: 'batch_size'}}, dynamo=False)
    with torch.no_grad():
        ref = mod(ids, mask).numpy()
    got = ort_session(dest).run(None, {'input_ids': ids.numpy(), 'attention_mask': mask.numpy()})[0]
    print(f'  text fp32 onnx vs torch max abs diff {np.abs(ref - got).max():.2e}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('name', nargs='?')
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--no-text', action='store_true')
    ap.add_argument('--convert-only', nargs=2, metavar=('FP32_ONNX', 'OUTDIR'))
    a = ap.parse_args()
    if a.convert_only:
        convert(Path(a.convert_only[0]), Path(a.convert_only[1]), a.force)
        return
    if not a.name:
        ap.error('name required')
    c = load_candidate(a.name)
    root = CACHE / a.name
    src, onnxdir = root / 'src', root / 'onnx'
    if not src.exists():
        sys.exit(f'{src} missing: run fetch-models.mjs first')
    onnxdir.mkdir(parents=True, exist_ok=True)
    approach = infer_approach(c, src)
    print(f'{a.name}: approach {approach}')
    fp32, text = onnxdir / 'vision_model.onnx', onnxdir / 'text_model.onnx'
    outs = [fp32, onnxdir / 'vision_model_fp16.onnx', onnxdir / 'vision_model_quantized.onnx', root / 'config.json', root / 'preprocessor_config.json']
    clipish = approach in ('hf-clip', 'open-clip')
    if clipish and not a.no_text:
        outs.append(text)
    if not a.force and all(p.exists() for p in outs):
        print('  all outputs exist, skipping (use --force)')
        return
    vis, txt, size, pp, cfg = build_towers(approach, src)
    if a.force or not fp32.exists():
        x = export_fp32(vis, size, fp32)
        verify_fp32(vis, x, fp32)
    if clipish and txt is not None and not a.no_text and (a.force or not text.exists()):
        export_text(txt, text)
    convert(fp32, onnxdir, a.force)
    (root / 'config.json').write_text(json.dumps(cfg, indent=2) + '\n')
    if pp:
        (root / 'preprocessor_config.json').write_text(json.dumps(pp, indent=2) + '\n')
    if clipish:
        for f in src.iterdir():
            if f.name.startswith(('tokenizer', 'vocab', 'merges', 'special_tokens')):
                shutil.copy(f, root / f.name)
    check_loads(onnxdir, size, ['vision_model.onnx', 'vision_model_fp16.onnx', 'vision_model_quantized.onnx'])
    print('  done')


if __name__ == '__main__':
    main()
