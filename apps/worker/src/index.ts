import {
  clefReranker,
  createApp,
  DECISION_MODELS,
  queryText,
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
  /** Per-client request limit (wrangler.toml [[ratelimits]]). */
  RATE_LIMITER?: RateLimit;
}

/**
 * ~1000 Clef-flash calls (~2.3K tokens each, 3,455 neurons per M tokens) use
 * ~8K of the 10K neurons Workers AI gives free every day, leaving room for
 * query embeddings and the weekly vector sync. Above the limit answers keep
 * the search order, so Clef can never put a Workers AI charge on the bill.
 */
const DEFAULT_CLEF_DAILY_LIMIT = 1000;

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

function limitedReranker(inner: Reranker, db: D1Database, limit: number): Reranker {
  return {
    async rerank(question, candidates) {
      let allowed = false;
      try {
        allowed = await takeDaily(db, "clef", limit);
      } catch (error) {
        // Without a working counter, do not spend: fail closed.
        console.warn("clef counter unavailable:", error instanceof Error ? error.message : error);
      }
      if (!allowed) throw new RerankLimitError();
      return inner.rerank(question, candidates);
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
  ) {}

  async all(sql: string, binds: unknown[] = []): Promise<StoreRow[]> {
    const result = await this.db
      .prepare(sql)
      .bind(...binds)
      .all();
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
    await this.index.deleteByIds(ids);
    return ids.length;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const limited = await rateLimited(request, env);
    if (limited) return limited;
    const semantic = env.AI && env.VECTORS ? new VectorizeSemantic(env.AI, env.VECTORS) : undefined;
    const decide = env.AI
      ? (model: string, input: Record<string, unknown>) =>
          env.AI!.run(`@cf/cloudflare/${model}` as Parameters<Ai["run"]>[0], input as never)
      : undefined;
    // Clef answer reranking (see packages/core/src/rerank.ts); RERANK=off disables it.
    const clefLimit = Number(env.CLEF_DAILY_LIMIT ?? DEFAULT_CLEF_DAILY_LIMIT);
    const rerank =
      decide && env.RERANK !== "off" && clefLimit > 0
        ? limitedReranker(clefReranker(decide), env.DB, clefLimit)
        : undefined;
    const store = new D1Store(env.DB, semantic, rerank);
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
