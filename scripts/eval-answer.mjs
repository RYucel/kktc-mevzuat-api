// End-to-end measurement of /v1/answer (what users and the MCP `sor` tool get).
//
//   BASE=https://... node scripts/eval-answer.mjs
//
// Env:
//   VARIANTS  comma list of query-string variants, each compared on the same
//             questions (default "passages=3", the live settings). Compare a
//             change in one run: "statute_first=0,passages=3".
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
const variants = (process.env.VARIANTS || "passages=3").split(",").map((v) => v.trim()).filter(Boolean);
const sets = (process.env.SETS ?? "questions").split(",").map((s) => s.trim());
const outPath = process.env.OUT ?? "eval-answer.json";

const load = (name) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8")).cases;
let cases = [];
if (sets.includes("questions")) cases.push(...load("eval-questions.json").map((c) => ({ ...c, set: c.set ?? "questions" })));
if (sets.includes("keywords")) cases.push(...load("eval-keywords.json").map((c) => ({ ...c, set: "keywords" })));
// The holdout set is run only after a change is decided, never to tune it.
if (sets.includes("holdout")) cases.push(...load("eval-holdout.json").map((c) => ({ ...c, set: c.set ? `holdout-${c.set}` : "holdout" })));
const seen = new Set();
cases = cases.filter((c) => (seen.has(c.q) ? false : seen.add(c.q)));

// A case may accept other statutes' articles too (alt: [{expect, ref|refs}]),
// each checked against the text by hand.
const answers = (c) => (c.expect ? [c, ...(c.alt ?? [])] : []);
const isDoc = (quote, c) => answers(c).some((a) => quote?.document_id === a.expect);
// "Madde 3" must not match "Madde 30"; a part suffix ("Madde 3 (2/2)") is fine.
const sameArticle = (ref, expected) => ref === expected || (ref ?? "").startsWith(`${expected} `);
const acceptable = (c) => c.refs ?? (c.ref ? [c.ref] : []);
const isArticle = (quote, c) =>
  answers(c).some(
    (a) => quote?.document_id === a.expect && (acceptable(a).length === 0 || acceptable(a).some((ref) => sameArticle(quote.ref, ref))),
  );

// oracle_doc=1: the expected statute is given as document_id, so the run shows
// how well the article is found once the statute is right (the ceiling of
// statute selection). Unanswerable questions run without it.
async function answer(q, variant, c = {}) {
  let query = variant;
  if (/(^|&)oracle_doc=1(&|$)/.test(variant)) {
    query = variant.replace(/(^|&)oracle_doc=1(?=&|$)/, "");
    if (c.expect) query += `${query ? "&" : ""}document_id=${encodeURIComponent(c.expect)}`;
  }
  const url = `${base}/v1/answer?q=${encodeURIComponent(q)}&limit=5&debug=1&${query}`;
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
  const row = { q: c.q, set: c.set, expect: c.expect ?? null, refs: acceptable(c), alt: c.alt ?? [], unanswerable: !!c.unanswerable, variants: {} };
  const marks = [];
  for (const variant of variants) {
    try {
      const { body, ms, rowsRead } = await answer(c.q, variant, c);
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
        rewrite_cached: body.query_rewrite ? !!body.query_rewrite.cached : null,
        caps: body.confidence_caps ?? [],
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
  const all = rows.map((r) => ({ ...r.variants[variant], unanswerable: r.unanswerable, set: r.set })).filter((v) => v && !v.error);
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
    // The number that matters most: a confident wrong answer (wrong article,
    // or any "high" for a question no statute answers).
    high_wrong: all.filter((v) => v.confidence === "high" && (v.unanswerable || !v.article1)).length,
    high: all.filter((v) => v.confidence === "high").length,
    rewrite_cached: all.filter((v) => v.rewrite_cached === true).length,
    rewrite_known: all.filter((v) => v.rewrite_cached !== null).length,
    // Questions answered by a regulation (tüzük): the statute_first rule must not lose them.
    tuzuk: ok.filter((v) => /tuzuk$/.test(v.set ?? "")).length,
    tuzuk_article1: ok.filter((v) => /tuzuk$/.test(v.set ?? "") && v.article1).length,
    // Which confidence caps fired, and on right or wrong answers.
    caps: all.reduce((acc, v) => {
      for (const cap of v.caps ?? []) {
        const b = (acc[cap] ??= { right: 0, wrong: 0 });
        if (v.unanswerable ? v.abstained : v.article1) b.right += 1;
        else b.wrong += 1;
      }
      return acc;
    }, {}),
  };
}
writeFileSync(outPath, JSON.stringify({ base, generated_at: new Date().toISOString(), variants, summary, rows }, null, 1));

const md = [
  "## /v1/answer ölçümü",
  "",
  `${rows.length} soru (${sets.join(", ")}). A = doğru madde, d = doğru yasa/yanlış madde, · = yanlış; cevapsız sorularda u = doğru şekilde "low", ! = emin bir cevap uydurdu.`,
  "",
];
md.push("| Varyant | **high ama yanlış** | doğru yasa @1 | doğru madde @1 | doğru madde ilk 5'te | Clef uygulandı | LLM önbellekten | ort. ms | D1 satır/soru | high: isabet | medium: isabet | low: isabet |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const [variant, s] of Object.entries(summary)) {
  const conf = (label) => {
    const b = s.byConfidence[label];
    return b ? `${b.right}/${b.n}` : "–";
  };
  md.push(`| ${variant} | **${s.high_wrong}/${s.high}** | ${pct(s.doc1, s.n)} | ${pct(s.article1, s.n)} | ${pct(s.article5, s.n)} | ${s.reranked}/${s.n} | ${s.rewrite_known ? `${s.rewrite_cached}/${s.rewrite_known}` : "–"} | ${s.ms ?? "–"} | ${s.rows_read ?? "–"} | ${conf("high")} | ${conf("medium")} | ${conf("low")} |`);
}
if (Object.values(summary).some((s) => s.tuzuk)) {
  md.push("", "| Varyant | cevabı tüzükte olan sorular: doğru madde @1 |", "|---|---|");
  for (const [variant, s] of Object.entries(summary)) md.push(`| ${variant} | ${s.tuzuk_article1}/${s.tuzuk} |`);
}
md.push("", "### Güven düşürme nedenleri (doğru / yanlış cevapta)", "", "| Varyant | nedenler |", "|---|---|");
for (const [variant, s] of Object.entries(summary)) {
  const caps = Object.entries(s.caps ?? {}).map(([cap, b]) => `${cap}: ${b.right} doğru / ${b.wrong} yanlış`).join("; ");
  md.push(`| ${variant} | ${caps || "–"} |`);
}
md.push("", "### Teşhis: kaçan sorular nerede kaçtı?", "", "| Varyant | doğru madde Clef'in adaylarında | kaçan: yasa adaylarda yok | kaçan: yasa var, madde yok | kaçan: madde vardı, seçilmedi | cevapsız sorularda \"low\" |", "|---|---|---|---|---|---|");
for (const [variant, s] of Object.entries(summary)) {
  md.push(`| ${variant} | ${s.candidates_known ? `${s.candidates_article}/${s.candidates_known}` : "–"} | ${s.miss_not_retrieved} | ${s.miss_wrong_article} | ${s.miss_not_chosen} | ${s.unanswerable ? `${s.unanswerable_abstained}/${s.unanswerable}` : "–"} |`);
}
const topLabel = (v) => (v.top ? `${v.top.doc} ${v.top.ref ?? ""} (${v.top.p ?? "–"})` : "–");
const expected = (r) =>
  r.unanswerable
    ? "cevapsız"
    : [`${r.expect} ${r.refs.join("/")}`, ...r.alt.map((a) => `${a.expect} ${(a.refs ?? [a.ref]).join("/")}`)].join(" veya ");

// Confident wrong answers, per variant: the list to work on first.
for (const variant of variants) {
  const wrong = rows.filter((r) => {
    const v = r.variants[variant];
    return v && !v.error && v.confidence === "high" && (r.unanswerable || !v.article1);
  });
  md.push("", `### "high" ama yanlış (${variant}): ${wrong.length}`, "");
  if (!wrong.length) continue;
  md.push("| Soru | Beklenen | Seçilen (olasılık) |", "|---|---|---|");
  for (const r of wrong) md.push(`| ${r.q} | ${expected(r)} | ${topLabel(r.variants[variant])} |`);
}

// Every miss of every variant, with where the right law stood among what
// Clef saw (focus candidates first, then the first-step candidates).
for (const variant of variants) {
  md.push("", `### Kaçan sorular (${variant})`, "", "| Soru | Beklenen | Seçilen (olasılık) | Güven | Beklenen yasa Clef listesinde |", "|---|---|---|---|---|");
  for (const r of rows) {
    const v = r.variants[variant];
    if (!v || v.error || r.unanswerable || v.article1) continue;
    const list = v.rerank?.debug_candidates ?? [];
    const where = list
      .map((x, i) => (x.document_id === r.expect || r.alt.some((a) => a.expect === x.document_id) ? `#${i + 1} ${x.document_id === r.expect ? "" : `${x.document_id} `}${x.ref ?? ""} (${x.probability})` : null))
      .filter(Boolean)
      .slice(0, 4)
      .join(", ");
    md.push(`| ${r.q} | ${expected(r)} | ${topLabel(v)} | ${v.confidence} | ${where || "yok"} |`);
  }
}

// What changed against the first variant: fixed, broken, and confidence moves.
const ok = (r, v) => (r.unanswerable ? v.abstained : v.article1);
for (const variant of variants.slice(1)) {
  const changes = [];
  for (const r of rows) {
    const a = r.variants[variants[0]];
    const b = r.variants[variant];
    if (!a || !b || a.error || b.error) continue;
    if (ok(r, a) !== ok(r, b)) changes.push(`| ${ok(r, b) ? "düzeldi" : "bozuldu"} | ${r.q} | ${a.confidence} ${topLabel(a)} | ${b.confidence} ${topLabel(b)} |`);
    else if (a.confidence !== b.confidence) changes.push(`| güven ${a.confidence} → ${b.confidence} (${ok(r, b) ? "doğru" : "yanlış"}) | ${r.q} | ${topLabel(a)} | ${topLabel(b)} |`);
  }
  md.push("", `### ${variants[0]} → ${variant}: değişen sorular (${changes.length})`, "");
  if (changes.length) md.push("| Değişim | Soru | Önce | Sonra |", "|---|---|---|---|", ...changes);
}
const text = md.join("\n");
console.log("\n" + text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
