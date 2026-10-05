/**
 * Bake-off model fetch: pinned-revision downloads into
 * eval/.model-cache/bakeoff/<name>/ with sha256 recording/checking.
 *
 *   node eval/bakeoff/fetch-models.mjs [name ...] [--list]
 *
 * Reads eval/bakeoff/candidates.json (array of {name, hfId, revision, role,
 * approach, files?}). Only roles candidate/reference/baseline are fetched.
 * First run records every file's sha256 in eval/bakeoff/model-files.json;
 * later runs verify against it. Idempotent. `files` in a candidate overrides
 * the automatic file selection (config/tokenizer/preprocessor files plus ONE
 * weight format; onnx/*.onnx only for repos that ship ONNX).
 * MobileCLIP (baseline) is already in eval/.model-cache/Xenova/mobileclip_s0
 * and is copied from there when its sha256 matches setup-model.mjs's pins.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(path.dirname(HERE));
const CACHE = path.join(ROOT, 'eval', '.model-cache', 'bakeoff');
const CANDIDATES = path.join(HERE, 'candidates.json');
const LOCKFILE = path.join(HERE, 'model-files.json');
const FETCH_ROLES = new Set(['candidate', 'reference', 'baseline']);
const SMALL = /(^|\/)(config|preprocessor_config|tokenizer|tokenizer_config|special_tokens_map|generation_config|open_clip_config|vocab|merges)\.(json|txt)$|(^|\/)(vocab|merges)\.(json|txt)$|\.tiktoken$/;
const WEIGHT_PREF = [/^model\.safetensors$/, /^open_clip_model\.safetensors$/, /^open_clip_pytorch_model\.bin$/, /^pytorch_model\.bin$/, /^[^/]*\.safetensors$/, /^[^/]*\.(bin|pt|pth)$/];

const sha256Buf = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const readLock = () => (fs.existsSync(LOCKFILE) ? JSON.parse(fs.readFileSync(LOCKFILE, 'utf8')) : {});

async function listFiles(c) {
  if (c.files) return c.files;
  const res = await fetch(`https://huggingface.co/api/models/${c.hfId}/tree/${c.revision}?recursive=true`);
  if (!res.ok) throw new Error(`${c.name}: tree listing HTTP ${res.status}`);
  const paths = (await res.json()).filter((e) => e.type === 'file').map((e) => e.path);
  const out = paths.filter((p) => SMALL.test(p));
  const weight = WEIGHT_PREF.map((re) => paths.find((p) => re.test(p))).find(Boolean);
  if (weight) out.push(weight);
  if (/onnx/i.test(c.hfId)) out.push(...paths.filter((p) => /^onnx\/.*\.onnx$/.test(p)));
  return [...new Set(out)];
}

async function fetchCandidate(c, lock) {
  const dir = path.join(CACHE, c.name, 'src');
  const entry = (lock[c.name] ||= { hfId: c.hfId, revision: c.revision, files: {} });
  if (entry.revision !== c.revision || entry.hfId !== c.hfId) throw new Error(`${c.name}: candidates.json revision/id changed from model-files.json; resolve by hand`);
  const files = entry.listed || await listFiles(c);
  entry.listed = files;
  for (const file of files) {
    const dest = path.join(dir, file);
    const want = entry.files[file];
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      const got = sha256File(dest);
      if (want && got !== want) throw new Error(`${c.name}/${file}: cached sha256 ${got} != recorded ${want}; delete it and rerun`);
      if (!want) entry.files[file] = got;
      console.log(`ok  ${c.name}/${file} (cached${want ? ', sha256 ok' : ', sha256 recorded'})`);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    process.stdout.write(`get ${c.name}/${file} ... `);
    let buf;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(`https://huggingface.co/${c.hfId}/resolve/${c.revision}/${file}`, { signal: AbortSignal.timeout(1200000) });
        if (!res.ok) throw new Error(`${c.name}/${file}: HTTP ${res.status}`);
        buf = Buffer.from(await res.arrayBuffer());
        break;
      } catch (e) {
        if (attempt >= 5 || /HTTP 4/.test(String(e.message))) throw e;
        process.stdout.write(`retry ${attempt} (${e.cause?.code || e.message}) ... `);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    const got = sha256Buf(buf);
    if (want && got !== want) throw new Error(`${c.name}/${file}: downloaded sha256 ${got} != recorded ${want}; nothing written`);
    fs.writeFileSync(dest + '.part', buf);
    fs.renameSync(dest + '.part', dest);
    entry.files[file] = got;
    console.log(`${(buf.length / 1e6).toFixed(1)}MB ${want ? 'sha256 ok' : 'sha256 recorded'}`);
  }
  fs.writeFileSync(LOCKFILE, JSON.stringify(lock, null, 2) + '\n'); // after each model: a crash loses at most one
}

const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith('--'));
const LOCAL_BASELINE = new Set(['mobileclip-s0']); // already in eval/.model-cache/Xenova/mobileclip_s0
const cands = JSON.parse(fs.readFileSync(CANDIDATES, 'utf8'))
  .filter((c) => FETCH_ROLES.has(c.role) && !LOCAL_BASELINE.has(c.name) && (!only.length || only.includes(c.name)));
if (args.includes('--list')) { for (const c of cands) console.log(c.name, c.hfId, c.revision, c.role, c.approach); process.exit(0); }
const lock = readLock();
for (const c of cands) {
  if (!c.revision || /^(main|master)$/.test(c.revision)) throw new Error(`${c.name}: revision must be a pinned commit sha`);
  await fetchCandidate(c, lock);
}
console.log(`fetch-models done (${cands.length} models)`);
process.exit(0);
