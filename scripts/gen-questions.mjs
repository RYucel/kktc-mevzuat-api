// Synthetic citizen questions per article (OPUS-GOREVLER-5 item 6), through
// the Worker's POST /admin/questions (gpt-oss-20b, spend capped there).
//
// Reads the vector units (one per article) and the questions made so far,
// asks for the articles still missing, and writes questions.jsonl.gz:
//   {"key", "doc_id", "ref", "questions": [...]}
// key = sha1(doc_id | ref | article body), the body as in the units file
// without the questions suffix (crawler/kktc/vectors.py computes the same).
// The generator only ever sees article text, never the eval question sets.
//
// Env: BASE, ADMIN_TOKEN, UNITS (data/vector-units.jsonl.gz),
// OUT (data/questions.jsonl.gz), LIMIT (articles this run, 0 = all),
// CONCURRENCY (parallel calls, default 2), MODEL (20b, qwen3, gemma3),
// SAMPLE=1: 16 articles spread over the list, printed and not saved (to
// compare models).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

const base = process.env.BASE ?? "https://kktc-mevzuat-api.stevevaius.workers.dev";
const token = process.env.ADMIN_TOKEN;
if (!token) throw new Error("ADMIN_TOKEN missing");
const unitsPath = process.env.UNITS ?? "data/vector-units.jsonl.gz";
const outPath = process.env.OUT ?? "data/questions.jsonl.gz";
const limit = Number(process.env.LIMIT ?? 0);
const concurrency = Math.max(1, Number(process.env.CONCURRENCY ?? 2));
const PER_CALL = 4;
const model = process.env.MODEL || undefined;
const sampleMode = process.env.SAMPLE === "1";
const SUFFIX = "\nSık sorulanlar:";

const readJsonl = (path) =>
  gunzipSync(readFileSync(path))
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

export const bodyOf = (text) => {
  const i = text.indexOf("\n");
  const body = i >= 0 ? text.slice(i + 1) : "";
  const j = body.indexOf(SUFFIX);
  return j >= 0 ? body.slice(0, j) : body;
};
export const keyOf = (u) => createHash("sha1").update(`${u.doc_id}|${u.ref ?? ""}|${bodyOf(u.text)}`, "utf8").digest("hex");

// Laws and the KKTC constitution; no stubs, definitions, short titles,
// commencement, execution or repeal articles (nothing a citizen asks).
const SKIP = /kısa\s+isim|tefsir|tanımlar|yürürlüğe\s+giriş|yürütme\s+yetkisi|kaldırılmıştır|kaldırma\s+ve\s+saklama|^\s*kaldırma/iu;
const wanted = (u) =>
  (u.type === "yasa" || u.doc_id === "anayasa-kktc-anayasasi") && bodyOf(u.text).length >= 150 && !SKIP.test(bodyOf(u.text).slice(0, 120));

const units = readJsonl(unitsPath).filter(wanted);
// Consolidated government texts first (those are quoted), then document order.
units.sort((a, b) => (a.source !== "gov") - (b.source !== "gov") || a.doc_id.localeCompare(b.doc_id) || Number(a.ord) - Number(b.ord));

const done = new Map();
// FRESH=1: start over (a new model or prompt), replacing the file at the end.
if (existsSync(outPath) && process.env.FRESH !== "1") for (const row of readJsonl(outPath)) done.set(row.key, row);
const todo = units.filter((u) => !done.has(keyOf(u)));
const step = Math.floor(units.length / 16);
const batch = sampleMode ? units.filter((_, i) => i % step === 7).slice(0, 16) : limit > 0 ? todo.slice(0, limit) : todo;
console.log(`articles wanted ${units.length}, done before ${units.length - todo.length}, this run ${batch.length}`);

const save = () => {
  if (sampleMode) return;
  const lines = [...done.values()].map((row) => JSON.stringify(row)).join("\n");
  writeFileSync(outPath, gzipSync(Buffer.from(lines + "\n", "utf8")));
};

let stopped = null;
let calls = 0;
let neurons = 0;
let spent = null;
let made = 0;
let failed = 0;
const groups = [];
for (let i = 0; i < batch.length; i += PER_CALL) groups.push(batch.slice(i, i + PER_CALL));

async function call(group) {
  const items = group.map((u) => ({ id: keyOf(u), text: u.text.split(SUFFIX)[0] }));
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${base}/admin/questions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ items, model, debug: sampleMode }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) return body;
    if (response.status === 429) {
      stopped = body.error === "budget" ? `budget (spent ${body.spent} of ${body.cap})` : `429 ${body.message ?? ""}`;
      return null;
    }
    if (attempt >= 2) {
      failed += group.length;
      console.log(`call failed: HTTP ${response.status} ${(body.message ?? body.error ?? "").slice(0, 120)}`);
      return null;
    }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
}

let next = 0;
async function worker() {
  while (!stopped && next < groups.length) {
    const group = groups[next++];
    const body = await call(group);
    if (!body) continue;
    calls += 1;
    neurons += body.neurons;
    spent = body.spent;
    if (sampleMode) {
      for (const [i, r] of body.results.entries()) console.log(`${group[i].doc_id} ${group[i].ref}: ${r.questions.join(" | ") || "(boş)"}`);
      if (body.results.some((r) => !r.questions.length)) console.log(`  ham çıktı: ${JSON.stringify(body.raw ?? "").slice(0, 600)}`);
      console.log(`  tokens ${JSON.stringify(body.tokens)}, ${body.neurons} neurons`);
    }
    for (const [i, r] of body.results.entries()) {
      const u = group[i];
      done.set(r.id, { key: r.id, doc_id: u.doc_id, ref: u.ref, questions: r.questions });
      made += r.questions.length;
    }
    if (calls % 50 === 0) {
      save();
      console.log(`${calls} calls, ${(neurons / calls / PER_CALL).toFixed(2)} neurons/article, job total ${spent}`);
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
save();

const articles = calls * PER_CALL;
console.log(
  JSON.stringify(
    {
      calls,
      questions: made,
      neurons_this_run: Number(neurons.toFixed(1)),
      neurons_per_article: articles ? Number((neurons / articles).toFixed(2)) : null,
      job_spent: spent,
      failed_articles: failed,
      remaining: units.filter((u) => !done.has(keyOf(u))).length,
      stopped,
    },
    null,
    2,
  ),
);
// A few samples to check quality (generated from article text only).
const sample = [...done.values()].filter((r) => r.questions.length).slice(-4);
for (const r of sample) console.log(`${r.doc_id} ${r.ref}: ${r.questions.join(" | ")}`);
