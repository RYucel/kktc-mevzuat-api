import {
  clefNeurons,
  GEMINI_DECISION_MODEL,
  geminiDecisionInput,
  parseRerank,
  askInput,
  parseAsk,
  clefReranker,
  createApp,
  DECISION_MODELS,
  parseRewrite,
  type QueryRewriter,
  queryText,
  DEFAULT_REWRITE_PROMPT,
  REWRITE_PROMPTS,
  RewriteLimitError,
  SEMANTIC_MODEL,
  type SemanticHit,
  timingSafeEqual,
  type Reranker,
  type FeedbackEntry,
  RerankLimitError,
  rerankInput,
  type SemanticIndex,
  type Store,
  type StoreRow,
  truncateEmbedding,
  type VectorUnit,
  type VectorWriter,
} from "@kktc/core";
import { DEFAULT_GATE_PER_MINUTE, gateExempt, passGate } from "./gate";

export { TrafficGate } from "./gate";

export interface Env {
  DB: D1Database;
  /** Workers AI (embeddings). Optional: without it search stays lexical. */
  AI?: Ai;
  /** Vectorize index of legislation articles (see .github/workflows/vectors.yml). */
  VECTORS?: Vectorize;
  /** Bearer token for /admin/vectors/*; set by the vectors workflow. */
  VECTOR_ADMIN_TOKEN?: string;
  /** "off" disables Clef answer reranking. */
  RERANK?: string;
  /** Clef neurons allowed per UTC day (default 8000, inside the free Workers AI allocation). */
  CLEF_DAILY_NEURONS?: string;
  /** Clef neurons per UTC day for our own jobs (admin token: evals, smoke), counted apart (default 12000). */
  CLEF_ADMIN_DAILY_NEURONS?: string;
  /** "off" disables the LLM query rewrite. */
  REWRITE?: string;
  /** Workers AI model for the query rewrite (default @cf/openai/gpt-oss-20b). */
  REWRITE_MODEL?: string;
  /** Rewrites per UTC day for users (default 400) and for our own jobs (default 600). */
  REWRITE_DAILY_LIMIT?: string;
  REWRITE_ADMIN_DAILY_LIMIT?: string;
  /** /admin/decide calls per UTC day (default 300). */
  DECIDE_ADMIN_DAILY_LIMIT?: string;
  /**
   * Gemini Decisions API key (measurement only): admin requests with
   * decider=gemini use it instead of Clef, so user questions never go to Google.
   */
  GEMINI_API_KEY?: string;
  /** Gemini decision calls per UTC day (default 3000; admin only). */
  GEMINI_ADMIN_DAILY_LIMIT?: string;
  /** Per-client request limit (wrangler.toml [[ratelimits]]). */
  RATE_LIMITER?: RateLimit;
  /** Global per-minute circuit breaker (Durable Object, see gate.ts). */
  GATE?: DurableObjectNamespace;
  /** Requests reaching D1 allowed per minute across the Worker (default 100). */
  GATE_PER_MINUTE?: string;
}

/**
 * The Clef budget is counted in neurons, not calls: the statute choice over
 * cards and the table-of-contents step make calls of very different sizes
 * (OPUS-GOREVLER-3 item 6). 8000 neurons are what ~1000 average calls
 * (~2.3K tokens each, 3,455 neurons per M tokens) used, inside the 10K free
 * daily neurons with room for query embeddings and the weekly vector sync.
 * Above the limit answers keep the search order, so Clef can never put a
 * Workers AI charge on the bill.
 */
const DEFAULT_CLEF_DAILY_NEURONS = 8000;
/**
 * Our own measurement jobs (admin token) count on a separate counter, so an
 * eval run can never use up the users' daily Clef budget (it did on
 * 2026-11-09). On eval days the two together may pass the free 10K neurons:
 * 12K neurons are about $0.13 at $0.011 per 1K neurons (the old 1500 calls).
 */
const DEFAULT_CLEF_ADMIN_DAILY_NEURONS = 12000;
/** The neuron counters keep hundredths of a neuron (D1 stores integers). */
const CENTI = 100;
/** /admin/decide calls per UTC day (eval-clef measurements; ~2.3K tokens each). */
const DEFAULT_DECIDE_ADMIN_DAILY_LIMIT = 300;

/** Daily counter in D1 (one small write per call); `amount` is added before the check. */
async function takeDaily(db: D1Database, key: string, limit: number, amount = 1): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const bump = () =>
    db
      .prepare(
        "INSERT INTO usage_counters (day, key, n) VALUES (?, ?, ?) " +
          "ON CONFLICT(day, key) DO UPDATE SET n = n + excluded.n RETURNING n",
      )
      .bind(day, key, amount)
      .first<{ n: number }>();
  let row: { n: number } | null;
  try {
    row = await bump();
  } catch (error) {
    if (!/no such table/i.test(String(error))) throw error;
    // Created by the D1 schema on the next data import; until then, here.
    await db
      .prepare("CREATE TABLE IF NOT EXISTS usage_counters (day TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, key))")
      .run();
    row = await bump();
  }
  return Number(row?.n ?? Infinity) <= limit;
}

const DEFAULT_GEMINI_ADMIN_DAILY_LIMIT = 3000;
const GEMINI_TIMEOUT_MS = 15000;

/**
 * Gemini Decisions API as the decision model, for comparing with Clef on our
 * own eval questions. Counted per day, fail-closed; a rate-limit answer is
 * retried after a pause (free tier: 200 requests and 50K tokens a minute).
 */
function geminiReranker(apiKey: string, db: D1Database, limit: number): Reranker {
  const call = async (input: Record<string, unknown>): Promise<unknown> => {
    let allowed: boolean;
    try {
      allowed = limit > 0 && (await takeDaily(db, "gemini-admin", limit));
    } catch (error) {
      throw new Error(`gemini counter unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!allowed) throw new RerankLimitError("Gemini daily limit reached");
    const body = JSON.stringify(input);
    for (let attempt = 0; ; attempt++) {
      const response = await fetch("https://generativelanguage.googleapis.com/v1beta/decisions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body,
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      });
      if (response.ok) return response.json();
      const text = (await response.text()).slice(0, 300);
      const limited = response.status === 429 || /quota|rate|limit/i.test(text);
      if (!limited || attempt >= 3) throw new Error(`Gemini HTTP ${response.status}: ${text}`);
      await new Promise((resolve) => setTimeout(resolve, 15000 * (attempt + 1)));
    }
  };
  return {
    async rerank(question, candidates, options) {
      const result = parseRerank(await call(geminiDecisionInput(question, candidates, options)), candidates.length, GEMINI_DECISION_MODEL);
      if (!result) throw new Error("Gemini yanıtı çözümlenemedi.");
      return result;
    },
    async ask(state, questions) {
      const clef = askInput(state, questions) as { questions: unknown };
      const output = await call({ model: GEMINI_DECISION_MODEL, input: JSON.stringify(state), questions: clef.questions });
      const result = parseAsk(output, Object.keys(questions));
      if (!result) throw new Error("Gemini evet/hayır yanıtı çözümlenemedi.");
      return result;
    },
  };
}

/** Clef use of one request (sent back as x-clef-calls and x-clef-neurons). */
interface ClefMeter {
  calls: number;
  neurons: number;
}

/**
 * Clef calls are charged before they run, from the request size (see
 * clefNeurons: characters / 3 as tokens, plus the short choice answer).
 */
function limitedReranker(inner: Reranker, db: D1Database, neuronLimit: number, key: string, meter: ClefMeter): Reranker {
  const charge = async (input: Record<string, unknown>): Promise<number> => {
    const neurons = clefNeurons(input);
    let allowed: boolean;
    try {
      allowed = await takeDaily(db, key, Math.round(neuronLimit * CENTI), Math.max(1, Math.ceil(neurons * CENTI)));
    } catch (error) {
      // Without a working counter, do not spend: fail closed (reported as
      // "unavailable", not "daily_limit").
      console.warn("clef counter unavailable:", error instanceof Error ? error.message : error);
      throw new Error(`Clef counter unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!allowed) throw new RerankLimitError();
    meter.calls += 1;
    meter.neurons += neurons;
    return neurons;
  };
  return {
    async rerank(question, candidates, options) {
      await charge(rerankInput(question, candidates, options));
      return inner.rerank(question, candidates, options);
    },
    ...(inner.ask
      ? {
          async ask(state: Record<string, unknown>, questions: Record<string, string>) {
            await charge(askInput(state, questions));
            return inner.ask!(state, questions);
          },
        }
      : {}),
  };
}

/**
 * Query rewrite with a Workers AI LLM (packages/core/src/rewrite.ts). One
 * short call (~450 input, a few hundred output tokens with low reasoning,
 * ~30-40 neurons with gpt-oss-120b); counted per day like Clef, fail-closed,
 * and cut off after REWRITE_TIMEOUT_MS so a slow model never holds the answer.
 */
/**
 * Measured 2026-11-09 (eval-answer, 62 questions, live Clef, rewrite in
 * parallel with the main search): gpt-oss-20b put the right article first in
 * 69.1% (120b: 67.3%, no rewrite: 52.7%), "high" right 36/42 (120b 35/40),
 * 5.3 s average against 7.2 s, at about half the neurons.
 */
const DEFAULT_REWRITE_MODEL = "@cf/openai/gpt-oss-20b";
/** Per-request choice (rewrite_model=20b|120b), for measuring speed against accuracy. */
const REWRITE_MODELS = { "20b": "@cf/openai/gpt-oss-20b", "120b": "@cf/openai/gpt-oss-120b" } as const;
const DEFAULT_REWRITE_DAILY_LIMIT = 400;
const DEFAULT_REWRITE_ADMIN_DAILY_LIMIT = 600;
const REWRITE_TIMEOUT_MS = 6000;

/** Text of a Workers AI text-generation result (Responses API or classic "response"). */
function modelText(output: unknown): string {
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
  if (typeof o?.response === "string") return o.response;
  if (o?.response && typeof o.response === "object") return JSON.stringify(o.response);
  return "";
}

/**
 * Rewrites are cached in D1 per (model, normalized question). The LLM gives a
 * slightly different answer on every call, and that alone moved article@1 by
 * up to 10 points between two eval runs on 2026-11-10; with the cache the
 * same question always searches with the same terms (and costs no LLM call).
 */
const REWRITE_CACHE_DAYS = 90;
const REWRITE_CACHE_TABLE =
  "CREATE TABLE IF NOT EXISTS rewrite_cache (model TEXT NOT NULL, q TEXT NOT NULL, terms TEXT NOT NULL, laws TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (model, q))";

function rewriteCacheKey(question: string): string {
  return question
    .toLocaleLowerCase("tr")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s?.!,;:]+$/u, "")
    .slice(0, 500);
}

async function readRewriteCache(db: D1Database, model: string, q: string) {
  try {
    const row = await db
      .prepare("SELECT terms, laws, created_at FROM rewrite_cache WHERE model = ? AND q = ?")
      .bind(model, q)
      .first<{ terms: string; laws: string; created_at: string }>();
    if (!row) return null;
    const age = Date.now() - Date.parse(row.created_at);
    if (!(age >= 0 && age < REWRITE_CACHE_DAYS * 86_400_000)) return null;
    const terms = JSON.parse(row.terms) as unknown;
    const laws = JSON.parse(row.laws) as unknown;
    if (!Array.isArray(terms) || !Array.isArray(laws)) return null;
    return { terms: terms.map(String), laws: laws.map(String), cached: true };
  } catch {
    return null; // no table yet, or a bad row: ask the model
  }
}

async function writeRewriteCache(db: D1Database, model: string, q: string, terms: string[], laws: string[]) {
  const write = () =>
    db
      .prepare("INSERT OR REPLACE INTO rewrite_cache (model, q, terms, laws, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(model, q, JSON.stringify(terms), JSON.stringify(laws), new Date().toISOString())
      .run();
  try {
    await write();
  } catch (error) {
    if (!/no such table/i.test(String(error))) throw error;
    await db.prepare(REWRITE_CACHE_TABLE).run();
    await write();
  }
}

function llmRewriter(ai: Ai, db: D1Database, model: string, limit: number, key: string): QueryRewriter {
  return {
    async rewrite(question, options) {
      const chosen = options?.model ? REWRITE_MODELS[options.model] : model;
      const prompt = options?.prompt ?? DEFAULT_REWRITE_PROMPT;
      // The prompt version is part of the cache key ("v1" keeps the old keys).
      const cacheModel = prompt === "v1" ? chosen : `${chosen}#${prompt}`;
      const cacheKey = rewriteCacheKey(question);
      const hit = await readRewriteCache(db, cacheModel, cacheKey);
      if (hit) return hit;
      let allowed: boolean;
      try {
        allowed = await takeDaily(db, key, limit);
      } catch (error) {
        throw new Error(`rewrite counter unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!allowed) throw new RewriteLimitError();
      const run = ai.run(chosen as Parameters<Ai["run"]>[0], {
        instructions: REWRITE_PROMPTS[prompt],
        input: `Soru: ${question.slice(0, 500)}`,
        reasoning: { effort: "low" },
      } as never);
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("rewrite timeout")), REWRITE_TIMEOUT_MS));
      const output = await Promise.race([run, timeout]);
      const parsed = parseRewrite(modelText(output));
      if (!parsed) throw new Error(`rewrite unparsable: ${modelText(output).slice(0, 200)}`);
      try {
        await writeRewriteCache(db, cacheModel, cacheKey, parsed.terms, parsed.laws);
      } catch (error) {
        console.warn("rewrite cache write failed:", error instanceof Error ? error.message : error);
      }
      return parsed;
    },
  };
}

function bearerIsAdmin(request: Request, env: Env): boolean {
  const token = env.VECTOR_ADMIN_TOKEN;
  const header = request.headers.get("authorization");
  return !!token && !!header && timingSafeEqual(header, `Bearer ${token}`);
}

/** 429 for clients over the per-minute limit; health, admin and our own jobs are exempt. */
async function rateLimited(request: Request, env: Env): Promise<Response | null> {
  if (!env.RATE_LIMITER) return null;
  const path = new URL(request.url).pathname;
  if (path === "/health" || path.startsWith("/admin/") || bearerIsAdmin(request, env)) return null;
  const client = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.RATE_LIMITER.limit({ key: client });
  if (success) return null;
  return new Response(
    JSON.stringify({
      error: {
        code: "rate_limited",
        message: "Çok fazla istek. Lütfen bir dakika sonra tekrar deneyin.",
      },
    }),
    { status: 429, headers: { "content-type": "application/json; charset=utf-8", "retry-after": "60" } },
  );
}

/** Verdicts per UTC day (POST /v1/feedback, MCP geri_bildirim). */
const DEFAULT_FEEDBACK_DAILY_LIMIT = 500;
const FEEDBACK_TABLE =
  "CREATE TABLE IF NOT EXISTS feedback (day TEXT NOT NULL, q_hash TEXT NOT NULL, document_id TEXT NOT NULL, ref TEXT, verdict TEXT NOT NULL, created_at TEXT NOT NULL)";

class D1Store implements Store {
  /** D1 rows read by this request (sent back as x-d1-rows-read). */
  rowsRead = 0;
  queries = 0;

  constructor(
    private readonly db: D1Database,
    readonly semantic?: SemanticIndex,
    readonly rerank?: Reranker,
    readonly rewriter?: QueryRewriter,
  ) {}

  async all(sql: string, binds: unknown[] = []): Promise<StoreRow[]> {
    let result: D1Result;
    try {
      result = await this.db.prepare(sql).bind(...binds).all();
    } catch (error) {
      // "D1 DB is overloaded. Too many resources consumed within a 10 second
      // window": a short burst; one retry after a pause usually succeeds.
      if (!/overloaded|Too many resources/i.test(String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 600));
      result = await this.db.prepare(sql).bind(...binds).all();
    }
    this.queries += 1;
    this.rowsRead += Number((result.meta as { rows_read?: number } | undefined)?.rows_read ?? 0);
    return (result.results ?? []) as StoreRow[];
  }

  /** One small write per verdict; capped per day, fail-closed. */
  async feedback(entry: FeedbackEntry): Promise<boolean> {
    const limit = this.feedbackLimit;
    let allowed: boolean;
    try {
      allowed = limit > 0 && (await takeDaily(this.db, "feedback", limit));
    } catch {
      return false;
    }
    if (!allowed) return false;
    const now = new Date().toISOString();
    const insert = () =>
      this.db
        .prepare("INSERT INTO feedback (day, q_hash, document_id, ref, verdict, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(now.slice(0, 10), entry.q_hash, entry.document_id, entry.ref, entry.verdict, now)
        .run();
    try {
      await insert();
    } catch (error) {
      if (!/no such table/i.test(String(error))) throw error;
      await this.db.prepare(FEEDBACK_TABLE).run();
      await insert();
    }
    return true;
  }

  feedbackLimit = DEFAULT_FEEDBACK_DAILY_LIMIT;

  async first(sql: string, binds: unknown[] = []): Promise<StoreRow | null> {
    // .all() rather than .first(): only .all() reports rows_read.
    const rows = await this.all(sql, binds);
    return rows[0] ?? null;
  }
}

async function embed(ai: Ai, texts: string[]): Promise<number[][]> {
  const output = (await ai.run(SEMANTIC_MODEL as Parameters<Ai["run"]>[0], { text: texts } as never)) as {
    data?: number[][];
  };
  if (!output?.data || output.data.length !== texts.length) {
    throw new Error("Workers AI returned no embeddings.");
  }
  return output.data.map((vector) => truncateEmbedding(vector));
}

class VectorizeSemantic implements SemanticIndex, VectorWriter {
  constructor(
    private readonly ai: Ai,
    private readonly index: Vectorize,
  ) {}

  async query(text: string, options: { topK: number; type?: string }): Promise<SemanticHit[]> {
    // The API rejects longer questions; this keeps any other caller bounded too.
    const [vector] = await embed(this.ai, [queryText(text.slice(0, 1000))]);
    const result = await this.index.query(vector, {
      topK: Math.min(options.topK, 50),
      returnMetadata: "all",
      ...(options.type ? { filter: { type: options.type } } : {}),
    });
    return result.matches.map((match) => {
      const metadata = (match.metadata ?? {}) as Record<string, unknown>;
      return {
        doc_id: String(metadata.doc_id ?? ""),
        ord: Number(metadata.ord ?? 0),
        ref: metadata.ref ? String(metadata.ref) : null,
        type: metadata.type ? String(metadata.type) : null,
        score: match.score,
      };
    }).filter((hit) => hit.doc_id);
  }

  async upsert(units: VectorUnit[]): Promise<number> {
    const vectors = await embed(this.ai, units.map((unit) => unit.text));
    await this.index.upsert(
      units.map((unit, i) => ({
        id: unit.id,
        values: vectors[i],
        metadata: { doc_id: unit.doc_id, ord: unit.ord, ref: unit.ref ?? "", type: unit.type },
      })),
    );
    return units.length;
  }

  async remove(ids: string[]): Promise<number> {
    // Small batches: a 500-id delete failed on 9 November 2026.
    for (let i = 0; i < ids.length; i += 100) {
      await this.index.deleteByIds(ids.slice(i, i + 100));
    }
    return ids.length;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const limited = await rateLimited(request, env);
    if (limited) return limited;
    const path = new URL(request.url).pathname;
    if (!gateExempt(path) && !bearerIsAdmin(request, env)) {
      const decision = await passGate(env.GATE, Number(env.GATE_PER_MINUTE ?? DEFAULT_GATE_PER_MINUTE));
      if (!decision.allowed) {
        return new Response(
          JSON.stringify({
            error: {
              code: "busy",
              message: "Hizmet şu an yoğun. Lütfen biraz sonra tekrar deneyin.",
              retry_after: decision.retryAfter,
            },
          }),
          {
            status: 503,
            headers: { "content-type": "application/json; charset=utf-8", "retry-after": String(decision.retryAfter) },
          },
        );
      }
    }
    const semantic = env.AI && env.VECTORS ? new VectorizeSemantic(env.AI, env.VECTORS) : undefined;
    const decide = env.AI
      ? (model: string, input: Record<string, unknown>) =>
          env.AI!.run(`@cf/cloudflare/${model}` as Parameters<Ai["run"]>[0], input as never)
      : undefined;
    // Clef answer reranking (see packages/core/src/rerank.ts); RERANK=off disables it.
    const admin = bearerIsAdmin(request, env);
    const clefLimit = admin
      ? Number(env.CLEF_ADMIN_DAILY_NEURONS ?? DEFAULT_CLEF_ADMIN_DAILY_NEURONS)
      : Number(env.CLEF_DAILY_NEURONS ?? DEFAULT_CLEF_DAILY_NEURONS);
    const meter: ClefMeter = { calls: 0, neurons: 0 };
    // New keys in hundredths of a neuron (the old "clef" and "clef-admin" counted calls).
    const gemini = admin && !!env.GEMINI_API_KEY && new URL(request.url).searchParams.get("decider") === "gemini";
    const rerank = gemini
      ? geminiReranker(env.GEMINI_API_KEY!, env.DB, Number(env.GEMINI_ADMIN_DAILY_LIMIT ?? DEFAULT_GEMINI_ADMIN_DAILY_LIMIT))
      : decide && env.RERANK !== "off" && clefLimit > 0
        ? limitedReranker(clefReranker(decide), env.DB, clefLimit, admin ? "clef-admin-cn" : "clef-cn", meter)
        : undefined;
    const rewriteLimit = admin
      ? Number(env.REWRITE_ADMIN_DAILY_LIMIT ?? DEFAULT_REWRITE_ADMIN_DAILY_LIMIT)
      : Number(env.REWRITE_DAILY_LIMIT ?? DEFAULT_REWRITE_DAILY_LIMIT);
    const rewriter =
      env.AI && env.REWRITE !== "off" && rewriteLimit > 0
        ? llmRewriter(env.AI, env.DB, env.REWRITE_MODEL ?? DEFAULT_REWRITE_MODEL, rewriteLimit, admin ? "llm-admin" : "llm")
        : undefined;
    const store = new D1Store(env.DB, semantic, rerank, rewriter);
    const app = createApp({
      store,
      runtime: semantic ? "cloudflare-d1+vectorize" : "cloudflare-d1",
      vectors: semantic,
      adminToken: env.VECTOR_ADMIN_TOKEN,
      decide: env.AI
        ? async (model, input) => {
            // Admin-only, but a leaked token must not mean unbounded Workers
            // AI spend: counted per UTC day like Clef, fail-closed.
            const limit = Number(env.DECIDE_ADMIN_DAILY_LIMIT ?? DEFAULT_DECIDE_ADMIN_DAILY_LIMIT);
            let allowed: boolean;
            try {
              allowed = limit > 0 && (await takeDaily(env.DB, "decide-admin", limit));
            } catch (error) {
              throw new Error(`decide counter unavailable: ${error instanceof Error ? error.message : String(error)}`);
            }
            if (!allowed) throw new Error("decide daily limit reached");
            return env.AI!.run(DECISION_MODELS[model] as Parameters<Ai["run"]>[0], input as never);
          }
        : undefined,
    });
    // D1's free tier is 5M rows read a day; this header shows what each
    // request costs (0 when served from the edge cache).
    const response = await app.fetch(request, env, ctx);
    const out = new Response(response.body, response);
    out.headers.set("x-d1-rows-read", String(store.rowsRead));
    out.headers.set("x-d1-queries", String(store.queries));
    out.headers.set("x-clef-calls", String(meter.calls));
    // Daily confidence and cap counts of user answers (numbers only, no questions).
    const confidence = response.headers.get("x-answer-confidence");
    if (confidence && !admin && response.status === 200) {
      const keys = [`answer-${confidence}`, ...(response.headers.get("x-answer-caps") ?? "").split(",").filter(Boolean).map((cap) => `cap-${cap}`)];
      ctx.waitUntil(
        Promise.all(keys.map((key) => takeDaily(env.DB, key, Number.MAX_SAFE_INTEGER))).catch((error) =>
          console.warn("answer counters:", error instanceof Error ? error.message : error),
        ),
      );
    }
    out.headers.set("x-clef-neurons", meter.neurons.toFixed(2));
    return out;
  },
};
