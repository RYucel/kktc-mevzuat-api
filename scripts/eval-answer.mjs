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
// Same id with and without leading zeros ("yasa-09-1976" / "yasa-9-1976") is one statute.
const canon = (id) => (id ?? "").replace(/(?<![0-9])0+(?=[0-9])/g, "");
const isDoc = (quote, c) => answers(c).some((a) => !!quote?.document_id && canon(quote.document_id) === canon(a.expect));
// "Madde 3" must not match "Madde 30"; a part suffix ("Madde 3 (2/2)") is fine.
const sameArticle = (ref, expected) => ref === expected || (ref ?? "").startsWith(`${expected} `);
// The answer must be in what the reader gets (the quoted window), not only in the article.
const foldText = (text) => (text ?? "").replace(/I/g, "ı").replace(/İ/g, "i").toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ");
const hasAnswer = (quote, c) => !!quote && (c.must ?? []).some((m) => foldText(quote.text).includes(foldText(m)));
const acceptable = (c) => c.refs ?? (c.ref ? [c.ref] : []);
const isArticle = (quote, c) =>
  answers(c).some(
    (a) => !!quote?.document_id && canon(quote.document_id) === canon(a.expect) && (acceptable(a).length === 0 || acceptable(a).some((ref) => sameArticle(quote.ref, ref))),
  );

// oracle_doc=1: the expected statute is given as document_id, so the run shows
// how well the article is found once the statute is right (the ceiling of
// statute selection). Unanswerable questions run without it.
// category=auto / category=wrong (OPUS-GOREVLER-4 item 21): the category is
// derived from the expected statute's own categories (from the build, never
// written by hand per question). auto: its first category; wrong: the next
// category in the list that the statute does not have (deterministic).
// Unanswerable questions get a category picked from the question's hash
// (choosing a category must not break "low").
let categoryList = null;
const docCategories = new Map();
async function categoryFor(c, how) {
  if (!categoryList) {
    const body = await (await fetch(`${base}/v1/categories`)).json();
    categoryList = body.categories.map((x) => x.id);
  }
  if (!c.expect) {
    let h = 0;
    for (const ch of c.q) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return categoryList[h % categoryList.length];
  }
  if (!docCategories.has(c.expect)) {
    const body = await (await fetch(`${base}/v1/categories?document_id=${encodeURIComponent(c.expect)}`)).json();
    docCategories.set(c.expect, body.categories ?? []);
  }
  const own = docCategories.get(c.expect);
  if (!own.length) return null;
  if (how === "auto") return own[0];
  const start = categoryList.indexOf(own[0]);
  for (let i = 1; i < categoryList.length; i++) {
    const next = categoryList[(start + i) % categoryList.length];
    if (!own.includes(next) && next !== "diger") return next;
  }
  return null;
}

async function answer(q, variant, c = {}) {
  let query = variant;
  if (/(^|&)oracle_doc=1(&|$)/.test(variant)) {
    query = variant.replace(/(^|&)oracle_doc=1(?=&|$)/, "");
    if (c.expect) query += `${query ? "&" : ""}document_id=${encodeURIComponent(c.expect)}`;
  }
  const how = /(?:^|&)category=(auto|wrong)(?=&|$)/.exec(query)?.[1];
  if (how) {
    const category = await categoryFor(c, how);
    query = query.replace(/(^|&)category=(auto|wrong)(?=&|$)/, category ? `$1category=${category}` : "");
  }
  const url = `${base}/v1/answer?q=${encodeURIComponent(q)}&limit=5&debug=1&${query}`;
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    const response = await fetch(url);
    if (response.ok) {
      const rows = response.headers.get("x-d1-rows-read");
      const neurons = response.headers.get("x-clef-neurons");
      return {
        body: await response.json(),
        ms: Date.now() - started,
        rowsRead: rows === null ? null : Number(rows),
        neurons: neurons === null ? null : Number(neurons),
        clefCalls: response.headers.get("x-clef-calls") === null ? null : Number(response.headers.get("x-clef-calls")),
      };
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
      const { body, ms, rowsRead, neurons, clefCalls } = await answer(c.q, variant, c);
      const quotes = body.quotes ?? [];
      const top = quotes[0];
      const seenByClef = body.rerank?.debug_candidates ?? null;
      const result = {
        ms,
        rows_read: rowsRead,
        neurons,
        clef_calls: clefCalls,
        confidence: body.confidence,
        rerank: body.rerank ?? null,
        top: top ? { doc: top.document_id, ref: top.ref, p: top.probability ?? null } : null,
        doc1: isDoc(top, c),
        article1: isArticle(top, c),
        // must: the quoted text of the first answer contains the answer phrase.
        quote_has_answer: c.must?.length ? hasAnswer(top, c) : null,
        quote3_has_answer: c.must?.length ? quotes.slice(0, 3).some((q) => hasAnswer(q, c)) : null,
        article5: quotes.some((quote) => isArticle(quote, c)),
        // Was the right article (or law) among what Clef chose from?
        candidates_article: seenByClef ? seenByClef.some((x) => isArticle(x, c)) : null,
        candidates_doc: seenByClef ? seenByClef.some((x) => isDoc(x, c)) : null,
        abstained: body.confidence === "low",
        rewrite_cached: body.query_rewrite ? !!body.query_rewrite.cached : null,
        caps: body.confidence_caps ?? [],
        category: body.category ? { id: body.category.id, outside: body.category.outside } : null,
        // verify=1: probability that the quoted window answers (for choosing thresholds offline).
        verify: body.rerank?.verify?.applied ? body.rerank.verify.answers : null,
        verify_refers: body.rerank?.verify?.applied ? body.rerank.verify.refers : null,
        verify_before: body.rerank?.verify?.applied ? body.rerank.verify.before : null,
        // see_also: a regulation under the quoted law was nearly as likely (what reg_cap=1 would cap).
        reg_close: top?.see_also ? top.see_also.probability >= (top.probability ?? 0) / 2 : false,
        // Signals for a confidence calibrator (OPUS-GOREVLER-5 item 9); none needs an extra call.
        signals: top
          ? {
              p1: body.rerank?.top_probability ?? top.probability ?? 0,
              none: body.rerank?.none_probability ?? 0,
              p2: quotes[1]?.probability ?? 0,
              focus: body.rerank?.focus?.applied ? (body.rerank.focus.top_probability ?? 0) : null,
              pick: body.rerank?.quote_pick ? body.rerank.quote_pick.probability : null,
              rewrite_disagrees: (body.confidence_caps ?? []).includes("rewrite_disagrees") ? 1 : 0,
              regulation: /^tuzuk-/.test(top.document_id ?? "") ? 1 : 0,
              partial: top.text_status && top.text_status !== "full" ? 1 : 0,
              number_asked: /\b(kaç|ne kadar|yüzde|oran|süre)/i.test(c.q) ? 1 : 0,
              number_in_quote: /\d/.test(top.text ?? "") ? 1 : 0,
            }
          : null,
        // lawpick: was the expected statute among the statutes shown, and chosen first?
        // terms=1: a dictionary term found in the question named the right article.
        term_article: Array.isArray(body.terms_matched) ? body.terms_matched.some((t) => isArticle(t, c)) : null,
        term_count: Array.isArray(body.terms_matched) ? body.terms_matched.length : null,
        law_listed: body.rerank?.debug_laws ? body.rerank.debug_laws.some((x) => isDoc(x, c)) : null,
        law_pick1: body.rerank?.debug_laws ? isDoc(body.rerank.debug_laws[0], c) : null,
        // toc=1: was the right article among those chosen from the table of contents?
        toc5: body.rerank?.focus?.toc
          ? body.rerank.focus.toc.some((t) => t.refs.some((ref) => isArticle({ document_id: t.document_id, ref }, c)))
          : null,
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
    must_known: ok.filter((v) => v.quote_has_answer !== null).length,
    quote_has_answer: ok.filter((v) => v.quote_has_answer).length,
    // Right article first, but its quoted window misses the answer.
    article_without_answer: ok.filter((v) => v.article1 && v.quote_has_answer === false).length,
    quote3_has_answer: ok.filter((v) => v.quote3_has_answer).length,
    reranked: ok.filter((v) => v.rerank?.applied).length,
    ms: ok.length ? Math.round(ok.reduce((s, v) => s + v.ms, 0) / ok.length) : null,
    rows_read: (() => {
      const counted = ok.filter((v) => typeof v.rows_read === "number" && v.rows_read > 0);
      return counted.length ? Math.round(counted.reduce((s, v) => s + v.rows_read, 0) / counted.length) : null;
    })(),
    // Clef neurons and calls per question (x-clef-neurons; all questions, unanswerable too).
    neurons: (() => {
      const counted = all.filter((v) => typeof v.neurons === "number");
      return counted.length ? Number((counted.reduce((s, v) => s + v.neurons, 0) / counted.length).toFixed(1)) : null;
    })(),
    clef_calls: (() => {
      const counted = all.filter((v) => typeof v.clef_calls === "number");
      return counted.length ? Number((counted.reduce((s, v) => s + v.clef_calls, 0) / counted.length).toFixed(2)) : null;
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
    term_known: ok.filter((v) => v.term_article !== null).length,
    term_article: ok.filter((v) => v.term_article).length,
    term_any: ok.filter((v) => v.term_count > 0).length,
    law_known: ok.filter((v) => v.law_listed !== null).length,
    law_listed: ok.filter((v) => v.law_listed).length,
    law_pick1: ok.filter((v) => v.law_pick1).length,
    toc_known: ok.filter((v) => v.toc5 !== null).length,
    toc5: ok.filter((v) => v.toc5).length,
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
md.push("| Varyant | **high ama yanlış** | doğru yasa @1 | doğru madde @1 | doğru madde ilk 5'te | Clef uygulandı | LLM önbellekten | ort. ms | D1 satır/soru | Clef nöron/soru (çağrı) | high: isabet | medium: isabet | low: isabet |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const [variant, s] of Object.entries(summary)) {
  const conf = (label) => {
    const b = s.byConfidence[label];
    return b ? `${b.right}/${b.n}` : "–";
  };
  md.push(`| ${variant} | **${s.high_wrong}/${s.high}** | ${pct(s.doc1, s.n)} | ${pct(s.article1, s.n)} | ${pct(s.article5, s.n)} | ${s.reranked}/${s.n} | ${s.rewrite_known ? `${s.rewrite_cached}/${s.rewrite_known}` : "–"} | ${s.ms ?? "–"} | ${s.rows_read ?? "–"} | ${s.neurons ?? "–"}${s.clef_calls !== null ? ` (${s.clef_calls})` : ""} | ${conf("high")} | ${conf("medium")} | ${conf("low")} |`);
}
// 95% Wilson interval: with 64 questions one question is 1.6 points.
const wilson = (x, n) => {
  if (!n) return "–";
  const z = 1.96, p = x / n, d = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / d, half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return `${(Math.max(0, mid - half) * 100).toFixed(0)}–${(Math.min(1, mid + half) * 100).toFixed(0)}%`;
};
if (Object.values(summary).some((s) => s.must_known)) {
  md.push("", "| Varyant | doğru madde @1 (%95 aralık) | alıntı cevabı içeriyor @1 | ilk 3 alıntıdan biri cevabı içeriyor | doğru madde ama alıntıda cevap yok |", "|---|---|---|---|---|");
  for (const [variant, s] of Object.entries(summary)) {
    md.push(`| ${variant} | ${pct(s.article1, s.n)} (${wilson(s.article1, s.n)}) | ${s.must_known ? `${s.quote_has_answer}/${s.must_known} (${wilson(s.quote_has_answer, s.must_known)})` : "–"} | ${s.must_known ? `${s.quote3_has_answer}/${s.must_known}` : "–"} | ${s.must_known ? s.article_without_answer : "–"} |`);
  }
}
// reg_cap=1 simulated on any run (OPUS-GOREVLER-5 item 10): which "high"
// answers it would lower, right and wrong.
{
  const lines = [];
  for (const variant of variants) {
    const hs = rows.map((r) => ({ v: r.variants[variant], r })).filter(({ v }) => v && !v.error && v.confidence === "high" && v.reg_close);
    if (!hs.length) continue;
    const wrongs = hs.filter(({ v, r }) => r.unanswerable || !v.article1).length;
    lines.push(`| ${variant} | ${hs.length - wrongs} | ${wrongs} |`);
  }
  if (lines.length) md.push("", "### Tüzük yakın ikinciyse (reg_cap=1 benzetimi): \"high\"tan düşecek cevaplar", "", "| Varyant | doğru | yanlış |", "|---|---|---|", ...lines);
}

// Confidence calibrator (OPUS-GOREVLER-5 item 9): logistic regression on the
// signals above, 5-fold cross-validated. Each fold picks, on its four other
// folds, the lowest score whose "high" precision is >= 95%; the held-out
// fold is then labelled with it. Reported against today's rule.
function calibrate(points) {
  const names = ["p1", "none", "margin", "focus", "has_focus", "pick", "has_pick", "rewrite_disagrees", "regulation", "partial", "num_match"];
  const featurize = (s) => [
    s.p1, s.none, s.p1 - s.p2, s.focus ?? 0, s.focus === null ? 0 : 1, s.pick ?? 0, s.pick === null ? 0 : 1,
    s.rewrite_disagrees, s.regulation, s.partial, s.number_asked ? s.number_in_quote : 1,
  ];
  const X = points.map((p) => featurize(p.s));
  const y = points.map((p) => (p.right ? 1 : 0));
  const fit = (idx) => {
    const d = names.length;
    const mean = Array(d).fill(0), sd = Array(d).fill(0);
    for (const i of idx) X[i].forEach((v, j) => (mean[j] += v / idx.length));
    for (const i of idx) X[i].forEach((v, j) => (sd[j] += (v - mean[j]) ** 2 / idx.length));
    sd.forEach((v, j) => (sd[j] = Math.sqrt(v) || 1));
    const w = Array(d + 1).fill(0);
    for (let epoch = 0; epoch < 400; epoch++) {
      const g = Array(d + 1).fill(0);
      for (const i of idx) {
        const z = X[i].reduce((a, v, j) => a + w[j] * ((v - mean[j]) / sd[j]), w[d]);
        const err = 1 / (1 + Math.exp(-z)) - y[i];
        X[i].forEach((v, j) => (g[j] += err * ((v - mean[j]) / sd[j])));
        g[d] += err;
      }
      for (let j = 0; j <= d; j++) w[j] -= 0.1 * (g[j] / idx.length + (j < d ? 0.01 * w[j] : 0));
    }
    return (x) => 1 / (1 + Math.exp(-x.reduce((a, v, j) => a + w[j] * ((v - mean[j]) / sd[j]), w[d])));
  };
  const threshold = (scored) => {
    // Lowest score keeping precision >= 0.95 among those at or above it.
    const sorted = [...scored].sort((a, b) => b.score - a.score);
    let right = 0, best = 1.01;
    sorted.forEach((p, k) => {
      right += p.right ? 1 : 0;
      if (right / (k + 1) >= 0.95) best = p.score;
    });
    return best;
  };
  const folds = points.map((_, i) => i % 5);
  let high = 0, wrong = 0;
  const oof = [];
  for (let f = 0; f < 5; f++) {
    const train = points.map((_, i) => i).filter((i) => folds[i] !== f);
    const model = fit(train);
    const t = threshold(train.map((i) => ({ score: model(X[i]), right: !!y[i] })));
    for (const i of points.map((_, i) => i).filter((i) => folds[i] === f)) {
      const score = model(X[i]);
      oof.push({ score, right: !!y[i] });
      if (score >= t) {
        high++;
        if (!y[i]) wrong++;
      }
    }
  }
  const curve = [0.2, 0.3, 0.4, 0.5].map((cov) => {
    const top = [...oof].sort((a, b) => b.score - a.score).slice(0, Math.round(cov * oof.length));
    return { coverage: cov, n: top.length, wrong: top.filter((p) => !p.right).length };
  });
  return { high, wrong, curve };
}
for (const variant of variants) {
  const points = rows
    .map((r) => ({ v: r.variants[variant], unanswerable: r.unanswerable }))
    .filter(({ v }) => v && !v.error && v.signals)
    .map(({ v, unanswerable }) => ({ s: v.signals, right: !unanswerable && v.article1, high: v.confidence === "high" }));
  if (points.length < 60) continue;
  const today = points.filter((p) => p.high);
  const cal = calibrate(points);
  md.push(
    "",
    `### Güven kalibratörü (${variant}; 5 katlı çapraz doğrulama, hedef "high" isabeti ≥ %95)`,
    "",
    "| | high | high ama yanlış |",
    "|---|---|---|",
    `| bugünkü kural | ${today.length} | ${today.filter((p) => !p.right).length} |`,
    `| kalibratör | ${cal.high} | ${cal.wrong} |`,
    "",
    "| kapsam (en yüksek skorlu cevapların payı) | cevap | yanlış |",
    "|---|---|---|",
    ...cal.curve.map((c) => `| %${Math.round(c.coverage * 100)} | ${c.n} | ${c.wrong} |`),
  );
}

// verify=1: which threshold on "does the quote answer?" keeps "high" honest.
// 5-fold cross-validation over the questions: each fold's threshold is chosen
// on the other four (fewest wrong "high", then most right "high"), so the
// reported numbers are not fitted to the same questions.
for (const variant of variants) {
  const pts = rows
    .map((r) => ({ v: r.variants[variant], unanswerable: r.unanswerable }))
    .filter(({ v }) => v && !v.error && typeof v.verify === "number" && v.verify_before === "high")
    .map(({ v, unanswerable }) => ({ p: v.verify, right: !unanswerable && v.article1 }));
  if (pts.length < 10) continue;
  const grid = Array.from({ length: 19 }, (_, i) => (i + 1) / 20);
  const score = (set, t) => {
    const kept = set.filter((x) => x.p >= t);
    return { high: kept.length, wrong: kept.filter((x) => !x.right).length };
  };
  const pick = (set) =>
    grid.reduce((best, t) => {
      const a = score(set, t), b = score(set, best);
      return a.wrong < b.wrong || (a.wrong === b.wrong && a.high > b.high) ? t : best;
    }, 0);
  let cvHigh = 0, cvWrong = 0;
  const chosen = [];
  for (let k = 0; k < 5; k++) {
    const test = pts.filter((_, i) => i % 5 === k), train = pts.filter((_, i) => i % 5 !== k);
    const t = pick(train);
    chosen.push(t);
    const s = score(test, t);
    cvHigh += s.high;
    cvWrong += s.wrong;
  }
  md.push("", `### Doğrulama eşiği (${variant}): doğrulamadan önce "high" olan ${pts.length} cevap, ${pts.filter((x) => !x.right).length} yanlış`, "", "| eşik | high kalır | high ama yanlış |", "|---|---|---|");
  for (const t of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    const s = score(pts, t);
    md.push(`| ${t} | ${s.high} | ${s.wrong} |`);
  }
  md.push("", `5 katlı çapraz doğrulama: seçilen eşikler ${chosen.join(", ")}; ayrılan sorularda high ${cvHigh}, yanlış ${cvWrong}.`);
}
if (Object.values(summary).some((s) => s.term_known)) {
  md.push("", "| Varyant | sözlükten terim bulunan soru | sözlük doğru maddeyi getirdi |", "|---|---|---|");
  for (const [variant, s] of Object.entries(summary)) md.push(`| ${variant} | ${s.term_known ? `${s.term_any}/${s.term_known}` : "–"} | ${s.term_known ? `${s.term_article}/${s.term_known}` : "–"} |`);
}
if (Object.values(summary).some((s) => s.law_known)) {
  md.push("", "| Varyant | beklenen yasa kısa listede | yasa seçimi @1 |", "|---|---|---|");
  for (const [variant, s] of Object.entries(summary)) md.push(`| ${variant} | ${s.law_known ? `${s.law_listed}/${s.law_known}` : "–"} | ${s.law_known ? `${s.law_pick1}/${s.law_known}` : "–"} |`);
}
if (Object.values(summary).some((s) => s.toc_known)) {
  md.push("", "| Varyant | doğru madde içindekiler seçiminde ilk 5'te |", "|---|---|");
  for (const [variant, s] of Object.entries(summary)) md.push(`| ${variant} | ${s.toc_known ? `${s.toc5}/${s.toc_known}` : "–"} |`);
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
// category variants: how often the answer came from outside the given category.
const categoryVariants = variants.filter((v) => /(?:^|&)category=/.test(v));
if (categoryVariants.length) {
  md.push("", "### Kategori (category=...)", "", "| Varyant | kategori verilen soru | cevap kategori dışında: doğru / yanlış | cevapsızlarda \"low\" |", "|---|---|---|---|");
  for (const variant of categoryVariants) {
    const vs = rows.map((r) => ({ v: r.variants[variant], r })).filter(({ v }) => v && !v.error);
    const given = vs.filter(({ v }) => v.category);
    const outside = given.filter(({ v }) => v.category.outside);
    const right = outside.filter(({ v, r }) => !r.unanswerable && v.article1).length;
    const un = vs.filter(({ r }) => r.unanswerable);
    md.push(`| ${variant} | ${given.length}/${vs.length} | ${right} / ${outside.length - right} | ${un.filter(({ v }) => v.abstained).length}/${un.length} |`);
  }
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
