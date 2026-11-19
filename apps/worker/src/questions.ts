/**
 * Synthetic citizen questions per article (doc2query, OPUS-GOREVLER-5 item 6).
 *
 * POST /admin/questions (admin token) takes a few articles, asks gpt-oss-20b
 * for one-sentence everyday questions each article answers, and returns them.
 * The generator sees only the article text: never the eval question sets.
 *
 * Spend is capped for the whole job, not per day: every call reserves its
 * worst case on a D1 counter before it runs and is settled with the model's
 * reported token use afterwards. Above QUESTIONS_NEURON_CAP (default 240,000
 * neurons, about $2.64 at $0.011 per 1K) the endpoint refuses with 429.
 */

/**
 * Models to choose from ($ per M input / output tokens, Workers AI pricing
 * page 19 Nov 2026). The 19 Nov pilot with gpt-oss-20b gave odd Turkish and
 * empty answers for whole batches, so the choice is measured on samples first.
 */
export const QUESTION_MODELS = {
  "20b": { id: "@cf/openai/gpt-oss-20b", input: 0.2, output: 0.3, api: "responses" },
  qwen3: { id: "@cf/qwen/qwen3-30b-a3b-fp8", input: 0.051, output: 0.335, api: "chat" },
  gemma3: { id: "@cf/google/gemma-3-12b-it", input: 0.345, output: 0.556, api: "chat" },
} as const;
export type QuestionModel = keyof typeof QUESTION_MODELS;
export const DEFAULT_QUESTION_MODEL: QuestionModel = "20b";
/** Steve's limit on 19 Nov 2026 was $3 in all; 240K neurons leave room for the day's normal traffic. */
export const DEFAULT_QUESTIONS_NEURON_CAP = 240_000;
export const ARTICLES_PER_CALL = 4;
const ARTICLE_CHARS = 1200;
const MAX_OUTPUT_TOKENS = 900;
const COUNTER_DAY = "total";
const COUNTER_KEY = "questions-cn"; // hundredths of a neuron

export const QUESTIONS_PROMPT = [
  "Sana numaralı KKTC mevzuat maddeleri verilecek.",
  "Her madde için, maddenin cevapladığı en fazla 3 ayrı konuyu bul ve her biri için sıradan bir vatandaşın günlük dille soracağı tek cümlelik bir soru yaz.",
  "Kurallar: madde numarası, yasa adı veya 'bu madde', 'bu yasa' gibi ifadeler kullanma; hukuk terimi yerine halkın kullandığı kelimeleri seç; soru maddede cevabı olan bir şeyi sormalı.",
  "Madde yalnızca tanım, kısa isim, yürürlük, yürütme ya da kaldırma hükmüyse o madde için hiçbir şey yazma.",
  "Çıktı biçimi: her satıra bir soru, başında maddenin numarası ve iki nokta (örnek biçim: '2: ... ?'). Başka hiçbir şey yazma.",
].join("\n");

export interface QuestionItem {
  id: string;
  text: string;
}

function usageTokens(output: unknown, inputChars: number): { input: number; output: number; estimated: boolean } {
  const u = (output as { usage?: Record<string, unknown> } | null)?.usage ?? {};
  const input = Number(u.input_tokens ?? u.prompt_tokens);
  const out = Number(u.output_tokens ?? u.completion_tokens);
  if (Number.isFinite(input) && Number.isFinite(out) && input > 0) return { input, output: out, estimated: false };
  // No usage reported: charge the worst case (2 characters per token, full output).
  return { input: Math.ceil(inputChars / 2), output: MAX_OUTPUT_TOKENS, estimated: true };
}

/** $0.011 per 1K neurons. */
const neuronsOf = (model: QuestionModel, t: { input: number; output: number }) =>
  (t.input * QUESTION_MODELS[model].input + t.output * QUESTION_MODELS[model].output) / 0.011 / 1000;

/** Adds `centi` (may be negative) to the job counter and returns the new total. */
async function addSpent(db: D1Database, centi: number): Promise<number> {
  const bump = () =>
    db
      .prepare(
        "INSERT INTO usage_counters (day, key, n) VALUES (?, ?, ?) " +
          "ON CONFLICT(day, key) DO UPDATE SET n = n + excluded.n RETURNING n",
      )
      .bind(COUNTER_DAY, COUNTER_KEY, centi)
      .first<{ n: number }>();
  let row: { n: number } | null;
  try {
    row = await bump();
  } catch (error) {
    if (!/no such table/i.test(String(error))) throw error;
    await db
      .prepare("CREATE TABLE IF NOT EXISTS usage_counters (day TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, key))")
      .run();
    row = await bump();
  }
  const n = Number(row?.n);
  if (!Number.isFinite(n)) throw new Error("questions counter unreadable");
  return n;
}

/** Lines "2: ...?" -> questions per article number (1-based); references to the text itself are dropped. */
export function parseQuestions(text: string, count: number): string[][] {
  const out: string[][] = Array.from({ length: count }, () => []);
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*[[(]?(\d+)[\]).:-]+\s*(.+)$/.exec(raw);
    if (!m) continue;
    const i = Number(m[1]) - 1;
    let q = m[2].replace(/^[-*•\s]+/, "").replace(/\s+/g, " ").trim();
    if (i < 0 || i >= count || !q.endsWith("?") || q.length < 15 || q.length > 200) continue;
    if (/\b(bu|işbu|söz konusu)\s+(madde|yasa|tüzük|fıkra)|\bmadde\s*\d|\d+\/\d{4}|\bfasıl\s*\d/iu.test(q)) continue;
    if (out[i].length < 3 && !out[i].includes(q)) out[i].push(q);
  }
  return out;
}

export async function handleQuestions(request: Request, env: { AI?: Ai; DB: D1Database; QUESTIONS_NEURON_CAP?: string }): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!env.AI) return json({ error: "ai_unavailable" }, 501);
  const cap = Number(env.QUESTIONS_NEURON_CAP ?? DEFAULT_QUESTIONS_NEURON_CAP);
  const body = (await request.json().catch(() => null)) as { items?: QuestionItem[]; model?: string; debug?: boolean } | null;
  const model: QuestionModel = body?.model && body.model in QUESTION_MODELS ? (body.model as QuestionModel) : DEFAULT_QUESTION_MODEL;
  const spec = QUESTION_MODELS[model];
  const items = (body?.items ?? []).filter((x) => x && typeof x.id === "string" && typeof x.text === "string");
  if (!items.length || items.length > ARTICLES_PER_CALL) {
    return json({ error: "invalid_items", message: `1-${ARTICLES_PER_CALL} items` }, 400);
  }
  const input = items.map((x, i) => `[${i + 1}]\n${x.text.slice(0, ARTICLE_CHARS)}`).join("\n\n");
  // Reserve the worst case first, so concurrent calls can never pass the cap.
  const reserve = Math.ceil(neuronsOf(model, { input: Math.ceil((input.length + QUESTIONS_PROMPT.length) / 2), output: MAX_OUTPUT_TOKENS }) * 100);
  const after = await addSpent(env.DB, reserve);
  if (after > cap * 100) {
    const spent = await addSpent(env.DB, -reserve);
    return json({ error: "budget", spent: spent / 100, cap }, 429);
  }
  let output: unknown;
  try {
    output = await env.AI.run(
      spec.id as Parameters<Ai["run"]>[0],
      (spec.api === "responses"
        ? { instructions: QUESTIONS_PROMPT, input, reasoning: { effort: "low" }, max_output_tokens: MAX_OUTPUT_TOKENS }
        : {
            // One user turn (Gemma has no system role); Qwen3 without its thinking step.
            messages: [{ role: "user", content: `${QUESTIONS_PROMPT}\n\n${input}${model === "qwen3" ? "\n\n/no_think" : ""}` }],
            max_tokens: MAX_OUTPUT_TOKENS,
            temperature: 0.3,
          }) as never,
    );
  } catch (error) {
    // A failed call may still have been billed: keep the reservation.
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: "model_error", message: message.slice(0, 300) }, /quota|neuron|limit|429/i.test(message) ? 429 : 502);
  }
  const tokens = usageTokens(output, input.length + QUESTIONS_PROMPT.length);
  const actual = Math.ceil(neuronsOf(model, tokens) * 100);
  const spent = await addSpent(env.DB, actual - reserve);
  const text = modelOutputText(output).replace(/<think>[\s\S]*?<\/think>/g, "");
  const parsed = parseQuestions(text, items.length);
  return json({
    results: items.map((x, i) => ({ id: x.id, questions: parsed[i] })),
    tokens,
    model,
    neurons: actual / 100,
    spent: spent / 100,
    cap,
    ...(body?.debug ? { raw: text.slice(0, 3000) } : {}),
  });
}

/** Text of a Workers AI Responses API result (message parts), or the classic "response". */
function modelOutputText(output: unknown): string {
  const o = output as { response?: unknown; output?: unknown; output_text?: unknown } | null;
  if (typeof o?.output_text === "string") return o.output_text;
  if (Array.isArray(o?.output)) {
    const parts: string[] = [];
    for (const item of o!.output as { type?: string; content?: { type?: string; text?: string }[] }[]) {
      if (item?.type !== "message") continue;
      for (const c of item.content ?? []) if (typeof c?.text === "string") parts.push(c.text);
    }
    if (parts.length) return parts.join("\n");
  }
  return typeof o?.response === "string" ? o.response : "";
}
