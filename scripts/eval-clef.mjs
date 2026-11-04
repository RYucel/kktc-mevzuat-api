// Measures whether Cloudflare Clef (a "System 1" decision model) improves
// answer ranking and confidence calibration, before any integration.
//
//   BASE=https://... ADMIN_TOKEN=... node scripts/eval-clef.mjs
//
// Env:
//   MODELS      comma list of clef, clef-flash         (default "clef-flash,clef")
//   MODES       comma list of point, list              (default "point,list")
//   TOP_K       candidates per question from search    (default 10)
//   INSTR_LANG  instructions language: tr | en          (default tr)
//   SETS        questions, keywords                     (default "questions,keywords")
//   MAX_CASES   cap for a quick run                     (default all)
//   CONCURRENCY parallel Clef calls                     (default 4)
//   OUT         JSON report path                        (default eval-clef.json)
//
// For every question the hybrid search's top K documents (each with its best
// matching passage) are the candidates. Rankers compared:
//   lexical      /v1/search?semantic=0 order
//   hybrid       /v1/search order (what the API returns today)
//   <model>:point  one Clef call per candidate, `noul` "does this passage
//                answer the question?", candidates sorted by that probability
//   <model>:list   one Clef call per question, `choice` over the candidates
//
// Metrics: doc hit@1, MRR@K, article hit@1 (top passage is the expected
// article), Brier score and ECE of the top-1 probability, and the abstention
// curve (answer only when p >= tau: coverage and precision). The API's own
// /v1/answer confidence (high/medium/low) is the calibration baseline.
// Raw model outputs are kept for the first few calls so the answer schema can
// be checked by hand.

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const base = (process.env.BASE ?? "http://localhost:8787").replace(/\/$/, "");
// Our own jobs send the admin token, so the Worker's per-client rate limit
// (30 requests a minute) does not apply to them.
if (process.env.ADMIN_TOKEN) {
  const plainFetch = globalThis.fetch;
  globalThis.fetch = (url, init = {}) =>
    plainFetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${process.env.ADMIN_TOKEN}` } });
}
const token = process.env.ADMIN_TOKEN ?? "";
const models = (process.env.MODELS ?? "clef-flash,clef").split(",").map((s) => s.trim()).filter(Boolean);
const modes = (process.env.MODES ?? "point,list").split(",").map((s) => s.trim()).filter(Boolean);
const topK = Number(process.env.TOP_K ?? 10);
const lang = process.env.INSTR_LANG === "en" ? "en" : "tr";
const sets = (process.env.SETS ?? "questions,keywords").split(",").map((s) => s.trim());
const maxCases = Number(process.env.MAX_CASES ?? 0);
const concurrency = Number(process.env.CONCURRENCY ?? 4);
const outPath = process.env.OUT ?? "eval-clef.json";
const PASSAGE_CHARS = 1400; // Workers AI keeps roughly the first 2K tokens of state
const LIST_PASSAGE_CHARS = 420;
const RAW_KEEP = 3;

const load = (name) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8")).cases;
let cases = [];
if (sets.includes("questions")) cases.push(...load("eval-questions.json").map((c) => ({ ...c, set: "questions" })));
if (sets.includes("keywords")) cases.push(...load("eval-keywords.json").map((c) => ({ ...c, set: "keywords" })));
const seen = new Set();
cases = cases.filter((c) => (seen.has(c.q) ? false : seen.add(c.q)));
if (maxCases > 0) cases = cases.slice(0, maxCases);

const TEXT = {
  tr: {
    answers:
      "Bu yasa maddesi, sorudaki hukuki soruyu doğrudan cevaplıyor mu? Yalnızca konu benzerliği yetmez; " +
      "maddenin kendisi sorunun cevabını içermeli.",
    pick: "Bu adaylardan hangisi soruyu doğrudan cevaplayan yasa maddesidir?",
    none: "Hiçbiri soruyu cevaplamıyor",
    question: "soru",
    passage: "madde",
    candidates: "adaylar",
  },
  en: {
    answers:
      "Does this statute passage directly answer the legal question? Being on the same topic is not enough; " +
      "the passage itself must contain the answer. (Question and passage are in Turkish.)",
    pick: "Which candidate is the statute passage that directly answers the question? (Turkish text.)",
    none: "None of them answers the question",
    question: "question",
    passage: "passage",
    candidates: "candidates",
  },
}[lang === "en" ? "en" : "tr"];

async function getJson(url, init) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init);
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 500) };
    }
    if (response.ok) return body;
    if (attempt < 2 && response.status >= 500 && response.status !== 501) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    const error = new Error(`HTTP ${response.status} ${url.replace(base, "")}: ${JSON.stringify(body).slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
}

const search = (q, semantic) =>
  getJson(`${base}/v1/search?q=${encodeURIComponent(q)}&limit=${topK}${semantic ? "" : "&semantic=0"}`);
const answer = (q) => getJson(`${base}/v1/answer?q=${encodeURIComponent(q)}&limit=1&rerank=0`);

let quotaHit = null;
async function decide(model, input) {
  if (quotaHit) throw quotaHit;
  try {
    return await getJson(`${base}/admin/decide`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input: { model, ...input } }),
    });
  } catch (error) {
    if (error.status === 429) quotaHit = error;
    throw error;
  }
}

// --- answer parsing ---------------------------------------------------------
// The output schema is not fully documented, so accept the plausible shapes.
function toProb(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1 ? value / 100 : value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    if (/^\s*[\d.]+\s*%?\s*$/.test(value)) return toProb(Number.parseFloat(value) / (value.includes("%") ? 100 : 1));
    if (/^(yes|evet|true)$/i.test(value.trim())) return 1;
    if (/^(no|hay[ıi]r|false)$/i.test(value.trim())) return 0;
    return null;
  }
  if (value && typeof value === "object") {
    // Workers AI shape: { type: "noul", noul: 0.95 }
    if (typeof value.type === "string" && value.type in value) {
      const p = toProb(value[value.type]);
      if (p !== null) return p;
    }
    for (const key of ["noul", "probability", "prob", "p", "p_yes", "yes", "true", "value", "score", "answer"]) {
      if (key in value) {
        const p = toProb(value[key]);
        if (p !== null) return p;
      }
    }
    if ("no" in value) {
      const p = toProb(value.no);
      if (p !== null) return 1 - p;
    }
  }
  return null;
}

function answersOf(output) {
  const o = output?.output ?? output;
  return o?.answers ?? o?.result?.answers ?? o?.response?.answers ?? null;
}

/** Per-option probabilities of a `choice` answer, keyed by option id. */
function choiceProbs(value, keys) {
  if (!value || typeof value !== "object") return null;
  const direct = keys.filter((k) => typeof value[k] === "number");
  if (direct.length >= 2) return Object.fromEntries(keys.map((k) => [k, Number(value[k] ?? 0)]));
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") {
      const found = choiceProbs(nested, keys);
      if (found) return found;
    }
  }
  if (Array.isArray(value)) return null;
  const chosen = value.choice ?? value.answer ?? value.selected ?? value.option;
  if (typeof chosen === "string" && keys.includes(chosen)) {
    return Object.fromEntries(keys.map((k) => [k, k === chosen ? 1 : 0]));
  }
  return null;
}

// --- helpers ----------------------------------------------------------------
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
}

const passage = (r) => (r.matched_text || r.snippet || "").replace(/\s+/g, " ").trim();
const candidateOf = (r) => ({
  id: r.id,
  ref: r.matched_ref ?? null,
  label: `${r.citation ?? r.title}${r.matched_ref ? `, ${r.matched_ref}` : ""}`,
  text: passage(r),
});
const isDoc = (c, item) => c.id === item.expect;
// "Madde 3" must not match "Madde 30"; a part suffix ("Madde 3 (2/2)") is fine.
const isArticle = (c, item) => isDoc(c, item) && (!item.ref || c.ref === item.ref || (c.ref ?? "").startsWith(`${item.ref} `));

const raw = {};
const keepRaw = (key, value) => {
  raw[key] ??= [];
  if (raw[key].length < RAW_KEEP) raw[key].push(value);
};
const usage = {};
const addUsage = (key, response) => {
  const u = (usage[key] ??= { calls: 0, ms: 0, failures: 0, unparsed: 0, prompt_tokens: 0, completion_tokens: 0 });
  u.calls += 1;
  u.ms += response?.ms ?? 0;
  const tok = response?.output?.usage ?? {};
  u.prompt_tokens += Number(tok.prompt_tokens ?? tok.input_tokens ?? 0);
  u.completion_tokens += Number(tok.completion_tokens ?? tok.output_tokens ?? 0);
  return u;
};

async function pointwise(model, item, candidates) {
  const key = `${model}:point`;
  return pool(candidates, concurrency, async (c) => {
    const input = {
      state: { [TEXT.question]: item.q, [TEXT.passage]: c.label, metin: c.text.slice(0, PASSAGE_CHARS) },
      questions: { answers: { type: "noul", instructions: TEXT.answers } },
    };
    try {
      const response = await decide(model, input);
      const u = addUsage(key, response);
      keepRaw(key, { q: item.q, candidate: c.label, response });
      const p = toProb(answersOf(response)?.answers);
      if (p === null) u.unparsed += 1;
      return p;
    } catch (error) {
      addUsage(key).failures += 1;
      keepRaw(`${key}:errors`, { q: item.q, error: error.message });
      return null;
    }
  });
}

async function listwise(model, item, candidates) {
  const key = `${model}:list`;
  const ids = candidates.map((_, i) => `c${i + 1}`);
  const criteria = Object.fromEntries(candidates.map((c, i) => [ids[i], c.label]));
  criteria.none = TEXT.none;
  const input = {
    state: {
      [TEXT.question]: item.q,
      [TEXT.candidates]: candidates.map((c, i) => ({ id: ids[i], [TEXT.passage]: c.label, metin: c.text.slice(0, LIST_PASSAGE_CHARS) })),
    },
    questions: { pick: { type: "choice", instructions: TEXT.pick, criteria } },
  };
  try {
    const response = await decide(model, input);
    const u = addUsage(key, response);
    keepRaw(key, { q: item.q, response });
    const probs = choiceProbs(answersOf(response)?.pick, [...ids, "none"]);
    if (!probs) {
      u.unparsed += 1;
      return candidates.map(() => null);
    }
    return ids.map((id) => probs[id] ?? 0);
  } catch (error) {
    addUsage(key).failures += 1;
    keepRaw(`${key}:errors`, { q: item.q, error: error.message });
    return candidates.map(() => null);
  }
}

// --- run --------------------------------------------------------------------
if (!token) console.warn("ADMIN_TOKEN yok: yalnız arama taban çizgileri ölçülecek.");
const rows = [];
for (const [n, item] of cases.entries()) {
  const row = { q: item.q, set: item.set, expect: item.expect, ref: item.ref ?? null, rankings: {}, probs: {} };
  try {
    const [hybrid, lexical, extractive] = await Promise.all([
      search(item.q, true),
      search(item.q, false),
      answer(item.q).catch(() => null),
    ]);
    row.ranking_mode = hybrid.ranking ?? null;
    const candidates = hybrid.results.map(candidateOf);
    row.candidates = candidates.map((c) => ({ id: c.id, ref: c.ref }));
    row.rankings.lexical = lexical.results.map(candidateOf);
    row.rankings.hybrid = candidates;
    if (extractive) {
      const top = extractive.quotes?.[0];
      row.answer_baseline = {
        confidence: extractive.confidence,
        correct: Boolean(top && top.document_id === item.expect && (!item.ref || top.ref === item.ref || (top.ref ?? "").startsWith(`${item.ref} `))),
      };
    }
    if (token && candidates.length) {
      for (const model of models) {
        for (const mode of modes) {
          const key = `${model}:${mode}`;
          if (quotaHit) continue;
          const probs = mode === "list" ? await listwise(model, item, candidates) : await pointwise(model, item, candidates);
          row.probs[key] = probs;
          if (probs.every((p) => p === null)) continue;
          row.rankings[key] = candidates
            .map((c, i) => ({ c, i, p: probs[i] ?? -1 }))
            .sort((a, b) => b.p - a.p || a.i - b.i)
            .map(({ c }) => c);
        }
      }
    }
  } catch (error) {
    row.error = error.message;
  }
  rows.push(row);
  const mark = (key) => {
    const top = row.rankings[key]?.[0];
    return top ? (isArticle(top, item) ? "A" : isDoc(top, item) ? "d" : "·") : "-";
  };
  const keys = ["lexical", "hybrid", ...models.flatMap((m) => modes.map((x) => `${m}:${x}`))];
  console.log(`${String(n + 1).padStart(3)} ${keys.map(mark).join("")}  ${item.q}${row.error ? `  ERR ${row.error}` : ""}`);
}

// --- metrics ----------------------------------------------------------------
const rankers = [...new Set(rows.flatMap((r) => Object.keys(r.rankings)))];
function rankMetrics(key, subset) {
  const scored = subset.filter((r) => r.rankings[key]);
  if (!scored.length) return null;
  let hit1 = 0, mrr = 0, art1 = 0, artCases = 0;
  for (const r of scored) {
    const list = r.rankings[key];
    const rank = list.findIndex((c) => isDoc(c, r)) + 1;
    if (rank === 1) hit1 += 1;
    if (rank) mrr += 1 / rank;
    if (r.ref) {
      artCases += 1;
      if (list[0] && isArticle(list[0], r)) art1 += 1;
    }
  }
  return { n: scored.length, hit1: hit1 / scored.length, mrr: mrr / scored.length, article1: artCases ? art1 / artCases : null, articleCases: artCases };
}

function calibration(pairs) {
  // pairs: [p, correct]
  if (!pairs.length) return null;
  const brier = pairs.reduce((s, [p, y]) => s + (p - (y ? 1 : 0)) ** 2, 0) / pairs.length;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  for (const [p, y] of pairs) {
    const b = bins[Math.min(9, Math.floor(p * 10))];
    b.n += 1;
    b.p += p;
    b.y += y ? 1 : 0;
  }
  const ece = bins.reduce((s, b) => s + (b.n ? (b.n / pairs.length) * Math.abs(b.p / b.n - b.y / b.n) : 0), 0);
  const abstention = [0.3, 0.5, 0.7, 0.9].map((tau) => {
    const answered = pairs.filter(([p]) => p >= tau);
    const right = answered.filter(([, y]) => y).length;
    return { tau, coverage: answered.length / pairs.length, precision: answered.length ? right / answered.length : null };
  });
  return { n: pairs.length, brier, ece, abstention };
}

// Top-1 probability vs. whether the top passage is right (article level when
// the case names an article, otherwise document level).
function topPairs(key) {
  return rows
    .filter((r) => r.rankings[key] && r.probs[key])
    .map((r) => {
      const top = r.rankings[key][0];
      const i = r.rankings.hybrid.indexOf(top);
      const p = r.probs[key][i];
      return p === null || p === undefined ? null : [Math.max(0, Math.min(1, p)), isArticle(top, r)];
    })
    .filter(Boolean);
}
const CONF = { high: 0.85, medium: 0.55, low: 0.2 };
const baselinePairs = rows.filter((r) => r.answer_baseline).map((r) => [CONF[r.answer_baseline.confidence] ?? 0.2, r.answer_baseline.correct]);

const subsets = { tümü: rows, "doğal dil": rows.filter((r) => r.set === "questions"), "anahtar kelime": rows.filter((r) => r.set === "keywords") };
const report = {
  base,
  generated_at: new Date().toISOString(),
  settings: { models, modes, topK, lang, sets, cases: rows.length },
  ranking_mode: [...new Set(rows.map((r) => r.ranking_mode))],
  ceiling_recall_at_k: rows.filter((r) => r.candidates?.some((c) => c.id === r.expect)).length / rows.length,
  ranking: Object.fromEntries(Object.entries(subsets).map(([name, subset]) => [name, Object.fromEntries(rankers.map((k) => [k, rankMetrics(k, subset)]))])),
  calibration: {
    "answer-confidence (bugün)": calibration(baselinePairs),
    ...Object.fromEntries(rankers.filter((k) => k.includes(":")).map((k) => [k, calibration(topPairs(k))])),
  },
  usage,
  quota_stop: quotaHit?.message ?? null,
  raw,
  rows,
};
writeFileSync(outPath, JSON.stringify(report, null, 1));

const pct = (x) => (x === null || x === undefined ? "–" : `${(x * 100).toFixed(1)}%`);
const md = [];
md.push(`## Clef ölçümü`, "");
md.push(`${rows.length} soru · aday sayısı ${topK} · talimat dili ${lang} · arama modu ${report.ranking_mode.join(", ")}`);
md.push(`Aday listesinde doğru belge bulunma oranı (Clef'in ulaşabileceği tavan): **${pct(report.ceiling_recall_at_k)}**`);
if (report.quota_stop) md.push("", `> Kota/limit nedeniyle Clef çağrıları durdu: ${report.quota_stop}`);
for (const [name, table] of Object.entries(report.ranking)) {
  md.push("", `### Sıralama — ${name}`, "", "| Sıralayıcı | n | belge hit@1 | MRR | madde hit@1 |", "|---|---|---|---|---|");
  for (const [k, m] of Object.entries(table)) if (m) md.push(`| ${k} | ${m.n} | ${pct(m.hit1)} | ${m.mrr.toFixed(3)} | ${pct(m.article1)} (${m.articleCases}) |`);
}
md.push("", "### Güven kalibrasyonu (ilk sonuç doğru mu?)", "", "| Kaynak | n | Brier ↓ | ECE ↓ | p≥0.5 kapsam / isabet | p≥0.7 kapsam / isabet | p≥0.9 kapsam / isabet |", "|---|---|---|---|---|---|---|");
for (const [k, c] of Object.entries(report.calibration)) {
  if (!c) continue;
  const at = (tau) => {
    const a = c.abstention.find((x) => x.tau === tau);
    return `${pct(a.coverage)} / ${pct(a.precision)}`;
  };
  md.push(`| ${k} | ${c.n} | ${c.brier.toFixed(3)} | ${c.ece.toFixed(3)} | ${at(0.5)} | ${at(0.7)} | ${at(0.9)} |`);
}
md.push("", "### Maliyet ve gecikme", "", "| Çağrı | adet | hata | çözümlenemeyen | ort. ms | girdi token | çıktı token |", "|---|---|---|---|---|---|---|");
for (const [k, u] of Object.entries(usage)) {
  md.push(`| ${k} | ${u.calls} | ${u.failures} | ${u.unparsed} | ${u.calls ? Math.round(u.ms / Math.max(1, u.calls - u.failures)) : "–"} | ${u.prompt_tokens} | ${u.completion_tokens} |`);
}
md.push("", "<details><summary>Ham yanıt örnekleri</summary>", "", "```json");
for (const [k, list] of Object.entries(raw)) md.push(`// ${k}`, JSON.stringify(list[0]?.response ?? list[0]).slice(0, 1200));
md.push("```", "</details>");
const text = md.join("\n");
console.log("\n" + text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
