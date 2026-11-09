import {
  clefReranker,
  createApp,
  DECISION_MODELS,
  parseRewrite,
  type QueryRewriter,
  queryText,
  REWRITE_INSTRUCTIONS,
  RewriteLimitError,
  SEMANTIC_MODEL,
  type SemanticHit,
  type Reranker,
  RerankLimitError,
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
  /** Clef calls allowed per UTC day (default 1000, inside the free Workers AI allocation). */
  CLEF_DAILY_LIMIT?: string;
  /** Clef calls per UTC day for our own jobs (admin token: evals, smoke), counted apart (default 1500). */
  CLEF_ADMIN_DAILY_LIMIT?: string;
  /** "off" disables the LLM query rewrite. */
  REWRITE?: string;
  /** Workers AI model for the query rewrite (default @cf/openai/gpt-oss-120b). */
  REWRITE_MODEL?: string;
  /** Rewrites per UTC day for users (default 400) and for our own jobs (default 600). */
  REWRITE_DAILY_LIMIT?: string;
  REWRITE_ADMIN_DAILY_LIMIT?: string;
  /** Per-client request limit (wrangler.toml [[ratelimits]]). */
  RATE_LIMITER?: RateLimit;
  /** Global per-minute circuit breaker (Durable Object, see gate.ts). */
  GATE?: DurableObjectNamespace;
  /** Requests reaching D1 allowed per minute across the Worker (default 100). */
  GATE_PER_MINUTE?: string;
}

/**
 * ~1000 Clef-flash calls (~2.3K tokens each, 3,455 neurons per M tokens) use
 * ~8K of the 10K neurons Workers AI gives free every day, leaving room for
 * query embeddings and the weekly vector sync. Above the limit answers keep
 * the search order, so Clef can never put a Workers AI charge on the bill.
 */
const DEFAULT_CLEF_DAILY_LIMIT = 1000;
/**
 * Our own measurement jobs (admin token) count on a separate counter, so an
 * eval run can never use up the users' daily Clef budget (it did on
 * 2026-11-09). On eval days the two together may pass the free 10K neurons:
 * 1500 calls are ~12K neurons, about $0.13 at $0.011 per 1K neurons.
 */
const DEFAULT_CLEF_ADMIN_DAILY_LIMIT = 1500;

/** Daily counter in D1 (one small write per Clef call). */
async function takeDaily(db: D1Database, key: string, limit: number): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const bump = () =>
    db
      .prepare(
        "INSERT INTO usage_counters (day, key, n) VALUES (?, ?, 1) " +
          "ON CONFLICT(day, key) DO UPDATE SET n = n + 1 RETURNING n",
      )
      .bind(day, key)
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

function limitedReranker(inner: Reranker, db: D1Database, limit: number, key = "clef"): Reranker {
  return {
    async rerank(question, candidates) {
      let allowed: boolean;
      try {
        allowed = await takeDaily(db, key, limit);
      } catch (error) {
        // Without a working counter, do not spend: fail closed (reported as
        // "unavailable", not "daily_limit").
        console.warn("clef counter unavailable:", error instanceof Error ? error.message : error);
        throw new Error(`Clef counter unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!allowed) throw new RerankLimitError();
      return inner.rerank(question, candidates);
    },
  };
}

/**
 * Query rewrite with a Workers AI LLM (packages/core/src/rewrite.ts). One
 * short call (~450 input, a few hundred output tokens with low reasoning,
 * ~30-40 neurons with gpt-oss-120b); counted per day like Clef, fail-closed,
 * and cut off after REWRITE_TIMEOUT_MS so a slow model never holds the answer.
 */
const DEFAULT_REWRITE_MODEL = "@cf/openai/gpt-oss-120b";
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

function llmRewriter(ai: Ai, db: D1Database, model: string, limit: number, key: string): QueryRewriter {
  return {
    async rewrite(question, options) {
      let allowed: boolean;
      try {
        allowed = await takeDaily(db, key, limit);
      } catch (error) {
        throw new Error(`rewrite counter unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!allowed) throw new RewriteLimitError();
      const chosen = options?.model ? REWRITE_MODELS[options.model] : model;
      const run = ai.run(chosen as Parameters<Ai["run"]>[0], {
        instructions: REWRITE_INSTRUCTIONS,
        input: `Soru: ${question.slice(0, 500)}`,
        reasoning: { effort: "low" },
      } as never);
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("rewrite timeout")), REWRITE_TIMEOUT_MS));
      const output = await Promise.race([run, timeout]);
      const parsed = parseRewrite(modelText(output));
      if (!parsed) throw new Error(`rewrite unparsable: ${modelText(output).slice(0, 200)}`);
      return parsed;
    },
  };
}

function bearerIsAdmin(request: Request, env: Env): boolean {
  const token = env.VECTOR_ADMIN_TOKEN;
  return !!token && request.headers.get("authorization") === `Bearer ${token}`;
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
    const [vector] = await embed(this.ai, [queryText(text)]);
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
      ? Number(env.CLEF_ADMIN_DAILY_LIMIT ?? DEFAULT_CLEF_ADMIN_DAILY_LIMIT)
      : Number(env.CLEF_DAILY_LIMIT ?? DEFAULT_CLEF_DAILY_LIMIT);
    const rerank =
      decide && env.RERANK !== "off" && clefLimit > 0
        ? limitedReranker(clefReranker(decide), env.DB, clefLimit, admin ? "clef-admin" : "clef")
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
        ? (model, input) => env.AI!.run(DECISION_MODELS[model] as Parameters<Ai["run"]>[0], input as never)
        : undefined,
    });
    // D1's free tier is 5M rows read a day; this header shows what each
    // request costs (0 when served from the edge cache).
    const response = await app.fetch(request, env, ctx);
    const out = new Response(response.body, response);
    out.headers.set("x-d1-rows-read", String(store.rowsRead));
    out.headers.set("x-d1-queries", String(store.queries));
    return out;
  },
};
