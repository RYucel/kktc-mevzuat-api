import { createApp, type Store, type StoreRow } from "@kktc/core";

export interface Env {
  DB: D1Database;
}

class D1Store implements Store {
  constructor(private readonly db: D1Database) {}

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

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const app = createApp({ store: new D1Store(env.DB), runtime: "cloudflare-d1" });
    return app.fetch(request, env, ctx);
  },
};
