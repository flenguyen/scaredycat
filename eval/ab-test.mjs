import { classifyImageFile } from './image-classifier.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function wikiThumb(article) {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(article)}`,
      { headers: { 'User-Agent': 'scaredycat-eval/1.0 (contact: dev@local)' } });
    if (res.ok) { const j = await res.json(); return j.thumbnail?.source || null; }
    await sleep(3000);
  }
  return null;
}

const tests = [
  ['horror', 'The Exorcist'], ['horror', 'Halloween (1978 film)'], ['horror', "Frankenstein's monster"],
  ['safe', 'Golden Retriever'], ['safe', 'Pizza'], ['safe', 'Eiffel Tower'], ['safe', 'Basketball'],
  ['safe', 'Laptop'], ['safe', 'Wedding'], ['safe', 'Paddington (film)'], ['safe', 'The Notebook'],
  ['safe', 'Halloween'], ['safe', 'Pumpkin'], ['safe', 'Taylor Swift'], ['safe', 'Barack Obama']
];

for (const [label, article] of tests) {
  await sleep(1500);
  const url = await wikiThumb(article);
  if (!url) { console.log(label.padEnd(7), article.padEnd(28), 'no thumbnail'); continue; }
  try {
    const score = await classifyImageFile(url);
    console.log(label.padEnd(7), article.padEnd(28), score.toFixed(1).padStart(6));
  } catch (e) { await sleep(3000);
    try { const score = await classifyImageFile(url); console.log(label.padEnd(7), article.padEnd(28), score.toFixed(1).padStart(6)); }
    catch (e2) { console.log(label.padEnd(7), article.padEnd(28), 'ERR'); }
  }
}
process.exit(0);
