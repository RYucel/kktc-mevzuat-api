// Measures the LLM rewrite alone (no search, no Clef): for every answerable
// eval question, do the statute names the LLM gives resolve to the expected
// statute, and how often do they resolve only to unrelated ones?
//
//   BASE=https://... ADMIN_TOKEN=... PROMPTS=v1,v2 node scripts/eval-rewrite.mjs
//
// Uses GET /admin/rewrite (admin token; counted on the admin LLM budget).
// New prompt versions call the LLM once per question; repeats are cached.

import { readFileSync, appendFileSync } from "node:fs";

const base = (process.env.BASE ?? "http://localhost:8787").replace(/\/$/, "");
const token = process.env.ADMIN_TOKEN ?? "";
const prompts = (process.env.PROMPTS || "v1,v2").split(",").map((p) => p.trim()).filter(Boolean);
const cases = JSON.parse(readFileSync(new URL("./eval-questions.json", import.meta.url), "utf8")).cases.filter((c) => !c.unanswerable);
const expected = (c) => [c.expect, ...(c.alt ?? []).map((a) => a.expect)];

async function rewrite(q, prompt) {
  const url = `${base}/admin/rewrite?q=${encodeURIComponent(q)}&prompt=${prompt}`;
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (response.ok) return response.json();
    if (attempt >= 2 || response.status < 500) throw new Error(`HTTP ${response.status}`);
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
}

const summary = {};
const rows = [];
for (const c of cases) {
  const row = { q: c.q, expect: c.expect, by: {} };
  for (const prompt of prompts) {
    try {
      const info = await rewrite(c.q, prompt);
      const want = expected(c);
      const docs = info.documents ?? [];
      const strong = info.strong_documents ?? [];
      row.by[prompt] = {
        laws: info.laws,
        docs,
        strong,
        hit: docs.some((d) => want.includes(d)),
        strong_hit: strong.some((d) => want.includes(d)),
        unrelated: docs.length > 0 && !docs.some((d) => want.includes(d)),
        strong_unrelated: strong.length > 0 && !strong.some((d) => want.includes(d)),
        empty: docs.length === 0,
        error: info.error ?? null,
      };
    } catch (error) {
      row.by[prompt] = { error: error.message };
    }
  }
  rows.push(row);
  console.log(prompts.map((p) => (row.by[p].error ? "x" : row.by[p].strong_hit ? "S" : row.by[p].hit ? "h" : row.by[p].unrelated ? "!" : "·")).join(""), c.q);
}

const md = ["## LLM çevirisi: yasa adları", "", `${cases.length} cevaplı soru. S = güçlü eşleşme beklenen yasayı buldu, h = zayıf eşleşme buldu, ! = yalnızca alakasız belgelere çözüldü, · = ad yok.`, ""];
md.push("| İstem | beklenen yasa bulundu | güçlü eşleşmeyle | yalnızca alakasız | güçlü ama alakasız | ad yok | hata |", "|---|---|---|---|---|---|---|");
for (const prompt of prompts) {
  const v = rows.map((r) => r.by[prompt]).filter((x) => x && !x.error && !x.error);
  const n = rows.length;
  const count = (k) => v.filter((x) => x[k]).length;
  summary[prompt] = { hit: count("hit"), strong_hit: count("strong_hit"), unrelated: count("unrelated"), strong_unrelated: count("strong_unrelated"), empty: count("empty") };
  md.push(`| ${prompt} | ${count("hit")}/${n} | ${count("strong_hit")}/${n} | ${count("unrelated")}/${n} | ${count("strong_unrelated")}/${n} | ${count("empty")}/${n} | ${rows.filter((r) => r.by[prompt]?.error).length} |`);
}
for (const prompt of prompts) {
  md.push("", `### ${prompt}: adlar ve çözüm (beklenen bulunmayanlar)`, "", "| Soru | Beklenen | LLM adları | Çözülen (güçlü*) |", "|---|---|---|---|");
  for (const r of rows) {
    const x = r.by[prompt];
    if (!x || x.error || x.hit) continue;
    md.push(`| ${r.q} | ${r.expect} | ${JSON.stringify(x.laws ?? [])} | ${x.docs.map((d) => (x.strong.includes(d) ? `${d}*` : d)).join(", ") || "–"} |`);
  }
}
const text = md.join("\n");
console.log("\n" + text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
