// First-stage retrieval measurement (OPUS-GOREVLER-5 item 1). No Clef call:
// for every answerable question, /admin/retrieve returns the candidate
// documents (fused lexical + vector), the lexical-only order, the vector hits
// and the article order inside the expected statute. Reported: how often the
// right statute / article is within reach of each stage.
//
//   BASE=https://... ADMIN_TOKEN=... node scripts/eval-retrieval.mjs
//
// Env:
//   VARIANTS  comma list of /admin/retrieve query strings (default "": live settings);
//             "category=auto" derives the category from the expected statute.
//   SETS      questions, holdout (default questions)
//   OUT       JSON report path (default eval-retrieval.json)
//
// Cheap to run (D1 rows and one embedding per question); run it after every
// retrieval change, before any measurement that spends Clef.

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const base = (process.env.BASE ?? "http://localhost:8787").replace(/\/$/, "");
const token = process.env.ADMIN_TOKEN;
if (!token) throw new Error("ADMIN_TOKEN is required (/admin/retrieve)");
const variants = (process.env.VARIANTS ?? "").split(",").map((v) => v.trim());
const sets = (process.env.SETS ?? "questions").split(",").map((s) => s.trim());
const outPath = process.env.OUT ?? "eval-retrieval.json";

const load = (name) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8")).cases;
let cases = [];
if (sets.includes("questions")) cases.push(...load("eval-questions.json"));
if (sets.includes("holdout")) cases.push(...load("eval-holdout.json"));
cases = cases.filter((c) => c.expect && !c.unanswerable);

const canon = (id) => (id ?? "").replace(/(?<![0-9])0+(?=[0-9])/g, "");
const answers = (c) => [c, ...(c.alt ?? [])];
const acceptable = (a) => a.refs ?? (a.ref ? [a.ref] : []);
const sameArticle = (ref, expected) => ref === expected || (ref ?? "").startsWith(`${expected} `) || (ref ?? "").startsWith(`${expected}(`);
const isDoc = (id, c) => answers(c).some((a) => canon(id) === canon(a.expect));
const isArticle = (id, ref, c) =>
  answers(c).some((a) => canon(id) === canon(a.expect) && (acceptable(a).length === 0 || acceptable(a).some((r) => sameArticle(ref, r))));
const rank = (list, pred) => {
  const i = list.findIndex(pred);
  return i < 0 ? null : i + 1;
};

const auth = { authorization: `Bearer ${token}` };
const docCategories = new Map();
async function categoryOf(c) {
  if (!docCategories.has(c.expect)) {
    const body = await (await fetch(`${base}/v1/categories?document_id=${encodeURIComponent(c.expect)}`)).json();
    docCategories.set(c.expect, body.categories ?? []);
  }
  return docCategories.get(c.expect)[0] ?? null;
}

async function retrieve(c, variant) {
  let query = variant;
  if (/(?:^|&)category=auto(?=&|$)/.test(query)) {
    const cat = await categoryOf(c);
    query = query.replace(/(^|&)category=auto(?=&|$)/, cat ? `$1category=${cat}` : "");
  }
  const url = `${base}/admin/retrieve?q=${encodeURIComponent(c.q)}&doc=${encodeURIComponent(c.expect)}${query ? `&${query}` : ""}`;
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { headers: auth });
    if (response.ok) return response.json();
    if (attempt >= 2 || response.status < 500) throw new Error(`HTTP ${response.status}`);
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
}

const STAGE1_DOCS = 4; // ceil(RERANK_CANDIDATES / passages) = ceil(10 / 3)
const FOCUS = 12; // articles of the chosen statute in the focus step

const rows = [];
for (const [n, c] of cases.entries()) {
  const row = { q: c.q, expect: c.expect, refs: acceptable(c), variants: {} };
  const marks = [];
  for (const variant of variants) {
    try {
      const r = await retrieve(c, variant);
      const docRank = rank(r.docs, (d) => isDoc(d.id, c));
      const lexRank = rank(r.lexical_docs, (id) => isDoc(id, c));
      const semDocs = [...new Set(r.semantic.map((h) => h.doc_id))];
      const semDocRank = rank(semDocs, (id) => isDoc(id, c));
      const semArtRank = rank(r.semantic, (h) => isArticle(h.doc_id, h.ref, c));
      const stage1Article = r.docs.slice(0, STAGE1_DOCS).some((d) => d.refs.some((ref) => isArticle(d.id, ref, c)));
      const lawRank = rank(r.law_articles ?? [], (ref) => isArticle(c.expect, ref, c));
      const result = {
        doc_rank: docRank,
        lexical_doc_rank: lexRank,
        semantic_doc_rank: semDocRank,
        semantic_article_rank: semArtRank,
        stage1_article: stage1Article,
        law_article_rank: lawRank,
        // Within reach of Clef: the statute is among the stage-1 documents and the
        // article is either shown there or in the statute's focus list.
        pool: !!docRank && docRank <= STAGE1_DOCS && (stage1Article || (!!lawRank && lawRank <= FOCUS)),
        rewrite_named: r.rewrite ? r.rewrite.documents.some((id) => isDoc(id, c)) : null,
      };
      row.variants[variant] = result;
      marks.push(result.pool ? "P" : docRank && docRank <= 10 ? "d" : "·");
    } catch (error) {
      row.variants[variant] = { error: error.message };
      marks.push("x");
    }
  }
  rows.push(row);
  console.log(`${String(n + 1).padStart(3)} ${marks.join("")}  ${c.q}`);
}

const within = (x, k) => x !== null && x !== undefined && x <= k;
const md = ["## İlk aşama getirme ölçümü (Clef yok)", "", `Sorular: ${rows.length} (cevaplı). Varyant boşsa canlı ayarlar.`, ""];
md.push(
  "| Varyant | Clef'in erişiminde | yasa @1 | yasa @4 | yasa @10 | yasa @30 | yalnız FTS: yasa @10 | vektör: yasa @10 | vektör: madde @10 | @30 | @50 | yasa verilince madde @12 | yeniden yazım yasayı adlandırdı |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
);
const summary = {};
for (const variant of variants) {
  const v = rows.map((r) => r.variants[variant]).filter((x) => x && !x.error);
  const count = (f) => v.filter(f).length;
  const s = {
    n: v.length,
    pool: count((x) => x.pool),
    doc1: count((x) => within(x.doc_rank, 1)),
    doc4: count((x) => within(x.doc_rank, 4)),
    doc10: count((x) => within(x.doc_rank, 10)),
    doc30: count((x) => within(x.doc_rank, 30)),
    lex10: count((x) => within(x.lexical_doc_rank, 10)),
    semdoc10: count((x) => within(x.semantic_doc_rank, 10)),
    sem10: count((x) => within(x.semantic_article_rank, 10)),
    sem30: count((x) => within(x.semantic_article_rank, 30)),
    sem50: count((x) => within(x.semantic_article_rank, 50)),
    law12: count((x) => within(x.law_article_rank, 12)),
    rewrite: count((x) => x.rewrite_named === true),
    only_lex: count((x) => within(x.lexical_doc_rank, 10) && !within(x.semantic_doc_rank, 10)),
    only_sem: count((x) => !within(x.lexical_doc_rank, 10) && within(x.semantic_doc_rank, 10)),
  };
  summary[variant] = s;
  md.push(
    `| ${variant || "(canlı)"} | **${s.pool}/${s.n}** | ${s.doc1} | ${s.doc4} | ${s.doc10} | ${s.doc30} | ${s.lex10} | ${s.semdoc10} | ${s.sem10} | ${s.sem30} | ${s.sem50} | ${s.law12} | ${s.rewrite} |`,
  );
}
md.push("", "| Varyant | yasayı yalnız FTS buldu (@10) | yalnız vektör buldu (@10) |", "|---|---|---|");
for (const variant of variants) md.push(`| ${variant || "(canlı)"} | ${summary[variant].only_lex} | ${summary[variant].only_sem} |`);

// Misses of the first variant: where the statute stood in each channel.
const first = variants[0];
md.push("", `### Clef'in erişiminde olmayanlar (${first || "canlı"})`, "", "| Soru | Beklenen | yasa sırası | FTS | vektör (yasa / madde) | yasa içinde madde |", "|---|---|---|---|---|---|");
for (const r of rows) {
  const v = r.variants[first];
  if (!v || v.error || v.pool) continue;
  const f = (x) => (x === null || x === undefined ? "–" : String(x));
  md.push(`| ${r.q} | ${r.expect} ${r.refs.join("/")} | ${f(v.doc_rank)} | ${f(v.lexical_doc_rank)} | ${f(v.semantic_doc_rank)} / ${f(v.semantic_article_rank)} | ${f(v.law_article_rank)} |`);
}

writeFileSync(outPath, JSON.stringify({ base, generated_at: new Date().toISOString(), variants, summary, rows }, null, 1));
const text = md.join("\n");
console.log("\n" + text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
