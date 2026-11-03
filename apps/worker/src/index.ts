import {
  createApp,
  DECISION_MODELS,
  queryText,
  SEMANTIC_MODEL,
  type SemanticHit,
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
}

class D1Store implements Store {
  constructor(
    private readonly db: D1Database,
    readonly semantic?: SemanticIndex,
  ) {}

  async all(sql: string, binds: unknown[] = []): Promise<StoreRow[]> {
    const result = await this.db
      .prepare(sql)
      .bind(...binds)
      .all();
    return (result.results ?? []) as StoreRow[];
  }

  async first(sql: string, binds: unknown[] = []): Promise<StoreRow | null> {
    const row = await this.db
      .prepare(sql)
      .bind(...binds)
      .first();
    return (row as StoreRow | undefined) ?? null;
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
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const semantic = env.AI && env.VECTORS ? new VectorizeSemantic(env.AI, env.VECTORS) : undefined;
    const app = createApp({
      store: new D1Store(env.DB, semantic),
      runtime: semantic ? "cloudflare-d1+vectorize" : "cloudflare-d1",
      vectors: semantic,
      adminToken: env.VECTOR_ADMIN_TOKEN,
      decide: env.AI
        ? (model, input) => env.AI!.run(DECISION_MODELS[model] as Parameters<Ai["run"]>[0], input as never)
        : undefined,
    });
    return app.fetch(request, env, ctx);
  },
};
