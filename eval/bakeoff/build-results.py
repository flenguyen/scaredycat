#!/usr/bin/env python3
"""Phase F: gather the bake-off's raw numbers into eval/bakeoff/results.json.

  eval/bakeoff/.cache/venv/bin/python eval/bakeoff/build-results.py

Reads (no recomputation, nothing re-picked): candidates.json, model-files.json, finalists*.json,
pretest.json and, from .cache/, val-results.json (Node phase D), val-results-browser.json (browser D2),
test-results-browser.json (the single test run), test-auc-paired.json, timing.json,
browser-embed-summary.json (E2) and browser-results.json (E).
"""
import json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = HERE / '.cache'
sys.path.insert(0, str(HERE))
import analyze as A  # noqa: E402

rd = lambda p: json.loads(Path(p).read_text())


def node_phase_d():
    v = rd(CACHE / 'val-results.json')
    keep_ci = ('auc', 'prAuc', 'T_only.recall', 'T_only.hardFalseBlur', 'T_only.minimalistRecall', 'T_page.recall',
               'T_page.hardFalseBlur', 'T_page.minimalistRecall')
    cfgs = {}
    for cid, r in v['configs'].items():
        val = r['val']
        cfgs[cid] = {'model': r['model'], 'approach': r['approach'], 'dtype': r['dtype'], 'role': r['role'], 'head': r['head'],
                     'thresholds': r['thresholds'], 'ranking': val['ranking'], 'at': val['at'],
                     'ci95': {k: val['ci95'][k] for k in keep_ci if k in val['ci95']},
                     'atShippedBars': val.get('atShippedBars'),
                     'decisionRuleVsBaselineVal': {k: val['decisionRuleVsBaseline'][k] for k in ('a', 'b', 'provisionalPass', 'anyInconclusive')},
                     'precisionVsFp32': r['precision'], 'size': r['size'], 'params': r['params'], 'nodeTiming': r['nodeTiming'],
                     'eligible': r['eligible'], 'ineligibleReasons': r['ineligibleReasons'], 'flags': r['flags']}
    return {'generated': v['generated'], 'mode': v['mode'], 'counts': v['counts'], 'settings': v['settings'],
            'baselineReference': v['baselineReference'], 'integrity': v['integrity'],
            'heads': {k: {kk: vv for kk, vv in h.items() if kk != 'grid'} for k, h in v['heads'].items()},
            'configs': cfgs, 'precisionSummary': v['precisionSummary'], 'leaderboardEligible': v['leaderboardEligible'],
            'finalists': v['finalists'], 'finalistsFile': rd(HERE / 'finalists.node.json'), 'notes': v['notes']}


def browser_d2():
    v = rd(CACHE / 'val-results-browser.json')
    cfgs = {}
    for cid, r in v['configs'].items():
        cfgs[cid] = {k: r[k] for k in ('model', 'approach', 'dtype', 'view', 'source', 'head', 'promptVariant', 'role', 'thresholds',
                                       'parity', 'precision', 'robustness', 'size', 'packZipMB', 'wasmMsP50', 'webgpuMsP50',
                                       'eligible', 'ineligibleReasons', 'flags')}
        cfgs[cid]['val'] = r['val']
    return {'generated': v['generated'], 'mode': v['mode'], 'counts': v['counts'], 'settings': v['settings'],
            'baselineReference': v['baselineReference'],
            'heads': {k: {kk: vv for kk, vv in h.items() if kk != 'grid'} for k, h in v['heads'].items()},
            'configs': cfgs, 'excluded': v['excluded'], 'leaderboardEligible': v['leaderboardEligible'],
            'finalists': v['finalists'], 'finalistsFile': rd(HERE / 'finalists.json'), 'notes': v['notes']}


def main():
    br = rd(CACHE / 'browser-results.json')
    e2 = rd(CACHE / 'browser-embed-summary.json')
    test = rd(CACHE / 'test-results-browser.json')
    lat = lambda rows: [{k: r.get(k) for k in ('page', 'label', 'firstVerdictMs', 'lastVerdictMs', 'classifyRequests', 'blurs')}
                        | {'swLatP50': r['sw']['latP50'], 'swLatP95': r['sw']['latP95']} for r in rows]
    d2 = browser_d2()
    out = {
        'generated': test['generated'],
        'about': 'Raw numbers for eval/bakeoff/REPORT.md. Scores are 0-100; block = score >= T, veto = score <= V. '
                 'Rates are fractions. "browser" = Chrome for Testing, the extension\'s real decode, fp16, WASM unless marked.',
        'licences': [{k: c.get(k) for k in ('name', 'hfId', 'revision', 'licence', 'licenceQuote', 'licenceUrls', 'commercialOk',
                                            'caveats', 'role')} for c in rd(HERE / 'candidates.json')],
        'userDecisions': {'sizeCapMB': 85, 'sizeCapNote': 'raised from 50 MB to about 85 MB for the shipped fp16 vision file (2026-10-05)',
                          'rejectedLicences': ['tinyclip-resnet-19m-laion400m', 'tinyclip-vit-45m-32-auto-laionyfcc400m'],
                          'q8': 'never a shipping dtype'},
        'nodePhaseD': node_phase_d(),
        'browserPhaseD2Val': d2,
        'preTestFixes': rd(HERE / 'pretest.json'),
        'test': {**test, 'pairedAucVsBaseline': rd(CACHE / 'test-auc-paired.json')},
        'timing': {'nodeCpu1Thread': rd(CACHE / 'timing.json'),
                   'browserE2': {k: {kk: s[kk] for kk in ('wasmMsP50', 'wasmMsP95', 'webgpuMsP50', 'loadMsWasm')} for k, s in e2.items()},
                   'browserLatencyPhaseE': {'note': 'eval/browser-latency.mjs, one round, default backend (WebGPU); first/last verdict ms per page',
                                            'baseline': lat(br.get('baselineLatencyResults') or []),
                                            **{k: lat(c.get('latencyResults') or []) for k, c in br['candidates'].items()}},
                   'browserPerImagePhaseE': {k: {dev: c['real'][dev]['perImageMsP50'] for dev in ('wasm', 'webgpu')} for k, c in br['candidates'].items()}},
        'sizes': {'visionFiles': A.sizes(), 'packZipMB': {'mobileclip-s0 (shipped today)': br['baselinePackZipMB'],
                                                         **{k: c['packZipMB'] for k, c in br['candidates'].items()}},
                  'packZipNote': 'node scripts/pack.mjs --check in a throwaway worktree with the candidate in models/ (phase E)'},
        'parity': {'wasmVsWebgpuScoresD2': {cid: c['parity'] for cid, c in d2['configs'].items() if c['parity']},
                   'embeddingCosineE2': {k: {kk: s[kk] for kk in ('wasmVsWebgpuCos', 'browserWasmVsNodeCos', 'browserWebgpuVsNodeCos')} for k, s in e2.items()},
                   'mobileclipNodeVsBrowserZeroShot': {k: e2['mobileclip-s0/crop'][k] for k in ('zeroShotMaxAbsDelta', 'zeroShotMeanAbsDelta',
                                                                                                  'zeroShotCompared', 'zeroShotOver2', 'zeroShotMaxAbsDeltaWebgpuSubset')},
                   'phaseENodeVsBrowser': {k: {mode: {dev: {kk: c[mode][dev][kk] for kk in ('maxAbsDelta', 'p95AbsDelta', 'minCosine')}
                                                      for dev in ('wasm', 'webgpu')} for mode in ('real', 'nodePixels')}
                                           for k, c in br['candidates'].items()},
                   'phaseEMobileclipHeadRealDecode': {dev: {kk: br['baselineMobileCLIPHeadRealDecode'][dev][kk] for kk in ('maxAbsDelta', 'p95AbsDelta', 'minCosine')}
                                                      for dev in ('wasm', 'webgpu')},
                   'verdictFlipsAtBars': {cid: c['flips'] for cid, c in rd(HERE / 'pretest.json')['configs'].items()}},
        'robustness': {cid: c['robustness'] for cid, c in d2['configs'].items() if c['robustness']},
    }
    (HERE / 'results.json').write_text(json.dumps(out, indent=1) + '\n')
    print(f'wrote {HERE / "results.json"} ({(HERE / "results.json").stat().st_size / 1e3:.0f} kB)')


if __name__ == '__main__':
    main()
