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

const cases = [
  { q: "mal paylaşımı", expect: "yasa-1-1998", ref: "Madde 26" },
  { q: "mal paylaşımında eşlere düşen en az oran", expect: "yasa-1-1998", ref: "Madde 26" },
  { q: "boşanmada mal paylaşımı", expect: "yasa-1-1998", ref: "Madde 26" },
  { q: "nafaka", expect: "yasa-1-1998" },
  { q: "iştirak nafakası", expect: "yasa-1-1998" },
  { q: "velayet", expect: "yasa-1-1998" },
  { q: "boşanma", expect: "yasa-1-1998" },
  { q: "kira", expect: "yasa-17-1981" },
  { q: "kira denetimi", expect: "yasa-17-1981" },
  { q: "ecrimisil", expect: "yasa-17-1981" },
  { q: "kıdem tazminatı", expect: "yasa-22-1992" },
  { q: "ihbar tazminatı", expect: "yasa-22-1992" },
  { q: "fazla mesai", expect: "yasa-22-1992" },
  { q: "iş kazası", expect: "yasa-22-1992" },
  { q: "miras", expect: "yasa-fasil-195" },
  { q: "saklı pay", expect: "yasa-fasil-195" },
  { q: "tenkis", expect: "yasa-fasil-195" },
  { q: "maddi tazminat", expect: "yasa-fasil-148" },
  { q: "manevi tazminat", expect: "yasa-fasil-148" },
  { q: "destekten yoksun kalma", expect: "yasa-fasil-148" },
  { q: "gelir vergisi", expect: "yasa-24-1982" },
  { q: "KDV", expect: "yasa-47-1992" },
  { q: "vergi cezası", expect: "yasa-27-1977" },
  { q: "sosyal sigorta", expect: "yasa-16-1976" },
  { q: "emeklilik", expect: "yasa-16-1976" },
  { q: "disiplin", expect: "yasa-7-1979" },
  { q: "kamu görevlisi", expect: "yasa-7-1979" },
  { q: "idari işlem", expect: "yasa-27-2013" },
  { q: "ceza", expect: "yasa-fasil-154" },
  { q: "tutuklama", expect: "yasa-fasil-155" },
  { q: "sigorta", expect: "yasa-60-2010" },
  { q: "trafik kazası", expect: "yasa-60-2010" },
  { q: "kat mülkiyeti", expect: "yasa-35-2010" },
  { q: "aidat", expect: "yasa-35-2010" },
  { q: "imar", expect: "yasa-55-1989" },
  { q: "çevre", expect: "yasa-18-2012" },
  { q: "kamu ihalesi", expect: "yasa-20-2016" },
];

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
