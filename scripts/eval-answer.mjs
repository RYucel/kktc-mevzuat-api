// End-to-end measurement of /v1/answer (what users and the MCP `sor` tool get).
//
//   BASE=https://... node scripts/eval-answer.mjs
//
// Env:
//   VARIANTS  comma list of query-string variants, each compared on the same
//             questions (default "rerank=0,passages=1,passages=2,passages=3")
//   SETS      questions, keywords (default "questions")
//   OUT       JSON report path (default eval-answer.json)
//
// For each question the top quote is checked against the expected statute
// and article. Reported per variant: doc@1, article@1, article@5 (among the
// five quotes), and how often each confidence label was right, which is what
// tells a reader whether to trust "high".
//
// Case fields: q, expect (document id), ref ("Madde 7") or refs (several
// acceptable articles), or unanswerable: true for questions no KKTC statute
// answers (right when the API says confidence "low").
//
// Diagnosis (debug=1): for every miss, was the right article among the
// passages Clef saw? "not retrieved" points at search, "not chosen" at the
// reranker.

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const base = (process.env.BASE ?? "http://localhost:8787").replace(/\/$/, "");
// Our own jobs send the admin token, so the Worker's per-client rate limit
// (30 requests a minute) does not apply to them.
if (process.env.ADMIN_TOKEN) {
  const plainFetch = globalThis.fetch;
  globalThis.fetch = (url, init = {}) =>
    plainFetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${process.env.ADMIN_TOKEN}` } });
}
const variants = (process.env.VARIANTS ?? "rerank=0,passages=1,passages=2,passages=3").split(",").map((v) => v.trim()).filter(Boolean);
const sets = (process.env.SETS ?? "questions").split(",").map((s) => s.trim());
const outPath = process.env.OUT ?? "eval-answer.json";

const load = (name) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8")).cases;
let cases = [];
if (sets.includes("questions")) cases.push(...load("eval-questions.json").map((c) => ({ ...c, set: "questions" })));
if (sets.includes("keywords")) cases.push(...load("eval-keywords.json").map((c) => ({ ...c, set: "keywords" })));
const seen = new Set();
cases = cases.filter((c) => (seen.has(c.q) ? false : seen.add(c.q)));

const isDoc = (quote, c) => !!c.expect && quote?.document_id === c.expect;
// "Madde 3" must not match "Madde 30"; a part suffix ("Madde 3 (2/2)") is fine.
const sameArticle = (ref, expected) => ref === expected || (ref ?? "").startsWith(`${expected} `);
const acceptable = (c) => c.refs ?? (c.ref ? [c.ref] : []);
const isArticle = (quote, c) =>
  isDoc(quote, c) && (acceptable(c).length === 0 || acceptable(c).some((ref) => sameArticle(quote.ref, ref)));

async function answer(q, variant) {
  const url = `${base}/v1/answer?q=${encodeURIComponent(q)}&limit=5&debug=1&${variant}`;
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    const response = await fetch(url);
    if (response.ok) {
      const rows = response.headers.get("x-d1-rows-read");
      return { body: await response.json(), ms: Date.now() - started, rowsRead: rows === null ? null : Number(rows) };
    }
    if (attempt >= 2 || response.status < 500) throw new Error(`HTTP ${response.status}`);
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
}

const rows = [];
for (const [n, c] of cases.entries()) {
  const row = { q: c.q, set: c.set, expect: c.expect ?? null, refs: acceptable(c), unanswerable: !!c.unanswerable, variants: {} };
  const marks = [];
  for (const variant of variants) {
    try {
      const { body, ms, rowsRead } = await answer(c.q, variant);
      const quotes = body.quotes ?? [];
      const top = quotes[0];
      const seenByClef = body.rerank?.debug_candidates ?? null;
      const result = {
        ms,
        rows_read: rowsRead,
        confidence: body.confidence,
        rerank: body.rerank ?? null,
        top: top ? { doc: top.document_id, ref: top.ref, p: top.probability ?? null } : null,
        doc1: isDoc(top, c),
        article1: isArticle(top, c),
        article5: quotes.some((quote) => isArticle(quote, c)),
        // Was the right article (or law) among what Clef chose from?
        candidates_article: seenByClef ? seenByClef.some((x) => isArticle(x, c)) : null,
        candidates_doc: seenByClef ? seenByClef.some((x) => isDoc(x, c)) : null,
        abstained: body.confidence === "low",
      };
      row.variants[variant] = result;
      marks.push(c.unanswerable ? (result.abstained ? "u" : "!") : result.article1 ? "A" : result.doc1 ? "d" : "·");
    } catch (error) {
      row.variants[variant] = { error: error.message };
      marks.push("x");
    }
  }
  rows.push(row);
  console.log(`${String(n + 1).padStart(3)} ${marks.join("")}  ${c.q}`);
}

const pct = (x, n) => (n ? `${((x / n) * 100).toFixed(1)}%` : "–");
const summary = {};
for (const variant of variants) {
  const all = rows.map((r) => ({ ...r.variants[variant], unanswerable: r.unanswerable })).filter((v) => v && !v.error);
  const ok = all.filter((v) => !v.unanswerable);
  const unanswerable = all.filter((v) => v.unanswerable);
  const misses = ok.filter((v) => !v.article1 && v.candidates_article !== null);
  const byConfidence = {};
  for (const v of ok) {
    const b = (byConfidence[v.confidence] ??= { n: 0, right: 0 });
    b.n += 1;
    if (v.article1) b.right += 1;
  }
  summary[variant] = {
    n: ok.length,
    doc1: ok.filter((v) => v.doc1).length,
    article1: ok.filter((v) => v.article1).length,
    article5: ok.filter((v) => v.article5).length,
    reranked: ok.filter((v) => v.rerank?.applied).length,
    ms: ok.length ? Math.round(ok.reduce((s, v) => s + v.ms, 0) / ok.length) : null,
    rows_read: (() => {
      const counted = ok.filter((v) => typeof v.rows_read === "number" && v.rows_read > 0);
      return counted.length ? Math.round(counted.reduce((s, v) => s + v.rows_read, 0) / counted.length) : null;
    })(),
    byConfidence,
    candidates_article: ok.filter((v) => v.candidates_article).length,
    candidates_known: ok.filter((v) => v.candidates_article !== null).length,
    miss_not_retrieved: misses.filter((v) => !v.candidates_doc).length,
    miss_wrong_article: misses.filter((v) => v.candidates_doc && !v.candidates_article).length,
    miss_not_chosen: misses.filter((v) => v.candidates_article).length,
    unanswerable: unanswerable.length,
    unanswerable_abstained: unanswerable.filter((v) => v.abstained).length,
  };
}
writeFileSync(outPath, JSON.stringify({ base, generated_at: new Date().toISOString(), variants, summary, rows }, null, 1));

const md = [
  "## /v1/answer ölçümü",
  "",
  `${rows.length} soru (${sets.join(", ")}). A = doğru madde, d = doğru yasa/yanlış madde, · = yanlış; cevapsız sorularda u = doğru şekilde "low", ! = emin bir cevap uydurdu.`,
  "",
];
md.push("| Varyant | doğru yasa @1 | doğru madde @1 | doğru madde ilk 5'te | Clef uygulandı | ort. ms | D1 satır/soru | high: isabet | medium: isabet | low: isabet |", "|---|---|---|---|---|---|---|---|---|---|");
for (const [variant, s] of Object.entries(summary)) {
  const conf = (label) => {
    const b = s.byConfidence[label];
    return b ? `${b.right}/${b.n}` : "–";
  };
  md.push(`| ${variant} | ${pct(s.doc1, s.n)} | ${pct(s.article1, s.n)} | ${pct(s.article5, s.n)} | ${s.reranked}/${s.n} | ${s.ms ?? "–"} | ${s.rows_read ?? "–"} | ${conf("high")} | ${conf("medium")} | ${conf("low")} |`);
}
md.push("", "### Teşhis: kaçan sorular nerede kaçtı?", "", "| Varyant | doğru madde Clef'in adaylarında | kaçan: yasa adaylarda yok | kaçan: yasa var, madde yok | kaçan: madde vardı, seçilmedi | cevapsız sorularda \"low\" |", "|---|---|---|---|---|---|");
for (const [variant, s] of Object.entries(summary)) {
  md.push(`| ${variant} | ${s.candidates_known ? `${s.candidates_article}/${s.candidates_known}` : "–"} | ${s.miss_not_retrieved} | ${s.miss_wrong_article} | ${s.miss_not_chosen} | ${s.unanswerable ? `${s.unanswerable_abstained}/${s.unanswerable}` : "–"} |`);
}
const text = md.join("\n");
console.log("\n" + text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
