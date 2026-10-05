#!/usr/bin/env python3
"""Bake-off phase D (and the phase F test path): linear heads, val thresholds,
fp16/q8 precision deltas, eligibility and the two finalists.

  eval/bakeoff/.cache/venv/bin/python eval/bakeoff/analyze.py
      Default mode. Reads TRAIN and VAL only: the test rows are dropped from the
      manifest before any label is read. Trains heads (heads/<model>-<dtype>.json),
      picks thresholds on val, bootstraps CIs, checks eligibility and writes
      .cache/val-results.json, .cache/val-summary.md and finalists.node.json.

  eval/bakeoff/.cache/venv/bin/python eval/bakeoff/analyze.py --source browser
      Phase D2, the SHIPPING pipeline. Same train/val-only gate, on the in-browser
      embeddings from phase E2 (.cache/emb-browser/, real decode, fp16, WASM). The
      baseline is MobileCLIP's in-browser shipped zero-shot score. Heads (C picked
      on val log-loss subject to WASM/WebGPU score parity <= 2) go to
      heads/<model>-<view>-browser.json; writes .cache/val-results-browser.json,
      .cache/val-summary-browser.md and finalists.json (sourceMode: browser).

  eval/bakeoff/.cache/venv/bin/python eval/bakeoff/analyze.py --final-test --models a,b
      Phase F only. Scores TEST once for the named finalist models (their configs
      and val thresholds come from finalists.json and the matching val-results file:
      browser when finalists.json says sourceMode: browser) plus the MobileCLIP
      baseline, with the exact same metric code. Heads are loaded from heads/*.json,
      never retrained. Writes .cache/test-results[-browser].json and appends a line
      to .cache/test-runs.log.

Conventions (match content/ml-bridge.js): a score blocks when score >= T and
vetoes when score <= V. Scores are on the 0-100 scale. Head score =
100 * sigmoid(w . e_hat + b), e_hat = L2-normalised image embedding.
"""
import argparse, json, math, sys, time, zlib
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy.special import expit
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score, average_precision_score, log_loss

HERE = Path(__file__).resolve().parent
CACHE = HERE / '.cache'
EMB = CACHE / 'emb'
SCORES = CACHE / 'scores'
HEADS = HERE / 'heads'
MODEL_CACHE = HERE.parent / '.model-cache'

MODELS = ['mobileclip-s0', 'tinyclip-vit-8m-16-yfcc15m', 'tinyclip-vit-40m-32-laion400m', 'clip-vit-b-32',
          'dinov2-small', 'mobilenetv3-large-100', 'efficientnet-lite0']
DTYPES = ['fp32', 'fp16', 'q8']
SHIPPING_DTYPES = {'fp32', 'fp16'}  # q8 is never a shipping dtype (user decision)
HORROR_GROUPS = ['classic', 'minimalist', 'creature-gore', 'possession-ghost', 'slasher', 'trailer-thumb', 'moody']
HARD_GROUPS = ['dark-thriller', 'action-fantasy', 'crime', 'scifi', 'war', 'game-art', 'family-halloween',
               'dark-drama', 'collision', 'trailer-thumb-safe']
EASY_GROUPS = ['photo', 'ui-screenshot', 'logo', 'food', 'product', 'people', 'kids-cartoon']
BASE = ('mobileclip-s0', 'zero-shot', 'fp16')
SHIPPED_BARS = {'IMAGE_ONLY_BLOCK_SCORE': 80, 'IMAGE_BLOCK_SCORE': 76, 'IMAGE_BLOCK_SCORE_HORROR_PAGE': 65,
                'IMAGE_VETO_SCORE': 40}
C_GRID = [0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100, 300, 1000]
N_BOOT = 2000
SEED = 1337
MAX_DELTA = 2.0          # points, fp16 (or q8) vs fp32, max |delta| on train+val
SIZE_CAP = 50e6          # bytes, raw vision file (decimal MB, the stricter reading)
SPEED_FACTOR = 3.0       # x MobileCLIP fp16 Node p50
AUC_LEAK_FLAG = 0.995
CW_MIN_GAIN = 0.002      # class_weight='balanced' is used only if it raises val AUC by this much
T_STEP = 0.01            # thresholds are snapped to a 0.01 grid (still strictly separating)


# ---------------------------------------------------------------- data

def load_manifest(splits):
    rows = json.loads((HERE / 'images.json').read_text())
    for r in rows:  # Commons photos have no film: each is its own cluster
        r['cluster'] = r['film'] or f'img:{r["id"]}'
    # Integrity: no film in two splits. Uses film + split only (no labels).
    film_splits = defaultdict(set)
    for r in rows:
        film_splits[r['cluster']].add(r['split'])
    bad = sorted(f for f, s in film_splits.items() if len(s) > 1)
    if bad:
        sys.exit(f'ABORT: {len(bad)} films in more than one split, e.g. {bad[:5]}')
    keep = [r for r in rows if r['split'] in splits]
    if 'test' not in splits:
        assert all(r['split'] != 'test' for r in keep)
    return keep


def sha_leak_check(all_rows_ids_splits):
    """Same image bytes in two splits? Reads ids, splits and sha256 only (no labels)."""
    idx = json.loads((CACHE / 'img-index.json').read_text())
    add = CACHE / 'additions-index.json'
    if add.exists():
        idx.update(json.loads(add.read_text()))
    by_sha = defaultdict(set)
    for i, sp in all_rows_ids_splits:
        sha = (idx.get(i) or {}).get('sha256')
        if sha:
            by_sha[sha].add((i, sp))
    cross = []
    for sha, s in by_sha.items():
        if len({sp for _, sp in s}) > 1:
            cross.append(sorted(s))
    return cross


def load_emb(model, dtype, ids):
    meta_p, bin_p = EMB / f'{model}-{dtype}.json', EMB / f'{model}-{dtype}.f32'
    if not bin_p.exists():
        return None
    meta = json.loads(meta_p.read_text())
    if meta.get('status') != 'ok':
        return None
    X = np.fromfile(bin_p, dtype='<f4').reshape(meta['n'], meta['dim'])
    pos = {i: k for k, i in enumerate(meta['ids'])}
    X = X[[pos[i] for i in ids]].astype(np.float64)
    if not np.isfinite(X).all():
        raise SystemExit(f'ABORT: non-finite embedding values in {model}-{dtype}')
    n = np.linalg.norm(X, axis=1, keepdims=True)
    if (n == 0).any():
        raise SystemExit(f'ABORT: zero embedding in {model}-{dtype}')
    return X / n


def load_zs(model, dtype, ids):
    p = SCORES / f'{model}-{dtype}-zs.json'
    if not p.exists():
        return None
    d = json.loads(p.read_text())
    s = np.array([d[i] for i in ids], dtype=np.float64)
    if not np.isfinite(s).all():
        raise SystemExit(f'ABORT: non-finite zero-shot score in {p.name}')
    return s


# ---------------------------------------------------------------- heads

def f32(x):
    return float(f'{float(np.float32(x)):.9g}')


def train_head(Xtr, ytr, Xva, yva):
    tried = []
    best = {}
    for cw in (None, 'balanced'):
        for C in C_GRID:
            clf = LogisticRegression(C=C, class_weight=cw, max_iter=20000, tol=1e-8)
            clf.fit(Xtr, ytr)
            p = clf.predict_proba(Xva)[:, 1]
            ll = log_loss(yva, p, labels=[0, 1])
            auc = roc_auc_score(yva, p)
            tried.append({'C': C, 'classWeight': cw, 'valLogLoss': ll, 'valAuc': auc})
            if cw not in best or ll < best[cw][0]:
                best[cw] = (ll, auc, C, clf)
    # C by val log-loss within each weighting; balanced only if it clearly helps val AUC.
    pick = 'balanced' if best['balanced'][1] >= best[None][1] + CW_MIN_GAIN else None
    ll, auc, C, clf = best[pick]
    return clf, {'C': C, 'classWeight': pick, 'valLogLoss': ll, 'valAucFit': auc, 'grid': tried}


def head_score(head, X):
    w = np.asarray(head['w'], dtype=np.float32).astype(np.float64)
    b = float(np.float32(head['b']))
    return 100.0 * expit(X @ w + b)


def load_head(model, trained_on):
    return json.loads((HEADS / f'{model}-{trained_on}.json').read_text())


# ---------------------------------------------------------------- thresholds

def snap_up(x):    # smallest grid value strictly above x
    return round(math.floor(x / T_STEP + 1e-9) * T_STEP + T_STEP, 2)


def snap_down(x):  # largest grid value strictly below x
    return round(math.ceil(x / T_STEP - 1e-9) * T_STEP - T_STEP, 2)


def thr_count(hs, k):
    """Lowest T (0.01 grid) with at most k hard-safe scores >= T."""
    s = np.sort(hs)[::-1]
    if k >= len(s):
        return 0.0
    return snap_up(s[k])


def thr_rate(hs, rate):
    return thr_count(hs, int(math.floor(rate * len(hs) + 1e-9)))


def veto_line(moody, keep_share):
    """Largest V (0.01 grid) with share(moody > V) >= keep_share."""
    a = np.sort(moody)
    j = int(math.floor((1 - keep_share) * len(a) + 1e-9))  # moody allowed at/below V
    if j >= len(a):
        return 100.0
    return snap_down(a[j])


# ---------------------------------------------------------------- metrics

class Frame:
    """Labels, groups and masks for one split (or a bootstrap resample of it)."""

    def __init__(self, labels, groups, films, ids):
        self.y = np.asarray(labels)
        self.g = np.asarray(groups)
        self.films = np.asarray(films)
        self.ids = list(ids)
        self.masks = {'horror': self.y == 1, 'safe': self.y == 0,
                      'hard': np.isin(self.g, HARD_GROUPS), 'easy': np.isin(self.g, EASY_GROUPS)}
        for grp in HORROR_GROUPS:
            self.masks[f'horror:{grp}'] = (self.y == 1) & (self.g == grp)
        for grp in HARD_GROUPS:
            self.masks[f'hard:{grp}'] = (self.y == 0) & (self.g == grp)
        for grp in EASY_GROUPS:
            self.masks[f'easy:{grp}'] = (self.y == 0) & (self.g == grp)
        self.pos = {k: np.flatnonzero(m) for k, m in self.masks.items()}

    def take(self, idx):
        return Frame(self.y[idx], self.g[idx], self.films[idx], [self.ids[i] for i in idx])


def rate(b, pos):
    return float(b[pos].mean()) if len(pos) else float('nan')


def block_metrics(s, T, fr):
    b = s >= T
    out = {'T': T, 'recall': rate(b, fr.pos['horror']), 'minimalistRecall': rate(b, fr.pos['horror:minimalist']),
           'hardFalseBlur': rate(b, fr.pos['hard']), 'easyFalseBlur': rate(b, fr.pos['easy'])}
    for grp in HORROR_GROUPS:
        out[f'recall:{grp}'] = rate(b, fr.pos[f'horror:{grp}'])
    for grp in HARD_GROUPS:
        out[f'hardFalseBlur:{grp}'] = rate(b, fr.pos[f'hard:{grp}'])
    for grp in EASY_GROUPS:
        out[f'easyFalseBlur:{grp}'] = rate(b, fr.pos[f'easy:{grp}'])
    return out


def veto_metrics(s, V, fr):
    v = s <= V
    return {'V': V, 'moodyAbove': 1 - rate(v, fr.pos['horror:moody']),
            'collisionBelow': rate(v, fr.pos['hard:collision']),
            'horrorVetoed': rate(v, fr.pos['horror']), 'hardSafeVetoed': rate(v, fr.pos['hard']),
            'easySafeVetoed': rate(v, fr.pos['easy'])}


def ranking(s, fr):
    y = fr.y
    out = {'auc': float(roc_auc_score(y, s)), 'prAuc': float(average_precision_score(y, s))}
    return out


def ranking_groups(s, fr):
    out = {}
    hz, sf = fr.pos['horror'], fr.pos['safe']
    for grp in HORROR_GROUPS:
        p = fr.pos[f'horror:{grp}']
        idx = np.concatenate([p, sf]); yy = np.r_[np.ones(len(p)), np.zeros(len(sf))]
        out[f'horror:{grp}'] = {'auc': float(roc_auc_score(yy, s[idx])), 'prAuc': float(average_precision_score(yy, s[idx])), 'n': int(len(p))}
    for tier, groups in (('hard', HARD_GROUPS), ('easy', EASY_GROUPS)):
        for grp in groups:
            p = fr.pos[f'{tier}:{grp}']
            idx = np.concatenate([hz, p]); yy = np.r_[np.ones(len(hz)), np.zeros(len(p))]
            out[f'{tier}:{grp}'] = {'auc': float(roc_auc_score(yy, s[idx])), 'prAuc': float(average_precision_score(yy, s[idx])), 'n': int(len(p))}
    for tier in ('hard', 'easy'):
        p = fr.pos[tier]
        idx = np.concatenate([hz, p]); yy = np.r_[np.ones(len(hz)), np.zeros(len(p))]
        out[tier] = {'auc': float(roc_auc_score(yy, s[idx])), 'prAuc': float(average_precision_score(yy, s[idx])), 'n': int(len(p))}
    return out


def point_metrics(s, fr, th, groups=True):
    """All metrics for one score vector at fixed thresholds th = {name: value}.
    groups=False skips per-group AUCs (used inside the bootstrap)."""
    m = {'ranking': ranking(s, fr), 'at': {}}
    if groups:
        m['rankingByGroup'] = ranking_groups(s, fr)
    for name, T in th.items():
        m['at'][name] = veto_metrics(s, T, fr) if is_veto(name) else block_metrics(s, T, fr)
    return m


def is_veto(name):  # T_veto, T_veto_moody (browser mode), veto*
    return name.startswith('veto') or name.startswith('T_veto')


def flat(m):
    out = dict(m['ranking'])
    for name, d in m['at'].items():
        for k, v in d.items():
            if k not in ('T', 'V'):
                out[f'{name}.{k}'] = v
    return out


def boot_plan(fr, n_boot=N_BOOT, seed=SEED):
    """Stratified cluster bootstrap: films resampled with replacement within strata
    (label x the group of the film's first image), film count per stratum fixed."""
    rng = np.random.default_rng(seed)
    film_rows = defaultdict(list)
    film_stratum = {}
    for i, (f, y, g) in enumerate(zip(fr.films, fr.y, fr.g)):
        film_rows[f].append(i)
        film_stratum.setdefault(f, (int(y), g))
    strata = defaultdict(list)
    for f, st in film_stratum.items():
        strata[st].append(f)
    strata = [(st, [np.array(film_rows[f]) for f in fs]) for st, fs in sorted(strata.items())]
    plans = []
    for _ in range(n_boot):
        parts = []
        for _, films in strata:
            pick = rng.integers(0, len(films), len(films))
            parts.extend(films[k] for k in pick)
        plans.append(np.concatenate(parts))
    return plans


def ci(vals):
    a = np.asarray(vals, dtype=float)
    if np.all(np.isnan(a)):
        return [None, None]
    return [float(np.nanpercentile(a, 2.5)), float(np.nanpercentile(a, 97.5))]


# ---------------------------------------------------------------- configs

def zip_size(path):
    b = Path(path).read_bytes()
    return len(b), len(zlib.compress(b, 6))


def sizes():
    """Raw / deflate-6 bytes of each model's vision file per dtype."""
    lock = json.loads((HERE / 'model-files.json').read_text())
    names = {'fp32': 'vision_model.onnx', 'fp16': 'vision_model_fp16.onnx', 'q8': 'vision_model_quantized.onnx'}
    out = {}
    for model, ent in lock.items():
        ex = ent.get('exports') or {}
        out[model] = {dt: {'bytes': ex[f]['bytes'], 'deflateBytes': ex[f]['deflate_bytes']}
                      for dt, f in names.items() if f in ex}
        if 'vision_model.onnx' in ex and 'params' in ex['vision_model.onnx']:
            out[model]['params'] = ex['vision_model.onnx']['params']
    mc_cache = CACHE / 'mobileclip-sizes.json'
    if mc_cache.exists():
        out['mobileclip-s0'] = json.loads(mc_cache.read_text())
    else:
        d = MODEL_CACHE / 'Xenova' / 'mobileclip_s0' / 'onnx'
        mc = {}
        for dt, f in names.items():
            if (d / f).exists():
                raw, defl = zip_size(d / f)
                mc[dt] = {'bytes': raw, 'deflateBytes': defl}
        try:
            import onnx
            m = onnx.load(str(d / 'vision_model.onnx'))
            mc['params'] = int(sum(int(np.prod(t.dims)) for t in m.graph.initializer))
        except Exception as e:  # noqa: BLE001
            mc['paramsError'] = str(e)
        mc_cache.write_text(json.dumps(mc, indent=1))
        out['mobileclip-s0'] = mc
    return out


def timings():
    t = json.loads((CACHE / 'timing.json').read_text())
    return {(r['model'], r['dtype']): r for r in t['rows'] if 'p50Ms' in r}


def roles():
    c = json.loads((HERE / 'candidates.json').read_text())
    return {x['name']: x for x in c}


# ---------------------------------------------------------------- default mode

def thresholds_for(s_val, fr, base_ref):
    hs = s_val[fr.pos['hard']]
    th = {'T_only': thr_rate(hs, 0.02), 'T_page': thr_rate(hs, 0.05),
          'T_block': thr_count(hs, base_ref['blockCount']),
          'T_veto': veto_line(s_val[fr.pos['horror:moody']], base_ref['moodyKeep'])}
    return th


def repicked(s, fr, base_ref):
    """Recall and minimalist recall with thresholds re-picked on this (resampled) frame."""
    hs = s[fr.pos['hard']]
    to, tp = thr_rate(hs, 0.02), thr_rate(hs, 0.05)
    return {'recall@T_only': rate(s >= to, fr.pos['horror']),
            'minimalist@T_only': rate(s >= to, fr.pos['horror:minimalist']),
            'minimalist@T_page': rate(s >= tp, fr.pos['horror:minimalist'])}


def main_default():
    t0 = time.time()
    rows = load_manifest({'train', 'val'})
    all_rows = json.loads((HERE / 'images.json').read_text())
    cross_sha = sha_leak_check([(r['id'], r['split']) for r in all_rows])
    by_split = {sp: [r for r in rows if r['split'] == sp] for sp in ('train', 'val')}
    ids = {sp: [r['id'] for r in by_split[sp]] for sp in by_split}
    frames = {sp: Frame([1 if r['label'] == 'horror' else 0 for r in by_split[sp]], [r['group'] for r in by_split[sp]],
                        [r['cluster'] for r in by_split[sp]], ids[sp]) for sp in by_split}
    fr_va = frames['val']
    ytr, yva = frames['train'].y, fr_va.y
    print(f'train {len(ytr)} ({ytr.sum()} horror)  val {len(yva)} ({yva.sum()} horror)')

    # --- scores for every config: {key: {'train': s, 'val': s}}, key = (model, approach, dtype)
    emb = {}
    for m in MODELS:
        for dt in DTYPES:
            e = {sp: load_emb(m, dt, ids[sp]) for sp in ids}
            if e['train'] is not None:
                emb[(m, dt)] = e
    HEADS.mkdir(exist_ok=True)
    head_meta = {}
    heads = {}
    for (m, dt), e in emb.items():
        clf, info = train_head(e['train'], ytr, e['val'], yva)
        head = {'model': m, 'trainedOn': dt, 'dim': int(e['train'].shape[1]), 'normalise': 'l2',
                'score': '100 * sigmoid(w . e_hat + b), e_hat = e / ||e||',
                'C': info['C'], 'classWeight': info['classWeight'],
                'b': f32(clf.intercept_[0]), 'w': [f32(x) for x in clf.coef_[0]]}
        (HEADS / f'{m}-{dt}.json').write_text(json.dumps(head) + '\n')
        heads[(m, dt)] = head
        head_meta[f'{m}-{dt}'] = {k: v for k, v in info.items()}
        head_meta[f'{m}-{dt}']['file'] = f'eval/bakeoff/heads/{m}-{dt}.json'
        print(f'head {m}-{dt}: C={info["C"]} cw={info["classWeight"]} val ll={info["valLogLoss"]:.4f} auc={info["valAucFit"]:.4f}')

    scores = {}   # key -> {'train','val'}
    head_of = {}  # key -> (model, trainedOn)
    for m in MODELS:
        for dt in DTYPES:
            zs = {sp: load_zs(m, dt, ids[sp]) for sp in ids}
            if zs['train'] is not None:
                scores[(m, 'zero-shot', dt)] = zs
            if (m, dt) in emb:
                scores[(m, 'head', dt)] = {sp: head_score(heads[(m, dt)], emb[(m, dt)][sp]) for sp in ids}
                head_of[(m, 'head', dt)] = (m, dt)
                if dt != 'fp32' and (m, 'fp32') in emb:
                    scores[(m, 'head-fp32', dt)] = {sp: head_score(heads[(m, 'fp32')], emb[(m, dt)][sp]) for sp in ids}
                    head_of[(m, 'head-fp32', dt)] = (m, 'fp32')
    for k, v in scores.items():
        for sp, s in v.items():
            if not np.isfinite(s).all():
                raise SystemExit(f'ABORT: NaN scores for {k} {sp}')

    # --- MobileCLIP zero-shot fp16 reference rates on val
    sb = scores[BASE]['val']
    hs_b = sb[fr_va.pos['hard']]
    moody_b = sb[fr_va.pos['horror:moody']]
    base_ref = {'blockCount': int((hs_b >= SHIPPED_BARS['IMAGE_BLOCK_SCORE']).sum()),
                'blockRate': float((hs_b >= SHIPPED_BARS['IMAGE_BLOCK_SCORE']).mean()),
                'moodyKeep': float((moody_b > SHIPPED_BARS['IMAGE_VETO_SCORE']).mean()),
                'nHardVal': int(len(hs_b)), 'nMoodyVal': int(len(moody_b))}
    print('base ref', base_ref)

    # --- leakage probe: near-duplicate images across train/val (CLIP B/32 fp32 cosine)
    neardup = []
    if ('clip-vit-b-32', 'fp32') in emb:
        e = emb[('clip-vit-b-32', 'fp32')]
        sim = e['val'] @ e['train'].T
        for i, j in zip(*np.nonzero(sim > 0.97)):
            neardup.append({'val': ids['val'][i], 'train': ids['train'][j], 'cos': float(sim[i, j]),
                            'valLabel': int(yva[i]), 'trainLabel': int(ytr[j])})

    # --- per-config val metrics, thresholds, bootstrap
    plans = boot_plan(fr_va)
    boot_frames = [fr_va.take(idx) for idx in plans]
    sz, tm, rl = sizes(), timings(), roles()
    base_p50 = tm[('mobileclip-s0', 'fp16')]['p50Ms']
    results = {}
    th_all = {}
    for key, sv in scores.items():
        th_all[key] = thresholds_for(sv['val'], fr_va, base_ref)

    base_rep = [repicked(sb[idx], bf, base_ref) for idx, bf in zip(plans, boot_frames)]
    base_th = th_all[BASE]
    base_fixed = [flat(point_metrics(sb[idx], bf, base_th, False)) for idx, bf in zip(plans, boot_frames)]

    for key, sv in scores.items():
        m, ap, dt = key
        s = sv['val']
        th = th_all[key]
        pm = point_metrics(s, fr_va, th)
        if key == BASE:
            pm['atShippedBars'] = {
                'IMAGE_ONLY_BLOCK_SCORE': block_metrics(s, 80, fr_va), 'IMAGE_BLOCK_SCORE': block_metrics(s, 76, fr_va),
                'IMAGE_BLOCK_SCORE_HORROR_PAGE': block_metrics(s, 65, fr_va), 'IMAGE_VETO_SCORE': veto_metrics(s, 40, fr_va)}
        # bootstrap at fixed thresholds
        bf_vals = [flat(point_metrics(s[idx], bf, th, False)) for idx, bf in zip(plans, boot_frames)]
        keys_ = bf_vals[0].keys()
        pm['ci95'] = {k: ci([b[k] for b in bf_vals]) for k in keys_}
        if key == BASE:
            sh = {'S80': 80, 'S76': 76, 'S65': 65}
            sbv = [{**{f'{n}.{k}': v for n, T in sh.items() for k, v in block_metrics(s[idx], T, bf).items() if k != 'T'},
                    **{f'S40.{k}': v for k, v in veto_metrics(s[idx], 40, bf).items() if k != 'V'}}
                   for idx, bf in zip(plans, boot_frames)]
            pm['atShippedBarsCi95'] = {k: ci([b[k] for b in sbv]) for k in sbv[0]}
        # paired deltas vs baseline: (a) fixed thresholds (each its own val pick), (b) re-picked per resample
        rep = [repicked(s[idx], bf, base_ref) for idx, bf in zip(plans, boot_frames)]
        pt = {'recall@T_only': pm['at']['T_only']['recall'] - results_base_point(sb, fr_va, base_th)['recall@T_only'],
              'minimalist@T_only': pm['at']['T_only']['minimalistRecall'] - results_base_point(sb, fr_va, base_th)['minimalist@T_only'],
              'minimalist@T_page': pm['at']['T_page']['minimalistRecall'] - results_base_point(sb, fr_va, base_th)['minimalist@T_page']}
        fixed_map = {'recall@T_only': 'T_only.recall', 'minimalist@T_only': 'T_only.minimalistRecall',
                     'minimalist@T_page': 'T_page.minimalistRecall'}
        dci_fixed = {k: ci([b[fixed_map[k]] - bb[fixed_map[k]] for b, bb in zip(bf_vals, base_fixed)]) for k in pt}
        dci_rep = {k: ci([r[k] - rb[k] for r, rb in zip(rep, base_rep)]) for k in pt}
        margins = {'recall@T_only': -3.0, 'minimalist@T_only': -5.0, 'minimalist@T_page': -5.0}
        rule = {}
        for k in pt:
            d = pt[k] * 100
            lo, hi = [x * 100 for x in dci_rep[k]]
            flo, fhi = [x * 100 for x in dci_fixed[k]]
            vr = 'pass' if lo >= margins[k] else ('fail' if hi < margins[k] else 'inconclusive')
            vf = 'pass' if flo >= margins[k] else ('fail' if fhi < margins[k] else 'inconclusive')
            rule[k] = {'deltaPts': d, 'marginPts': margins[k], 'pass': d >= margins[k],
                       'ci95RepickedPts': [lo, hi], 'ci95FixedPts': [flo, fhi],
                       'verdictRepicked': vr, 'verdictFixed': vf,
                       'verdict': vf if vf == vr else 'inconclusive'}
        rule['a'] = rule['recall@T_only']['pass']
        rule['b'] = rule['minimalist@T_only']['pass'] and rule['minimalist@T_page']['pass']
        rule['provisionalPass'] = rule['a'] and rule['b']
        rule['anyInconclusive'] = any(rule[k]['verdict'] == 'inconclusive' for k in pt)
        pm['decisionRuleVsBaseline'] = rule

        # precision deltas vs fp32 on train+val, same scorer
        prec = None
        if dt != 'fp32':
            if ap == 'zero-shot':
                ref_key = (m, 'zero-shot', 'fp32')
                ref = np.r_[scores[ref_key]['train'], scores[ref_key]['val']] if ref_key in scores else None
            else:
                h = heads[head_of[key]]
                ref = np.r_[head_score(h, emb[(m, 'fp32')]['train']), head_score(h, emb[(m, 'fp32')]['val'])] if (m, 'fp32') in emb else None
            cur = np.r_[sv['train'], sv['val']]
            if ref is not None:
                d = np.abs(cur - ref)
                flips = {}
                anyflip = np.zeros(len(d), bool)
                for name, T in th.items():
                    f = ((cur <= T) != (ref <= T)) if name == 'T_veto' else ((cur >= T) != (ref >= T))
                    flips[name] = int(f.sum()); anyflip |= f
                prec = {'vs': 'fp32', 'n': int(len(d)), 'maxAbs': float(d.max()), 'p95Abs': float(np.percentile(d, 95)),
                        'meanAbs': float(d.mean()), 'flips': flips, 'flipsAny': int(anyflip.sum()),
                        'pass': bool(d.max() <= MAX_DELTA)}
        else:
            prec = {'vs': 'fp32', 'maxAbs': 0.0, 'p95Abs': 0.0, 'pass': True, 'flipsAny': 0}

        # eligibility
        role = rl.get(m, {}).get('role')
        size = (sz.get(m) or {}).get(dt)
        t = tm.get((m, dt))
        reasons = []
        if role != 'candidate':
            reasons.append({'reference': 'ceiling reference only (over the size cap at fp16, or no licence tag)',
                            'baseline': 'baseline only (apple-amlr, research-only licence)'}.get(role, f'role {role}'))
        if dt not in SHIPPING_DTYPES:
            reasons.append('q8 is not a shipping dtype (user decision)')
        if size is None:
            reasons.append('no size record')
        elif size['bytes'] > SIZE_CAP:
            reasons.append(f'vision file {size["bytes"] / 1e6:.1f} MB > 50 MB cap')
        if prec is None:
            reasons.append('no fp32 reference for the precision check')
        elif not prec['pass']:
            reasons.append(f'max |delta| vs fp32 {prec["maxAbs"]:.2f} > 2 points')
        speed_flag = None
        if t is None:
            reasons.append('no Node timing')
        elif t['p50Ms'] > SPEED_FACTOR * base_p50:
            speed_flag = f'Node p50 {t["p50Ms"]:.1f} ms > {SPEED_FACTOR:g}x MobileCLIP fp16 ({base_p50:.1f} ms)'
            reasons.append(speed_flag)
        label = {'reference': 'ceiling-reference', 'baseline': 'baseline', 'candidate': 'candidate'}.get(role, role)
        auc = pm['ranking']['auc']
        flags = []
        if auc >= AUC_LEAK_FLAG:
            flags.append(f'val AUC {auc:.4f} >= {AUC_LEAK_FLAG}: check for leakage')
        if th['T_veto'] >= th['T_block']:
            flags.append(f'T_veto {th["T_veto"]:.2f} >= T_block {th["T_block"]:.2f}: the moody-share rule puts the veto line above the block bar')
        results[cfg_id(key)] = {
            'model': m, 'approach': ap, 'dtype': dt, 'role': label,
            'head': (f'eval/bakeoff/heads/{head_of[key][0]}-{head_of[key][1]}.json' if key in head_of else None),
            'thresholds': th, 'val': pm, 'precision': prec,
            'size': size, 'params': (sz.get(m) or {}).get('params'),
            'nodeTiming': ({k: t[k] for k in ('p50Ms', 'p95Ms', 'loadMs', 'maxRssMB')} if t else None),
            'speedFlag': speed_flag, 'eligible': not reasons, 'ineligibleReasons': reasons, 'flags': flags}
        print(f'{cfg_id(key):52s} auc={auc:.4f} r@only={pm["at"]["T_only"]["recall"]:.3f} '
              f'min@page={pm["at"]["T_page"]["minimalistRecall"]:.3f} maxd={prec["maxAbs"] if prec else float("nan"):.2f} '
              f'elig={not reasons}')

    # --- precision summary per approach
    prec_summary = {}
    for cid, r in results.items():
        if r['dtype'] != 'fp32' and r['precision']:
            prec_summary.setdefault(f'{r["model"]}|{r["approach"]}', {})[r['dtype']] = {
                k: r['precision'][k] for k in ('maxAbs', 'p95Abs', 'flipsAny', 'pass')}

    # --- finalists
    def rank_key(r):
        v = r['val']
        return (-v['at']['T_only']['recall'], -v['at']['T_page']['minimalistRecall'], -v['ranking']['auc'],
                r['size']['deflateBytes'])
    eligible = sorted((r for r in results.values() if r['eligible']), key=rank_key)
    leaderboard = [cfg_id((r['model'], r['approach'], r['dtype'])) for r in eligible]
    all_ranked = [cfg_id((r['model'], r['approach'], r['dtype'])) for r in sorted(results.values(), key=rank_key)]
    finalists = []
    seen = set()
    for r in eligible:
        if r['model'] in seen:
            continue
        seen.add(r['model'])
        finalists.append(r)
        if len(finalists) == 2:
            break

    out = {
        'generated': time.strftime('%Y-%m-%dT%H:%M:%S'), 'mode': 'default (train/val only; test labels never read)',
        'counts': {'train': int(len(ytr)), 'trainHorror': int(ytr.sum()), 'val': int(len(yva)), 'valHorror': int(yva.sum()),
                   'valHardSafe': int(len(fr_va.pos['hard'])), 'valEasySafe': int(len(fr_va.pos['easy'])),
                   'valMinimalist': int(len(fr_va.pos['horror:minimalist'])), 'valMoody': int(len(fr_va.pos['horror:moody'])),
                   'valCollision': int(len(fr_va.pos['hard:collision']))},
        'settings': {'cGrid': C_GRID, 'nBoot': N_BOOT, 'seed': SEED, 'bootstrap': 'films resampled within (label, first-image group) strata',
                     'maxDeltaPts': MAX_DELTA, 'sizeCapBytes': SIZE_CAP, 'speedFactor': SPEED_FACTOR, 'thresholdGrid': T_STEP,
                     'block': 'score >= T', 'veto': 'score <= V', 'deltaScorer': 'same scorer (prompts or head weights) on dtype vs fp32 embeddings',
                     'mobileclipNodeP50Ms': base_p50},
        'baselineReference': base_ref,
        'integrity': {'filmsInTwoSplits': 0, 'sameImageAcrossSplits': cross_sha, 'nearDuplicatesValTrain_cos>0.97': neardup,
                      'configFlags': {c: r['flags'] for c, r in results.items() if r['flags']}},
        'heads': head_meta, 'configs': results, 'precisionSummary': prec_summary,
        'leaderboardEligible': leaderboard, 'rankingAllConfigs': all_ranked,
        'finalists': [cfg_id((r['model'], r['approach'], r['dtype'])) for r in finalists],
        'noEligible': not eligible,
        'notes': ['Val numbers are optimistic: thresholds and the head C (and the CLIP prompt variants in phase C) were picked on val.',
                  f'Val has only {len(fr_va.pos["horror:moody"])} moody and {len(fr_va.pos["horror:minimalist"])} minimalist images, so T_veto and minimalist recall are coarse.']}
    (CACHE / 'val-results.json').write_text(json.dumps(out, indent=1))

    fin = {'generated': out['generated'], 'source': 'eval/bakeoff/analyze.py (val only)',
           'rule': 'eligible configs ranked on val by recall@T_only, minimalist@T_page, AUC, then smaller zip; best config of the top two distinct models',
           'baseline': {'config': cfg_id(BASE), 'thresholds': results[cfg_id(BASE)]['thresholds'], 'shippedBars': SHIPPED_BARS},
           'finalists': []}
    for r in finalists:
        v = r['val']
        fin['finalists'].append({
            'config': cfg_id((r['model'], r['approach'], r['dtype'])), 'model': r['model'], 'approach': r['approach'],
            'dtype': r['dtype'], 'head': r['head'],
            'prompts': (f'eval/bakeoff/prompts/{r["model"]}.json' if r['approach'] == 'zero-shot' else None),
            'thresholds': r['thresholds'],
            'val': {'auc': v['ranking']['auc'], 'recall@T_only': v['at']['T_only']['recall'],
                    'minimalist@T_only': v['at']['T_only']['minimalistRecall'], 'minimalist@T_page': v['at']['T_page']['minimalistRecall'],
                    'collisionBelow@T_veto': v['at']['T_veto']['collisionBelow']},
            'sizeBytes': r['size']['bytes'], 'deflateBytes': r['size']['deflateBytes'],
            'maxAbsDeltaVsFp32': r['precision']['maxAbs'], 'nodeP50Ms': r['nodeTiming']['p50Ms'],
            'decisionRuleVal': {k: r['val']['decisionRuleVsBaseline'][k] for k in ('a', 'b', 'provisionalPass', 'anyInconclusive')}})
    # Node-mode finalists go to finalists.node.json: finalists.json now holds the browser
    # (shipping-pipeline) finalists from `--source browser` (phase D2), which --final-test reads.
    (HERE / 'finalists.node.json').write_text(json.dumps(fin, indent=1) + '\n')

    write_summary(results, all_ranked, finalists, base_ref)
    print(f'done in {time.time() - t0:.0f}s; eligible {len(eligible)}; finalists {out["finalists"]}')


_base_cache = {}


def results_base_point(sb, fr, th):
    k = id(fr)
    if k not in _base_cache:
        _base_cache[k] = {'recall@T_only': rate(sb >= th['T_only'], fr.pos['horror']),
                          'minimalist@T_only': rate(sb >= th['T_only'], fr.pos['horror:minimalist']),
                          'minimalist@T_page': rate(sb >= th['T_page'], fr.pos['horror:minimalist'])}
    return _base_cache[k]


def cfg_id(key):
    return '|'.join(key)


def write_summary(results, ranked, finalists, base_ref):
    fin_ids = {cfg_id((r['model'], r['approach'], r['dtype'])) for r in finalists}
    lines = ['| config | role | AUC | recall@T_only | minimalist@T_page | max\\|Δ\\| vs fp32 | MB raw (zip) | Node p50 ms | eligible |',
             '|---|---|---|---|---|---|---|---|---|']
    for cid in ranked:
        r = results[cid]
        v = r['val']
        ci_r = v['ci95']['T_only.recall']
        el = 'yes' if r['eligible'] else 'no: ' + '; '.join(r['ineligibleReasons'])
        mark = ' **finalist**' if cid in fin_ids else (' (baseline)' if cid == cfg_id(BASE) else '')
        sz = r['size']
        lines.append(f'| `{cid}`{mark} | {r["role"]} | {v["ranking"]["auc"]:.3f} | {v["at"]["T_only"]["recall"] * 100:.1f} '
                     f'[{ci_r[0] * 100:.0f}, {ci_r[1] * 100:.0f}] | {v["at"]["T_page"]["minimalistRecall"] * 100:.1f} | '
                     f'{r["precision"]["maxAbs"]:.2f} | {sz["bytes"] / 1e6:.1f} ({sz["deflateBytes"] / 1e6:.1f}) | '
                     f'{r["nodeTiming"]["p50Ms"]:.1f} | {el} |' if r['nodeTiming'] and sz else f'| `{cid}` | missing data |')
    (CACHE / 'val-summary.md').write_text('\n'.join(lines) + '\n')


# ---------------------------------------------------------------- browser mode (phase D2)
#
# Same metrics as the default mode, but on the SHIPPING pipeline: embeddings made inside Chrome
# through the extension's real decode (phase E2, fp16, WASM). The baseline is MobileCLIP's in-browser
# shipped zero-shot score, i.e. what users get today. Differences from phase D:
#   - heads are trained on browser TRAIN embeddings; C by val log-loss subject to backend stability
#     (max |score(WASM) - score(WebGPU)| <= 2 on the 200-image parity subset; label-free. 32 of the 200
#     are test images: only their unlabelled WASM/WebGPU score gap is read, and requiring the bar on all
#     200 is strictly stricter than on the 168 non-test ones, which are reported too)
#   - zero-shot prompt variants are re-selected on browser VAL per view (phase C's rule)
#   - T_veto: share of ALL val horror at or below it = the baseline's share at or below 40
#     (coordinator decision); the old moody-matched line is kept as T_veto_moody
#   - eligibility: licence candidate, vision file <= 85 MB (user decision), Node fp16-vs-fp32 max
#     |delta| <= 2 with the config's own scorer, backend parity <= 2, WASM ms/img (E2) <= 250

EMB_BROWSER = CACHE / 'emb-browser'
PROMPT_CACHE = CACHE / 'prompts'
OUT_DIR = CACHE           # where --final-test writes (a dry run points this elsewhere)
BROWSER_MODELS = ['tinyclip-vit-8m-16-yfcc15m', 'tinyclip-vit-40m-32-laion400m']
VIEWS = ['crop', 'squash']
BASE_B = 'mobileclip-s0|zero-shot|fp16|crop'
SIZE_CAP_B = 85e6         # bytes, raw fp16 vision file (user decision 2026-10-05)
PARITY_MAX = 2.0          # points, WASM vs WebGPU score
WASM_MS_BAR = 250         # ms/img p50, E2 full-set WASM
ZS_AUC_TOL = 0.005        # phase C's variant rule: within this of the best val AUC, then lowest hard-safe FB@R80


def load_f32(meta_path, ids):
    meta = json.loads(Path(meta_path).read_text())
    if meta.get('status', 'ok') != 'ok' or meta.get('failures'):
        raise SystemExit(f'ABORT: {meta_path} is not a complete embedding file')
    X = np.fromfile(str(meta_path)[:-5] + '.f32', dtype='<f4').reshape(meta['n'], meta['dim'])
    pos = {i: k for k, i in enumerate(meta['ids'])}
    X = X[[pos[i] for i in ids]].astype(np.float64)
    if not np.isfinite(X).all():
        raise SystemExit(f'ABORT: non-finite embedding values in {meta_path}')
    n = np.linalg.norm(X, axis=1, keepdims=True)
    if (n == 0).any():
        raise SystemExit(f'ABORT: zero embedding in {meta_path}')
    return X / n


def browser_emb(model, view, device, ids):
    return load_f32(EMB_BROWSER / f'{model}-{view}-{device}.json', ids)


def browser_meta(model, view, device):
    return json.loads((EMB_BROWSER / f'{model}-{view}-{device}.json').read_text())


def baseline_browser_scores(ids, device='wasm'):
    d = browser_meta('mobileclip-s0', 'crop', device)['scores']
    s = np.array([d[i] for i in ids], dtype=np.float64)
    if not np.isfinite(s).all():
        raise SystemExit('ABORT: non-finite MobileCLIP browser score')
    return s


def load_prompt_set(model, variant):
    d = PROMPT_CACHE / model / variant
    meta = json.loads((d / 'prompt-embeddings.json').read_text())
    P = np.fromfile(d / meta['embeddings'], dtype='<f4').reshape(len(meta['prompts']), meta['dim']).astype(np.float64)
    return {'P': P, 'horror': np.array([p['label'] == 'horror' for p in meta['prompts']]),
            'logitScale': float(meta['logitScale']), 'variant': variant, 'nPrompts': len(meta['prompts'])}


def zs_scores(X, ps):
    """scoreEmbedding (eval/image-classifier.mjs): softmax over prompts at logitScale, summed horror x 100."""
    z = (X @ ps['P'].T) * ps['logitScale']
    z -= z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return 100.0 * e[:, ps['horror']].sum(axis=1) / e.sum(axis=1)


def scorer_for(entry):
    """X (L2-normalised) -> scores, for a browser-mode config entry (as stored in val-results-browser.json)."""
    if entry['approach'] == 'zero-shot':
        ps = load_prompt_set(entry['model'], entry['promptVariant'])
        return lambda X: zs_scores(X, ps)
    head = json.loads((HERE.parent.parent / entry['head']).read_text())
    return lambda X: head_score(head, X)


def browser_score(entry, ids):
    """Scores on the shipping pipeline (browser WASM) for a config entry; Node-only references use Node files."""
    if entry['source'] == 'browser-wasm':
        if entry['model'] == 'mobileclip-s0' and entry['approach'] == 'zero-shot':
            return baseline_browser_scores(ids)
        return scorer_for(entry)(browser_emb(entry['model'], entry['view'], 'wasm', ids))
    if entry['approach'] == 'zero-shot':      # Node ceiling reference (CLIP B/32)
        return load_zs(entry['model'], entry['dtype'], ids)
    return head_score(json.loads((HERE.parent.parent / entry['head']).read_text()), load_emb(entry['model'], entry['dtype'], ids))


def parity_ids():
    return json.loads((HERE / 'parity-subset.json').read_text())['ids']


def parity_stats(fn_w, fn_g):
    """fn_*: () -> (scores_sel, scores_all) on WASM / WebGPU. Label-free."""
    (ws, wa), (gs, ga) = fn_w(), fn_g()
    ds, da = np.abs(ws - gs), np.abs(wa - ga)
    return {'maxAbsSel': float(ds.max()), 'p95AbsSel': float(np.percentile(ds, 95)), 'nSel': int(len(ds)),
            'maxAbsAll200': float(da.max()), 'p95AbsAll200': float(np.percentile(da, 95)), 'meanAbsAll200': float(da.mean()),
            'nAll200': int(len(da)), 'pass': bool(da.max() <= PARITY_MAX)}


def train_head_parity(Xtr, ytr, Xva, yva, Xw_sel, Xg_sel, Xw_all, Xg_all):
    """L2 logistic regression on TRAIN. Weighting as phase D; C = best val log-loss among C whose
    float32 head keeps max |WASM - WebGPU| <= PARITY_MAX on all 200 parity images (label-free)."""
    grid = []
    for cw in (None, 'balanced'):
        for C in C_GRID:
            clf = LogisticRegression(C=C, class_weight=cw, max_iter=20000, tol=1e-8).fit(Xtr, ytr)
            p = clf.predict_proba(Xva)[:, 1]
            h = {'w': [f32(x) for x in clf.coef_[0]], 'b': f32(clf.intercept_[0])}
            ds = np.abs(head_score(h, Xw_sel) - head_score(h, Xg_sel))
            da = np.abs(head_score(h, Xw_all) - head_score(h, Xg_all))
            grid.append({'C': C, 'classWeight': cw, 'valLogLoss': float(log_loss(yva, p, labels=[0, 1])),
                         'valAuc': float(roc_auc_score(yva, p)), 'parityMaxSel': float(ds.max()),
                         'parityMaxAll200': float(da.max()), '_head': h})
    best = {cw: min((g for g in grid if g['classWeight'] == cw), key=lambda g: g['valLogLoss']) for cw in (None, 'balanced')}
    cw = 'balanced' if best['balanced']['valAuc'] >= best[None]['valAuc'] + CW_MIN_GAIN else None
    cand = [g for g in grid if g['classWeight'] == cw]
    unc = min(cand, key=lambda g: g['valLogLoss'])
    ok = [g for g in cand if g['parityMaxAll200'] <= PARITY_MAX]
    con = min(ok, key=lambda g: g['valLogLoss']) if ok else None
    strip = lambda g: {k: v for k, v in g.items() if k != '_head'}
    return (con or unc)['_head'], {'classWeight': cw, 'C': (con or unc)['C'], 'cUnconstrained': unc['C'],
                                   'constraintMet': con is not None, 'chosen': strip(con or unc),
                                   'unconstrained': strip(unc), 'grid': [strip(g) for g in grid]}


def zs_variant_metrics(s, fr):
    pos, hard = s[fr.pos['horror']], s[fr.pos['hard']]
    srt = np.sort(pos)[::-1]
    t = srt[int(math.ceil(0.8 * len(srt))) - 1]
    return {'valAuc': float(roc_auc_score(fr.y, s)), 'valHardFalseBlurAtRecall80': float((hard >= t).mean()),
            'valThresholdAtRecall80': float(t)}


def thresholds_browser(s, fr, bref):
    hs = s[fr.pos['hard']]
    return {'T_only': thr_rate(hs, 0.02), 'T_page': thr_rate(hs, 0.05),
            'T_block': thr_count(hs, bref['blockCount']),
            'T_veto': veto_line(s[fr.pos['horror']], bref['horrorKeep']),
            'T_veto_moody': veto_line(s[fr.pos['horror:moody']], bref['moodyKeep'])}


def robustness(score_fn, model, view, th, extra_bars=None):
    """Node, matching view emulation, fp16: score change under JPEG q70 and 50% downscale (200 parity images)."""
    ids = parity_ids()
    s0 = score_fn(load_f32(EMB / f'{model}-fp16-{view}.json', ids))
    out = {'n': len(ids), 'reference': f'.cache/emb/{model}-fp16-{view} (Node, untransformed)'}
    bars = {k: th[k] for k in ('T_only', 'T_page')}
    bars.update(extra_bars or {})
    for v in ('jpeg70', 'half'):
        sv = score_fn(load_f32(EMB / 'robust' / f'{model}-fp16-{view}-{v}.json', ids))
        d = sv - s0
        a = np.abs(d)
        out[v] = {'p50Abs': float(np.percentile(a, 50)), 'p95Abs': float(np.percentile(a, 95)), 'maxAbs': float(a.max()),
                  'meanSigned': float(d.mean()), 'maxId': ids[int(a.argmax())],
                  'flips': {k: int(((sv >= T) != (s0 >= T)).sum()) for k, T in bars.items()}}
    return out


def node_precision(score_fn, model, ids_tv, th):
    X32, X16 = load_emb(model, 'fp32', ids_tv), load_emb(model, 'fp16', ids_tv)
    if X32 is None or X16 is None:
        return None
    a, b = score_fn(X16), score_fn(X32)
    d = np.abs(a - b)
    flips = {k: int((((a <= T) != (b <= T)) if is_veto(k) else ((a >= T) != (b >= T))).sum()) for k, T in th.items()}
    return {'vs': 'fp32', 'n': int(len(d)), 'maxAbs': float(d.max()), 'p95Abs': float(np.percentile(d, 95)),
            'meanAbs': float(d.mean()), 'flips': flips, 'pass': bool(d.max() <= MAX_DELTA),
            'note': 'Node embeddings at the processor default geometry (squash for TinyCLIP); a model-precision check only'}


def decision_rule_browser(s, pm, sb, base_th, fr, plans, bfs, bf_vals, base_fixed, base_rep, base_ref):
    rep = [repicked(s[idx], bf, base_ref) for idx, bf in zip(plans, bfs)]
    bp = {'recall@T_only': rate(sb >= base_th['T_only'], fr.pos['horror']),
          'minimalist@T_only': rate(sb >= base_th['T_only'], fr.pos['horror:minimalist']),
          'minimalist@T_page': rate(sb >= base_th['T_page'], fr.pos['horror:minimalist'])}
    pt = {'recall@T_only': pm['at']['T_only']['recall'] - bp['recall@T_only'],
          'minimalist@T_only': pm['at']['T_only']['minimalistRecall'] - bp['minimalist@T_only'],
          'minimalist@T_page': pm['at']['T_page']['minimalistRecall'] - bp['minimalist@T_page']}
    fixed_map = {'recall@T_only': 'T_only.recall', 'minimalist@T_only': 'T_only.minimalistRecall',
                 'minimalist@T_page': 'T_page.minimalistRecall'}
    margins = {'recall@T_only': -3.0, 'minimalist@T_only': -5.0, 'minimalist@T_page': -5.0}
    rule = {}
    for k in pt:
        d = pt[k] * 100
        flo, fhi = [x * 100 for x in ci([b[fixed_map[k]] - bb[fixed_map[k]] for b, bb in zip(bf_vals, base_fixed)])]
        lo, hi = [x * 100 for x in ci([r[k] - rb[k] for r, rb in zip(rep, base_rep)])]
        vf = 'pass' if flo >= margins[k] else ('fail' if fhi < margins[k] else 'inconclusive')
        vr = 'pass' if lo >= margins[k] else ('fail' if hi < margins[k] else 'inconclusive')
        rule[k] = {'deltaPts': d, 'marginPts': margins[k], 'pass': d >= margins[k], 'ci95FixedPts': [flo, fhi],
                   'ci95RepickedPts': [lo, hi], 'verdictFixed': vf, 'verdictRepicked': vr,
                   'verdict': vf if vf == vr else 'inconclusive'}
    rule['a'] = rule['recall@T_only']['pass']
    rule['b'] = rule['minimalist@T_only']['pass'] and rule['minimalist@T_page']['pass']
    rule['provisionalPass'] = rule['a'] and rule['b']
    rule['anyInconclusive'] = any(rule[k]['verdict'] == 'inconclusive' for k in pt)
    return rule


def main_browser():
    t0 = time.time()
    rows = load_manifest({'train', 'val'})
    by_split = {sp: [r for r in rows if r['split'] == sp] for sp in ('train', 'val')}
    ids = {sp: [r['id'] for r in by_split[sp]] for sp in by_split}
    ids_tv = ids['train'] + ids['val']
    frames = {sp: Frame([1 if r['label'] == 'horror' else 0 for r in by_split[sp]], [r['group'] for r in by_split[sp]],
                        [r['cluster'] for r in by_split[sp]], ids[sp]) for sp in by_split}
    fr = frames['val']
    ytr, yva = frames['train'].y, fr.y
    # Parity subset: ids + split only (no labels). Test members are reported, never used to decide.
    split_of = {r['id']: r['split'] for r in json.loads((HERE / 'images.json').read_text())}
    p_all = parity_ids()
    p_sel = [i for i in p_all if split_of[i] != 'test']
    print(f'train {len(ytr)} ({ytr.sum()} horror)  val {len(yva)} ({yva.sum()} horror)  parity {len(p_sel)}/{len(p_all)} non-test')
    summ = json.loads((CACHE / 'browser-embed-summary.json').read_text())
    sz, rl = sizes(), roles()
    pack_zip = {k: v.get('packZipMB') for k, v in json.loads((CACHE / 'browser-results.json').read_text())['candidates'].items()}

    # --- baseline: MobileCLIP in-browser shipped zero-shot (WASM, crop = the shipped decode)
    sb = baseline_browser_scores(ids['val'])
    hs_b = sb[fr.pos['hard']]
    base_ref = {'blockCount': int((hs_b >= SHIPPED_BARS['IMAGE_BLOCK_SCORE']).sum()),
                'blockRate': float((hs_b >= SHIPPED_BARS['IMAGE_BLOCK_SCORE']).mean()),
                'horrorKeep': float((sb[fr.pos['horror']] > SHIPPED_BARS['IMAGE_VETO_SCORE']).mean()),
                'horrorAtOrBelow40': int((sb[fr.pos['horror']] <= SHIPPED_BARS['IMAGE_VETO_SCORE']).sum()),
                'moodyKeep': float((sb[fr.pos['horror:moody']] > SHIPPED_BARS['IMAGE_VETO_SCORE']).mean()),
                'nHardVal': int(len(hs_b)), 'nHorrorVal': int(len(fr.pos['horror'])), 'nMoodyVal': int(len(fr.pos['horror:moody']))}
    print('base ref (browser)', base_ref)

    entries = {}   # cid -> config entry (without metrics yet)
    scores = {}    # cid -> val scores
    head_meta = {}
    HEADS.mkdir(exist_ok=True)

    def add(cid, entry, s_val):
        if not np.isfinite(s_val).all():
            raise SystemExit(f'ABORT: NaN scores for {cid}')
        entries[cid], scores[cid] = entry, s_val

    add(BASE_B, {'model': 'mobileclip-s0', 'approach': 'zero-shot', 'dtype': 'fp16', 'view': 'crop', 'source': 'browser-wasm',
                 'promptVariant': 'shipped', 'head': None}, sb)

    # --- heads and zero-shot on browser embeddings
    for m in ['mobileclip-s0'] + BROWSER_MODELS:
        for view in (['crop'] if m == 'mobileclip-s0' else VIEWS):
            Xtr, Xva = browser_emb(m, view, 'wasm', ids['train']), browser_emb(m, view, 'wasm', ids['val'])
            Xw_s, Xg_s = browser_emb(m, view, 'wasm', p_sel), browser_emb(m, view, 'webgpu', p_sel)
            Xw_a, Xg_a = browser_emb(m, view, 'wasm', p_all), browser_emb(m, view, 'webgpu', p_all)
            h, info = train_head_parity(Xtr, ytr, Xva, yva, Xw_s, Xg_s, Xw_a, Xg_a)
            hp = f'eval/bakeoff/heads/{m}-{view}-browser.json'
            head = {'model': m, 'view': view, 'trainedOn': 'browser WASM fp16 embeddings (phase E2), TRAIN split',
                    'dim': int(Xtr.shape[1]), 'normalise': 'l2', 'score': '100 * sigmoid(w . e_hat + b), e_hat = e / ||e||',
                    'C': info['C'], 'cUnconstrained': info['cUnconstrained'], 'classWeight': info['classWeight'],
                    'parityConstraintMet': info['constraintMet'],
                    'parity': {'maxAbsWasmVsWebgpu': info['chosen']['parityMaxAll200'], 'n': len(p_all),
                               'maxAbsWasmVsWebgpuNonTest': info['chosen']['parityMaxSel'], 'nNonTest': len(p_sel),
                               'unconstrainedMaxAbs': info['unconstrained']['parityMaxAll200']},
                    'b': h['b'], 'w': h['w']}
            (HERE / 'heads' / f'{m}-{view}-browser.json').write_text(json.dumps(head) + '\n')
            head_meta[f'{m}-{view}'] = {**{k: v for k, v in info.items()}, 'file': hp}
            print(f'head {m}-{view}: C={info["C"]} (unconstrained {info["cUnconstrained"]}) cw={info["classWeight"]} '
                  f'parity sel={info["chosen"]["parityMaxSel"]:.2f} all={info["chosen"]["parityMaxAll200"]:.2f} '
                  f'(unconstrained {info["unconstrained"]["parityMaxAll200"]:.2f}) ll={info["chosen"]["valLogLoss"]:.4f}')
            e = {'model': m, 'approach': 'head', 'dtype': 'fp16', 'view': view, 'source': 'browser-wasm', 'head': hp, 'promptVariant': None}
            add(f'{m}|head|fp16|{view}', e, head_score(head, Xva))
            if info['cUnconstrained'] != info['C']:   # reference row: what the parity constraint costs
                clf = LogisticRegression(C=info['cUnconstrained'], class_weight=info['classWeight'], max_iter=20000, tol=1e-8).fit(Xtr, ytr)
                hu = {**head, 'C': info['cUnconstrained'], 'parityConstraintMet': False, 'note': 'unconstrained C, reference only',
                      'b': f32(clf.intercept_[0]), 'w': [f32(x) for x in clf.coef_[0]]}
                ud = CACHE / 'heads-unconstrained'
                ud.mkdir(exist_ok=True)
                (ud / f'{m}-{view}-browser.json').write_text(json.dumps(hu) + '\n')
                eu = {**e, 'approach': 'head-unconstrained', 'head': f'eval/bakeoff/.cache/heads-unconstrained/{m}-{view}-browser.json'}
                add(f'{m}|head-unconstrained|fp16|{view}', eu, head_score(hu, Xva))
            if m == 'mobileclip-s0':
                continue
            # zero-shot: re-select phase C's variants on browser VAL for this view
            vj = json.loads((HERE / 'prompts' / f'{m}.variants.json').read_text())
            var = []
            for v in vj['variants']:
                ps = load_prompt_set(m, v['variant'])
                var.append({'variant': v['variant'], 'nPrompts': ps['nPrompts'], **zs_variant_metrics(zs_scores(Xva, ps), fr),
                            'nodeSquashValAuc': v.get('valAuc'), 'nodeSquashValHardFalseBlurAtRecall80': v.get('valHardFalseBlurAtRecall80')})
            best_auc = max(v['valAuc'] for v in var)
            pick = min((v for v in var if v['valAuc'] >= best_auc - ZS_AUC_TOL), key=lambda v: (v['valHardFalseBlurAtRecall80'], -v['valAuc']))
            head_meta[f'{m}-{view}-zeroShotVariants'] = {'chosen': pick['variant'], 'nodeChosen': vj['chosen'], 'variants': var}
            print(f'zero-shot {m}-{view}: browser pick {pick["variant"]} (auc {pick["valAuc"]:.4f}); node pick {vj["chosen"]}')
            ps = load_prompt_set(m, pick['variant'])
            add(f'{m}|zero-shot|fp16|{view}', {'model': m, 'approach': 'zero-shot', 'dtype': 'fp16', 'view': view,
                                               'source': 'browser-wasm', 'head': None, 'promptVariant': pick['variant'],
                                               'nodeChosenVariant': vj['chosen']}, zs_scores(Xva, ps))

    # --- CLIP B/32: Node-only ceiling reference (squash view), not comparable to browser numbers
    for ap in ('zero-shot', 'head'):
        e = {'model': 'clip-vit-b-32', 'approach': ap, 'dtype': 'fp16', 'view': 'node-squash', 'source': 'node',
             'head': 'eval/bakeoff/heads/clip-vit-b-32-fp16.json' if ap == 'head' else None,
             'promptVariant': json.loads((HERE / 'prompts' / 'clip-vit-b-32.json').read_text()).get('variant') if ap == 'zero-shot' else None}
        add(f'clip-vit-b-32|{ap}|fp16|node-squash', e, browser_score(e, ids['val']))

    # sanity: browser_score (the --final-test path) reproduces every val score vector exactly
    for cid, e in entries.items():
        d = np.abs(browser_score(e, ids['val']) - scores[cid]).max()
        if d > 1e-9:
            raise SystemExit(f'ABORT: browser_score mismatch for {cid}: {d}')

    # --- metrics, bootstrap, eligibility
    plans = boot_plan(fr)
    bfs = [fr.take(idx) for idx in plans]
    th_all = {cid: thresholds_browser(s, fr, base_ref) for cid, s in scores.items()}
    base_th = th_all[BASE_B]
    base_fixed = [flat(point_metrics(sb[idx], bf, base_th, False)) for idx, bf in zip(plans, bfs)]
    base_rep = [repicked(sb[idx], bf, base_ref) for idx, bf in zip(plans, bfs)]
    results = {}
    for cid, e in entries.items():
        s, th = scores[cid], th_all[cid]
        m, ap, view = e['model'], e['approach'], e['view']
        pm = point_metrics(s, fr, th)
        bf_vals = [flat(point_metrics(s[idx], bf, th, False)) for idx, bf in zip(plans, bfs)]
        pm['ci95'] = {k: ci([b[k] for b in bf_vals]) for k in bf_vals[0]}
        if cid == BASE_B:
            pm['atShippedBars'] = {'IMAGE_ONLY_BLOCK_SCORE': block_metrics(s, 80, fr), 'IMAGE_BLOCK_SCORE': block_metrics(s, 76, fr),
                                   'IMAGE_BLOCK_SCORE_HORROR_PAGE': block_metrics(s, 65, fr), 'IMAGE_VETO_SCORE': veto_metrics(s, 40, fr)}
            sh = {'S80': 80, 'S76': 76, 'S65': 65}
            sbv = [{**{f'{n}.{k}': v for n, T in sh.items() for k, v in block_metrics(s[idx], T, bf).items() if k != 'T'},
                    **{f'S40.{k}': v for k, v in veto_metrics(s[idx], 40, bf).items() if k != 'V'}} for idx, bf in zip(plans, bfs)]
            pm['atShippedBarsCi95'] = {k: ci([b[k] for b in sbv]) for k in sbv[0]}
        pm['decisionRuleVsBaseline'] = decision_rule_browser(s, pm, sb, base_th, fr, plans, bfs, bf_vals, base_fixed, base_rep, base_ref)

        browser = e['source'] == 'browser-wasm'
        fn = scorer_for(e) if not (m == 'mobileclip-s0' and ap == 'zero-shot') else scorer_for({**e, 'promptVariant': 'shipped'})
        par = None
        if browser:
            if m == 'mobileclip-s0' and ap == 'zero-shot':
                par = parity_stats(lambda: (baseline_browser_scores(p_sel), baseline_browser_scores(p_all)),
                                   lambda: (baseline_browser_scores(p_sel, 'webgpu'), baseline_browser_scores(p_all, 'webgpu')))
            else:
                par = parity_stats(lambda: (fn(browser_emb(m, view, 'wasm', p_sel)), fn(browser_emb(m, view, 'wasm', p_all))),
                                   lambda: (fn(browser_emb(m, view, 'webgpu', p_sel)), fn(browser_emb(m, view, 'webgpu', p_all))))
        prec = node_precision(fn, m, ids_tv, th)
        rob = None
        if browser:
            extra = {'S80': 80, 'S65': 65} if cid == BASE_B else None
            rob = robustness(fn, m, view, th, extra)
        sm = summ.get(f'{m}/{view}') if browser else None
        wasm_ms = sm['wasmMsP50'] if sm else None
        size = (sz.get(m) or {}).get('fp16')
        role = rl.get(m, {}).get('role')
        reasons = []
        if role != 'candidate':
            reasons.append({'reference': 'ceiling reference only (Node, squash view, not comparable to browser numbers)',
                            'baseline': 'baseline only (apple-amlr, research-only licence)'}.get(role, f'role {role}'))
        if size is None:
            reasons.append('no size record')
        elif size['bytes'] > SIZE_CAP_B:
            reasons.append(f'vision file {size["bytes"] / 1e6:.1f} MB > 85 MB cap')
        if prec is None:
            reasons.append('no Node fp32 reference for the precision check')
        elif not prec['pass']:
            reasons.append(f'Node fp16 vs fp32 max |delta| {prec["maxAbs"]:.2f} > 2')
        if ap == 'head-unconstrained':
            reasons.append('reference row: unconstrained C, shows what the parity constraint costs')
        if not browser:
            reasons.append('no browser embeddings (Node only)')
        else:
            if not par['pass']:
                reasons.append(f'backend parity max |WASM-WebGPU| {par["maxAbsAll200"]:.2f} > 2')
            if wasm_ms is None or wasm_ms > WASM_MS_BAR:
                reasons.append(f'WASM ms/img {wasm_ms} > {WASM_MS_BAR}')
        flags = []
        if pm['ranking']['auc'] >= AUC_LEAK_FLAG:
            flags.append(f'val AUC {pm["ranking"]["auc"]:.4f} >= {AUC_LEAK_FLAG}: check for leakage')
        if th['T_veto'] >= th['T_page']:
            flags.append(f'T_veto {th["T_veto"]:.2f} >= T_page {th["T_page"]:.2f}')
        if ap == 'head' and browser and not head_meta[f'{m}-{view}']['constraintMet']:
            flags.append('no C in the grid meets the parity constraint; unconstrained C used')
        results[cid] = {**e, 'role': {'reference': 'ceiling-reference'}.get(role, role), 'thresholds': th, 'val': pm,
                        'parity': par, 'precision': prec, 'robustness': rob, 'size': size,
                        'packZipMB': pack_zip.get(m) if m != 'mobileclip-s0' else 26.0,
                        'wasmMsP50': wasm_ms, 'webgpuMsP50': sm['webgpuMsP50'] if sm else None,
                        'eligible': not reasons, 'ineligibleReasons': reasons, 'flags': flags}
        r_ = pm['at']
        print(f'{cid:48s} auc={pm["ranking"]["auc"]:.4f} r@only={r_["T_only"]["recall"]:.3f} min@only={r_["T_only"]["minimalistRecall"]:.2f} '
              f'min@page={r_["T_page"]["minimalistRecall"]:.2f} par={par["maxAbsAll200"] if par else float("nan"):.2f} '
              f'prec={prec["maxAbs"] if prec else float("nan"):.2f} elig={not reasons}')

    excluded = {'dinov2-small': {'reason': 'out: WASM 270 ms/img in phase E (> 250 ms bar) and runtime-only |delta| with Node pixels '
                                           'max 3.03 on WASM / 3.91 on WebGPU (> 2); not embedded in phase E2',
                                 'phaseE': {'wasmPerImageMsP50': 270, 'nodePixelsMaxAbsWasm': 3.03, 'nodePixelsMaxAbsWebgpu': 3.91}}}

    def rank_key(r):
        v = r['val']
        return (-v['at']['T_only']['recall'], -v['at']['T_page']['minimalistRecall'], -v['ranking']['auc'], r['size']['deflateBytes'])
    eligible = sorted((r for r in results.values() if r['eligible']), key=rank_key)
    cid_of = lambda r: f'{r["model"]}|{r["approach"]}|{r["dtype"]}|{r["view"]}'
    leaderboard = [cid_of(r) for r in eligible]
    all_ranked = [cid_of(r) for r in sorted(results.values(), key=rank_key)]
    finalists, seen = [], set()
    for r in eligible:
        if r['model'] not in seen:
            seen.add(r['model']); finalists.append(r)
        if len(finalists) == 2:
            break

    gen = time.strftime('%Y-%m-%dT%H:%M:%S')
    out = {'generated': gen, 'mode': 'browser (train/val only; test labels never read)', 'sourceMode': 'browser',
           'counts': {'train': int(len(ytr)), 'trainHorror': int(ytr.sum()), 'val': int(len(yva)), 'valHorror': int(yva.sum()),
                      'valHardSafe': int(len(fr.pos['hard'])), 'valEasySafe': int(len(fr.pos['easy'])),
                      'valMinimalist': int(len(fr.pos['horror:minimalist'])), 'valMoody': int(len(fr.pos['horror:moody'])),
                      'valCollision': int(len(fr.pos['hard:collision'])), 'parityNonTest': len(p_sel), 'parityAll': len(p_all)},
           'settings': {'cGrid': C_GRID, 'nBoot': N_BOOT, 'seed': SEED, 'thresholdGrid': T_STEP, 'block': 'score >= T', 'veto': 'score <= V',
                        'sizeCapBytes': SIZE_CAP_B, 'parityMaxPts': PARITY_MAX, 'wasmMsBar': WASM_MS_BAR, 'maxDeltaPts': MAX_DELTA,
                        'T_veto': 'largest V with share(val horror <= V) <= baseline share at <= 40',
                        'T_veto_moody': 'phase D rule (moody share above), kept for transparency',
                        'embeddings': 'eval/bakeoff/.cache/emb-browser/<name>-<view>-wasm.f32 (Chrome for Testing, real decode, fp16)'},
           'baselineReference': base_ref, 'heads': head_meta, 'configs': results, 'excluded': excluded,
           'leaderboardEligible': leaderboard, 'rankingAllConfigs': all_ranked,
           'finalists': [cid_of(r) for r in finalists], 'noEligible': not eligible,
           'notes': ['Val numbers are optimistic: thresholds, head C and the zero-shot variant were all picked on val.',
                     'CLIP B/32 rows are Node, squash view, not comparable to browser numbers.',
                     'Robustness is Node with view emulation (not the browser decode); informative, not gating.']}
    (CACHE / 'val-results-browser.json').write_text(json.dumps(out, indent=1))

    fin = {'generated': gen, 'source': 'eval/bakeoff/analyze.py --source browser (val only)', 'sourceMode': 'browser',
           'rule': 'eligible configs (view included) ranked on browser val by recall@T_only, minimalist@T_page, AUC, then smaller zip; best config of the top two distinct models',
           'baseline': {'config': BASE_B, 'scores': 'MobileCLIP-S0 in-browser shipped zero-shot (WASM, crop)',
                        'thresholds': results[BASE_B]['thresholds'], 'shippedBars': SHIPPED_BARS},
           'finalists': []}
    for r in finalists:
        v = r['val']
        fin['finalists'].append({
            'config': cid_of(r), 'model': r['model'], 'approach': r['approach'], 'dtype': r['dtype'], 'view': r['view'],
            'head': r['head'], 'promptVariant': r['promptVariant'],
            'prompts': (f'eval/bakeoff/.cache/prompts/{r["model"]}/{r["promptVariant"]}' if r['approach'] == 'zero-shot' else None),
            'thresholds': r['thresholds'],
            'val': {'auc': v['ranking']['auc'], 'recall@T_only': v['at']['T_only']['recall'],
                    'minimalist@T_only': v['at']['T_only']['minimalistRecall'], 'minimalist@T_page': v['at']['T_page']['minimalistRecall'],
                    'collisionBelow@T_veto': v['at']['T_veto']['collisionBelow'], 'moodyAbove@T_veto': v['at']['T_veto']['moodyAbove']},
            'sizeBytes': r['size']['bytes'], 'deflateBytes': r['size']['deflateBytes'], 'packZipMB': r['packZipMB'],
            'parity': r['parity'], 'nodeFp16VsFp32MaxAbs': r['precision']['maxAbs'], 'wasmMsP50': r['wasmMsP50'],
            'robustness': {k: {kk: r['robustness'][k][kk] for kk in ('p50Abs', 'p95Abs', 'maxAbs', 'flips')} for k in ('jpeg70', 'half')},
            'decisionRuleVal': {k: v['decisionRuleVsBaseline'][k] for k in ('a', 'b', 'provisionalPass', 'anyInconclusive')}})
    (HERE / 'finalists.json').write_text(json.dumps(fin, indent=1) + '\n')
    write_browser_summary(results, all_ranked, {cid_of(r) for r in finalists})
    print(f'done in {time.time() - t0:.0f}s; eligible {len(eligible)}; finalists {out["finalists"]}')


def write_browser_summary(results, ranked, fin_ids):
    p = lambda x: '-' if x is None or (isinstance(x, float) and math.isnan(x)) else f'{x * 100:.0f}'
    lines = ['| config (model\\|approach\\|view) | AUC | T_only / T_page / T_block / T_veto | recall@T_only [CI] | minimalist @T_only / @T_page | '
             'hard FB @T_only | collision below / moody above @T_veto | parity max | fp16 Δ | robust p95 jpeg/half | MB raw (zip) | WASM ms | eligible |',
             '|---|---|---|---|---|---|---|---|---|---|---|---|---|']
    for cid in ranked:
        r = results[cid]
        v, th = r['val'], r['thresholds']
        a = v['at']
        c = v['ci95']['T_only.recall']
        mark = ' **finalist**' if cid in fin_ids else (' *baseline*' if cid == BASE_B else '')
        el = 'yes' if r['eligible'] else 'no: ' + '; '.join(r['ineligibleReasons'])
        rob = (f'{r["robustness"]["jpeg70"]["p95Abs"]:.1f} / {r["robustness"]["half"]["p95Abs"]:.1f}' if r['robustness'] else '-')
        sz = r['size']
        name = cid.replace('|fp16|', '|').replace('|', '\\|')
        lines.append(f'| {name}{mark} | {v["ranking"]["auc"]:.3f} | {th["T_only"]:.2f} / {th["T_page"]:.2f} / {th["T_block"]:.2f} / {th["T_veto"]:.2f} | '
                     f'{p(a["T_only"]["recall"])} [{p(c[0])}, {p(c[1])}] | {p(a["T_only"]["minimalistRecall"])} / {p(a["T_page"]["minimalistRecall"])} | '
                     f'{a["T_only"]["hardFalseBlur"] * 100:.1f} | {p(a["T_veto"]["collisionBelow"])} / {p(a["T_veto"]["moodyAbove"])} | '
                     f'{r["parity"]["maxAbsAll200"]:.2f} | ' if r['parity'] else
                     f'| {name}{mark} | {v["ranking"]["auc"]:.3f} | {th["T_only"]:.2f} / {th["T_page"]:.2f} / {th["T_block"]:.2f} / {th["T_veto"]:.2f} | '
                     f'{p(a["T_only"]["recall"])} [{p(c[0])}, {p(c[1])}] | {p(a["T_only"]["minimalistRecall"])} / {p(a["T_page"]["minimalistRecall"])} | '
                     f'{a["T_only"]["hardFalseBlur"] * 100:.1f} | {p(a["T_veto"]["collisionBelow"])} / {p(a["T_veto"]["moodyAbove"])} | - | ')
        lines[-1] += (f'{r["precision"]["maxAbs"]:.2f} | {rob} | {sz["bytes"] / 1e6:.1f} ({sz["deflateBytes"] / 1e6:.1f}) | '
                      f'{r["wasmMsP50"] if r["wasmMsP50"] else "-"} | {el} |')
        if cid == BASE_B:
            s = v['atShippedBars']
            lines.append(f'| mobileclip-s0\\|zero-shot\\|crop *at shipped bars 80/65/76/40* | {v["ranking"]["auc"]:.3f} | 80 / 65 / 76 / 40 | '
                         f'{p(s["IMAGE_ONLY_BLOCK_SCORE"]["recall"])} | {p(s["IMAGE_ONLY_BLOCK_SCORE"]["minimalistRecall"])} / '
                         f'{p(s["IMAGE_BLOCK_SCORE_HORROR_PAGE"]["minimalistRecall"])} | {s["IMAGE_ONLY_BLOCK_SCORE"]["hardFalseBlur"] * 100:.1f} | '
                         f'{p(s["IMAGE_VETO_SCORE"]["collisionBelow"])} / {p(s["IMAGE_VETO_SCORE"]["moodyAbove"])} | | | | | | |')
    (CACHE / 'val-summary-browser.md').write_text('\n'.join(lines) + '\n')


# ---------------------------------------------------------------- pre-test fixes (phase F, VAL only)
#
# Decided before test is read, written to pretest.json, which --final-test then requires:
#   (a) veto: the benefit-matched line, i.e. the LOWEST V whose val collision-below share is at least
#       the baseline's at 40 (the cost-matched T_veto from D2 copies the baseline's flaw of vetoing
#       ~41% of real horror). Reported with the share of all horror and of moody horror it vetoes.
#   (b) ml-bridge constants that keep veto < genre-listing <= horror-page <= block <= image-only.
#       GENRE_LISTING = veto + 1 (the shipped coupling) when that is <= T_page; otherwise it has to
#       be decoupled, and min(veto + 1, T_page) = T_page is used (stated per line below).
#   (c) WASM vs WebGPU verdict flips at every proposed bar on the 200 parity images (label-free).

PRETEST = HERE / 'pretest.json'


def benefit_veto_line(col, share):
    """Lowest V (0.01 grid) with share(col <= V) >= share."""
    a = np.sort(col)
    k = int(math.ceil(share * len(a) - 1e-9))
    if k <= 0:
        return 0.0
    return round(math.ceil(a[k - 1] / T_STEP - 1e-9) * T_STEP, 2)


def constants_for(th, veto):
    genre_coupled = round(veto + 1, 2)
    decoupled = genre_coupled > th['T_page']
    genre = th['T_page'] if decoupled else genre_coupled
    c = {'IMAGE_ONLY_BLOCK_SCORE': th['T_only'], 'IMAGE_BLOCK_SCORE': th['T_block'],
         'IMAGE_BLOCK_SCORE_HORROR_PAGE': th['T_page'], 'IMAGE_BLOCK_SCORE_GENRE_LISTING': genre,
         'IMAGE_VETO_SCORE': veto, 'UNVERIFIED_BLOCK_SCORE': 80}
    order = [c['IMAGE_VETO_SCORE'], c['IMAGE_BLOCK_SCORE_GENRE_LISTING'], c['IMAGE_BLOCK_SCORE_HORROR_PAGE'],
             c['IMAGE_BLOCK_SCORE'], c['IMAGE_ONLY_BLOCK_SCORE']]
    ok = order[0] < order[1] and all(x <= y for x, y in zip(order[1:], order[2:]))
    return c, {'genreListingCoupled': not decoupled, 'genreListingIfCoupled': genre_coupled, 'orderingOk': bool(ok),
               'genreRule': ('veto + 1 (shipped coupling, no code change)' if not decoupled else
                             f'veto + 1 = {genre_coupled} > T_page {th["T_page"]}: decouple in ml-bridge.js and set it to T_page')}


def main_pretest():
    t0 = time.time()
    rows = load_manifest({'train', 'val'})
    va = [r for r in rows if r['split'] == 'val']
    ids = [r['id'] for r in va]
    fr = Frame([1 if r['label'] == 'horror' else 0 for r in va], [r['group'] for r in va], [r['cluster'] for r in va], ids)
    fin = json.loads((HERE / 'finalists.json').read_text())
    if fin.get('sourceMode') != 'browser':
        sys.exit('--pretest needs browser finalists (run --source browser first)')
    val = json.loads((CACHE / 'val-results-browser.json').read_text())
    cids = [BASE_B] + [f['config'] for f in fin['finalists']]
    sc = {c: browser_score(val['configs'][c], ids) for c in cids}
    sb = sc[BASE_B]
    S = SHIPPED_BARS
    base_col = rate(sb <= S['IMAGE_VETO_SCORE'], fr.pos['hard:collision'])
    plans = boot_plan(fr)
    bfs = [fr.take(idx) for idx in plans]
    split_of = {r['id']: r['split'] for r in json.loads((HERE / 'images.json').read_text())}
    p_all = parity_ids()
    p_sel = [i for i in p_all if split_of[i] != 'test']

    def veto_report(s, V):
        m = veto_metrics(s, V, fr)
        bv = [veto_metrics(s[idx], V, bf) for idx, bf in zip(plans, bfs)]
        return {'V': V, 'collisionBelow': m['collisionBelow'], 'horrorVetoed': m['horrorVetoed'],
                'moodyVetoed': 1 - m['moodyAbove'], 'hardSafeVetoed': m['hardSafeVetoed'], 'easySafeVetoed': m['easySafeVetoed'],
                'ci95': {k: ci([b[k] for b in bv]) for k in ('collisionBelow', 'horrorVetoed', 'hardSafeVetoed')},
                'ci95MoodyVetoed': ci([1 - b['moodyAbove'] for b in bv]),
                'counts': {'collisionBelow': int((s[fr.pos['hard:collision']] <= V).sum()), 'nCollision': int(len(fr.pos['hard:collision'])),
                           'horrorVetoed': int((s[fr.pos['horror']] <= V).sum()), 'nHorror': int(len(fr.pos['horror'])),
                           'moodyVetoed': int((s[fr.pos['horror:moody']] <= V).sum()), 'nMoody': int(len(fr.pos['horror:moody']))}}

    def genre_report(s, T):
        m = block_metrics(s, T, fr)
        return {'T': T, 'recall': m['recall'], 'minimalistRecall': m['minimalistRecall'], 'hardFalseBlur': m['hardFalseBlur'],
                'easyFalseBlur': m['easyFalseBlur']}

    def flips(cid, bars):
        if cid == BASE_B:
            wa, ga = baseline_browser_scores(p_all), baseline_browser_scores(p_all, 'webgpu')
            ws, gs = baseline_browser_scores(p_sel), baseline_browser_scores(p_sel, 'webgpu')
        else:
            e = val['configs'][cid]
            fn = scorer_for(e)
            wa, ga = fn(browser_emb(e['model'], e['view'], 'wasm', p_all)), fn(browser_emb(e['model'], e['view'], 'webgpu', p_all))
            ws, gs = fn(browser_emb(e['model'], e['view'], 'wasm', p_sel)), fn(browser_emb(e['model'], e['view'], 'webgpu', p_sel))
        out = {}
        for name, T in bars.items():
            veto = 'VETO' in name or name.startswith('T_veto')
            f = (lambda a, b: int(((a <= T) != (b <= T)).sum())) if veto else (lambda a, b: int(((a >= T) != (b >= T)).sum()))
            out[name] = {'T': T, 'flipsAll200': f(wa, ga), 'flipsNonTest168': f(ws, gs)}
        anyf = np.zeros(len(wa), bool)
        for name, T in bars.items():
            veto = 'VETO' in name or name.startswith('T_veto')
            anyf |= ((wa <= T) != (ga <= T)) if veto else ((wa >= T) != (ga >= T))
        return {'n': len(p_all), 'nNonTest': len(p_sel), 'maxAbsScoreDelta': float(np.abs(wa - ga).max()),
                'bars': out, 'imagesWithAnyFlip': int(anyf.sum())}

    out = {'generated': time.strftime('%Y-%m-%dT%H:%M:%S'), 'mode': 'pre-test fixes (train/val only; test labels never read)',
           'baselineVal': {'collisionBelowAt40': base_col, 'collisionCount': int((sb[fr.pos['hard:collision']] <= 40).sum()),
                           'nCollision': int(len(fr.pos['hard:collision']))},
           'rules': {'vetoBenefitMatched': 'lowest V (0.01 grid) with val collision-below share >= the baseline share at 40',
                     'vetoCostMatched': 'D2 T_veto: largest V with no more val horror at or below it than the baseline at 40',
                     'genreListing': 'veto + 1 when <= T_page (shipped coupling); otherwise decoupled and set to T_page',
                     'flips': 'WASM vs WebGPU verdict flips per bar on the 200 parity images (label-free; 32 are test images, the 168 non-test counts are given too)'},
           'configs': {}}
    base_shipped = {'IMAGE_ONLY_BLOCK_SCORE': 80, 'IMAGE_BLOCK_SCORE': 76, 'IMAGE_BLOCK_SCORE_HORROR_PAGE': 65,
                    'IMAGE_BLOCK_SCORE_GENRE_LISTING': 41, 'IMAGE_VETO_SCORE': 40}
    for cid in cids:
        s, th = sc[cid], val['configs'][cid]['thresholds']
        vb = benefit_veto_line(s[fr.pos['hard:collision']], base_col)
        assert rate(s <= vb, fr.pos['hard:collision']) >= base_col - 1e-12
        ent = {'thresholdsD2': th, 'vetoBenefitMatched': veto_report(s, vb), 'vetoCostMatched': veto_report(s, th['T_veto'])}
        if cid == BASE_B:
            ent['vetoShipped40'] = veto_report(s, 40)
            ent['shippedConstants'] = base_shipped
            ent['genreListingShipped41'] = genre_report(s, 41)
            ent['flips'] = flips(cid, {**base_shipped, **{f'val:{k}': v for k, v in th.items() if k != 'T_veto_moody'},
                                       'val:T_veto_benefit': vb})
        else:
            prop, info = constants_for(th, vb)
            alt, alt_info = constants_for(th, th['T_veto'])
            ent['proposedConstants'] = prop
            ent['proposedConstantsInfo'] = info
            ent['alternativeCostMatchedVeto'] = {'constants': alt, 'info': alt_info,
                                                 'genreListing': genre_report(s, alt['IMAGE_BLOCK_SCORE_GENRE_LISTING'])}
            ent['genreListing'] = genre_report(s, prop['IMAGE_BLOCK_SCORE_GENRE_LISTING'])
            bars = {k: v for k, v in prop.items() if k != 'UNVERIFIED_BLOCK_SCORE'}
            bars['T_veto (cost-matched)'] = th['T_veto']
            if not info['genreListingCoupled'] or not alt_info['genreListingCoupled']:
                bars['GENRE_LISTING if cost-matched veto'] = alt['IMAGE_BLOCK_SCORE_GENRE_LISTING']
            ent['flips'] = flips(cid, bars)
        out['configs'][cid] = ent
        print(cid, 'benefit veto', vb, 'horror vetoed', round(ent['vetoBenefitMatched']['horrorVetoed'], 3),
              'moody vetoed', round(ent['vetoBenefitMatched']['moodyVetoed'], 3),
              'constants', ent.get('proposedConstants'), ent.get('proposedConstantsInfo', {}).get('genreRule'))
        print('   flips', {k: v['flipsAll200'] for k, v in ent['flips']['bars'].items()})
    PRETEST.write_text(json.dumps(out, indent=1) + '\n')
    print(f'wrote {PRETEST} in {time.time() - t0:.0f}s')


# ---------------------------------------------------------------- final test mode (phase F)

def main_final_test(models):
    """Scores TEST once for the named finalists + the MobileCLIP baseline. Same metric code.
    finalists.json decides the source: `sourceMode: browser` (phase D2, the shipping pipeline: browser
    WASM embeddings, val-results-browser.json) or the phase D Node configs (val-results.json)."""
    fin = json.loads((HERE / 'finalists.json').read_text())
    browser = fin.get('sourceMode') == 'browser'
    val = json.loads((CACHE / ('val-results-browser.json' if browser else 'val-results.json')).read_text())
    by_model = {f['model']: f for f in fin['finalists']}
    missing = [m for m in models if m not in by_model]
    if missing:
        sys.exit(f'--models must name finalists from finalists.json; not finalists: {missing}')
    if browser:
        cids = [by_model[m]['config'] for m in models]
        base_cid = fin['baseline']['config']
    else:
        cids = [cfg_id((by_model[m]['model'], by_model[m]['approach'], by_model[m]['dtype'])) for m in models]
        base_cid = cfg_id(BASE)
    if base_cid not in cids:
        cids.append(base_cid)

    rows = [r for r in load_manifest({'test'}) if r['split'] == 'test']
    ids = [r['id'] for r in rows]
    fr = Frame([1 if r['label'] == 'horror' else 0 for r in rows], [r['group'] for r in rows], [r['cluster'] for r in rows], ids)

    def score(cid):
        if browser:
            return browser_score(val['configs'][cid], ids)
        m, ap, dt = cid.split('|')
        if ap == 'zero-shot':
            return load_zs(m, dt, ids)
        trained_on = dt if ap == 'head' else 'fp32'
        return head_score(load_head(m, trained_on), load_emb(m, dt, ids))

    # Pre-test fixes (phase F step 1, decided on VAL, pretest.json): the proposed veto and genre-listing
    # bars join each finalist's threshold set; the baseline also gets its own benefit-matched line.
    pre = None
    if browser:
        if not PRETEST.exists():
            sys.exit('run --pretest (val only) before --final-test')
        pre = json.loads(PRETEST.read_text())
    def thresholds_of(cid):
        th = dict(val['configs'][cid]['thresholds'])   # val-picked, never re-picked on test
        if pre and cid in pre['configs']:
            pc = pre['configs'][cid]
            th['T_veto_benefit'] = pc['vetoBenefitMatched']['V']
            if 'proposedConstants' in pc:
                th['T_genre'] = pc['proposedConstants']['IMAGE_BLOCK_SCORE_GENRE_LISTING']
                alt = pc['alternativeCostMatchedVeto']['constants']['IMAGE_BLOCK_SCORE_GENRE_LISTING']
                if alt != round(th['T_veto'] + 1, 2):
                    th['T_genre_ifCostMatchedVeto'] = alt
        return th

    sc = {c: score(c) for c in cids}
    plans = boot_plan(fr)
    bfs = [fr.take(idx) for idx in plans]
    sb = sc[base_cid]
    th_b = thresholds_of(base_cid)
    base_fixed = [flat(point_metrics(sb[idx], bf, th_b, False)) for idx, bf in zip(plans, bfs)]
    SB = {'S80': 80, 'S76': 76, 'S65': 65, 'S41': 41}
    base_shipped_boot = [{**{f'{n}.{k}': v for n, T in SB.items() for k, v in block_metrics(sb[idx], T, bf).items() if k != 'T'},
                          **{f'S40.{k}': v for k, v in veto_metrics(sb[idx], 40, bf).items() if k != 'V'}}
                         for idx, bf in zip(plans, bfs)]
    out = {'generated': time.strftime('%Y-%m-%dT%H:%M:%S'), 'mode': 'FINAL TEST', 'sourceMode': 'browser' if browser else 'node',
           'models': models, 'counts': {'test': len(ids), 'testHorror': int(fr.y.sum()), 'testHardSafe': int(len(fr.pos['hard'])),
                                        'testEasySafe': int(len(fr.pos['easy'])), 'testMinimalist': int(len(fr.pos['horror:minimalist'])),
                                        'testMoody': int(len(fr.pos['horror:moody'])), 'testCollision': int(len(fr.pos['hard:collision'])),
                                        'perGroup': {g: int((fr.g == g).sum()) for g in sorted(set(fr.g))}},
           'pretest': 'eval/bakeoff/pretest.json' if pre else None, 'configs': {}}
    hs_b = sb[fr.pos['hard']]
    for cid in cids:
        s = sc[cid]
        th = thresholds_of(cid)
        pm = point_metrics(s, fr, th)
        bv = [flat(point_metrics(s[idx], bf, th, False)) for idx, bf in zip(plans, bfs)]
        pm['ci95'] = {k: ci([b[k] for b in bv]) for k in bv[0]}
        if cid == base_cid:
            pm['atShippedBars'] = {'IMAGE_ONLY_BLOCK_SCORE': block_metrics(s, 80, fr), 'IMAGE_BLOCK_SCORE': block_metrics(s, 76, fr),
                                   'IMAGE_BLOCK_SCORE_HORROR_PAGE': block_metrics(s, 65, fr),
                                   'IMAGE_BLOCK_SCORE_GENRE_LISTING': block_metrics(s, 41, fr), 'IMAGE_VETO_SCORE': veto_metrics(s, 40, fr)}
            pm['atShippedBarsCi95'] = {k: ci([b[k] for b in base_shipped_boot]) for k in base_shipped_boot[0]}
        else:
            # (a) at the val-picked T_only, and again at matched TEST hard-safe false-blur rates
            hs = s[fr.pos['hard']]
            matched = {}
            for name in ('T_only', 'T_page'):
                k_b = int((hs_b >= th_b[name]).sum())
                Tm = thr_count(hs, k_b)
                matched[name] = {'baselineHardFalseBlur': float((hs_b >= th_b[name]).mean()), 'baselineHardFalseBlurCount': k_b,
                                 'T_matched': Tm, **block_metrics(s, Tm, fr)}
            pm['atMatchedTestFalseBlur'] = matched
            margins = {'T_only.recall': -3.0, 'T_only.minimalistRecall': -5.0, 'T_page.minimalistRecall': -5.0}
            rule = {}
            for k, mg in margins.items():
                name, met = k.split('.')
                d = (pm['at'][name][met] - block_metrics(sb, th_b[name], fr)[met]) * 100
                lo, hi = ci([(b[k] - bb[k]) * 100 for b, bb in zip(bv, base_fixed)])
                rule[k] = {'deltaPts': d, 'marginPts': mg, 'pass': d >= mg, 'ci95Pts': [lo, hi],
                           'verdict': 'pass' if lo >= mg else ('fail' if hi < mg else 'inconclusive')}
            # matched rate: per resample, the candidate's bar is re-matched to the baseline's hard-safe
            # false-blur count at its (fixed, val-picked) T_only on that resample
            def matched_delta(idx, bf):
                hb = sb[idx][bf.pos['hard']]
                kb = int((hb >= th_b['T_only']).sum())
                Tm_ = thr_count(s[idx][bf.pos['hard']], kb)
                return (rate(s[idx] >= Tm_, bf.pos['horror']) - rate(sb[idx] >= th_b['T_only'], bf.pos['horror'])) * 100
            d_m = (matched['T_only']['recall'] - block_metrics(sb, th_b['T_only'], fr)['recall']) * 100
            lo_m, hi_m = ci([matched_delta(idx, bf) for idx, bf in zip(plans, bfs)])
            rule['recall@matchedTestFalseBlur'] = {'deltaPts': d_m, 'marginPts': -3.0, 'pass': d_m >= -3.0, 'ci95Pts': [lo_m, hi_m],
                                                   'verdict': 'pass' if lo_m >= -3 else ('fail' if hi_m < -3 else 'inconclusive')}
            rule['a'] = rule['T_only.recall']['pass'] and rule['recall@matchedTestFalseBlur']['pass']
            rule['b'] = rule['T_only.minimalistRecall']['pass'] and rule['T_page.minimalistRecall']['pass']
            rule['pass'] = rule['a'] and rule['b']
            rule['anyInconclusive'] = any(rule[k]['verdict'] == 'inconclusive' for k in list(margins) + ['recall@matchedTestFalseBlur'])
            pm['decisionRule'] = rule
            if browser:   # informative: against what users get today (the baseline at its shipped bars)
                sh = {'recall@T_only vs baseline@80': (pm['at']['T_only']['recall'], block_metrics(sb, 80, fr)['recall']),
                      'minimalist@T_only vs baseline@80': (pm['at']['T_only']['minimalistRecall'], block_metrics(sb, 80, fr)['minimalistRecall']),
                      'minimalist@T_page vs baseline@65': (pm['at']['T_page']['minimalistRecall'], block_metrics(sb, 65, fr)['minimalistRecall'])}
                pm['vsBaselineShippedBars'] = {k: {'deltaPts': (a - b) * 100, 'candidate': a, 'baseline': b} for k, (a, b) in sh.items()}
        # worst examples per group: lowest-scoring horror, highest-scoring safe
        worst = {}
        for grp in sorted(set(fr.g)):
            p = np.flatnonzero(fr.g == grp)
            is_h = fr.y[p[0]] == 1
            order = p[np.argsort(s[p])] if is_h else p[np.argsort(-s[p])]
            worst[grp] = [{'id': ids[i], 'score': float(s[i])} for i in order[:5]]
        pm['worstExamples'] = worst
        out['configs'][cid] = {'thresholds': th, 'test': pm}
    name = 'test-results-browser.json' if browser else 'test-results.json'
    (OUT_DIR / name).write_text(json.dumps(out, indent=1))
    with open(OUT_DIR / 'test-runs.log', 'a') as f:
        f.write(f'{out["generated"]} final test ({out["sourceMode"]}): {", ".join(cids)}\n')
    print(f'wrote {OUT_DIR / name}')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--final-test', action='store_true', help='phase F only: score the TEST split once')
    ap.add_argument('--pretest', action='store_true', help='phase F, VAL only: veto line, ml-bridge constants, backend flips')
    ap.add_argument('--models', default='', help='comma-separated finalist model names (with --final-test)')
    ap.add_argument('--source', choices=['node', 'browser'], default='node',
                    help='node: phase D (Node embeddings); browser: phase D2 (in-browser embeddings, the shipping pipeline)')
    a = ap.parse_args()
    if a.pretest:
        main_pretest()
    elif a.final_test:
        # The source comes from finalists.json (sourceMode); --source, if given, must agree with it.
        mode = json.loads((HERE / 'finalists.json').read_text()).get('sourceMode', 'node')
        if '--source' in sys.argv and a.source != mode:
            sys.exit(f'--source {a.source} does not match finalists.json sourceMode {mode}')
        ms = [m for m in a.models.split(',') if m]
        if not ms:
            sys.exit('--final-test needs --models <a,b,...>')
        main_final_test(ms)
    else:
        if a.models:
            sys.exit('--models is only valid with --final-test')
        main_browser() if a.source == 'browser' else main_default()
