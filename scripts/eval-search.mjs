// Search quality evaluation for the KKTC legal API.
//
//   BASE=http://localhost:8787 node scripts/eval-search.mjs
//   BASE=https://... MIN_RECALL=0.8 node scripts/eval-search.mjs
//
// Each case is a real user question and the statute/article a lawyer would
// expect. The script reports hit@1, recall@5, MRR and article@5, and exits
// non-zero when the thresholds are missed.

const base = (process.env.BASE ?? "http://localhost:8787").replace(/\/$/, "");
const minRecall = Number(process.env.MIN_RECALL ?? 0.75);
const minMrr = Number(process.env.MIN_MRR ?? 0.55);
const minHit1 = Number(process.env.MIN_HIT1 ?? 0.55);
const minArticle = Number(process.env.MIN_ARTICLE ?? 0.8);

import { readFileSync } from "node:fs";

const { cases } = JSON.parse(readFileSync(new URL("./eval-keywords.json", import.meta.url), "utf8"));

let hit1 = 0;
let recall5 = 0;
let reciprocalRank = 0;
let articleHits = 0;
let articleCases = 0;
const failures = [];

for (const item of cases) {
  const url = `${base}/v1/search?q=${encodeURIComponent(item.q)}&limit=5`;
  let data;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
  } catch (error) {
    failures.push(`${item.q}: ${error.message}`);
    console.error(`ERR  ${item.q} -> ${error.message}`);
    continue;
  }

  const rank = data.results.findIndex((result) => result.id === item.expect) + 1;
  if (rank === 1) hit1 += 1;
  if (rank > 0) {
    recall5 += 1;
    reciprocalRank += 1 / rank;
  }

  let articleOk = true;
  if (item.ref) {
    articleCases += 1;
    articleOk = data.results.some(
      (result) =>
        result.id === item.expect && (result.matched_ref ?? "").startsWith(item.ref),
    );
    if (articleOk) articleHits += 1;
  }

  const ok = rank > 0 && articleOk;
  if (!ok) {
    const got = data.results
      .slice(0, 3)
      .map((result) => `${result.id}:${result.matched_ref ?? "-"}`)
      .join(", ");
    failures.push(`${item.q} -> expected ${item.expect}${item.ref ? `/${item.ref}` : ""}; got ${got}`);
  }
  console.log(
    `${ok ? "ok  " : "FAIL"} ${String(rank || "-").padStart(2)}  ${item.q}  -> ${item.expect}${item.ref ? ` ${item.ref}` : ""}`,
  );
}

const total = cases.length;
const recall = recall5 / total;
const mrr = reciprocalRank / total;
const first = hit1 / total;
const article = articleCases ? articleHits / articleCases : 1;

console.log("\nSonuçlar");
console.log(`  hit@1      ${(first * 100).toFixed(1)}%  (${hit1}/${total})`);
console.log(`  recall@5   ${(recall * 100).toFixed(1)}%  (${recall5}/${total})`);
console.log(`  MRR        ${mrr.toFixed(3)}`);
console.log(`  article@5  ${(article * 100).toFixed(1)}%  (${articleHits}/${articleCases})`);
if (failures.length) {
  console.log("\nBaşarısızlar");
  for (const failure of failures) console.log(`  - ${failure}`);
}

const failed =
  recall < minRecall || mrr < minMrr || first < minHit1 || article < minArticle;
if (failed) {
  console.error(
    `\nEşik altı: recall@5 >= ${minRecall}, MRR >= ${minMrr}, hit@1 >= ${minHit1}, article@5 >= ${minArticle}`,
  );
  process.exitCode = 1;
} else {
  console.log("\nArama kalite eşikleri geçti.");
}
