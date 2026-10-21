import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import { createApp, type Store, type StoreRow } from "@kktc/core";

class SqliteStore implements Store {
  constructor(private readonly db: DatabaseSync) {}

  async all(sql: string, binds: unknown[] = []): Promise<StoreRow[]> {
    return this.db.prepare(sql).all(...(binds as never[])) as StoreRow[];
  }

  async first(sql: string, binds: unknown[] = []): Promise<StoreRow | null> {
    const row = this.db.prepare(sql).get(...(binds as never[]));
    return (row as StoreRow | undefined) ?? null;
  }
}

function findDatabase(): string {
  const fromEnv = process.env.KKTC_DB_PATH;
  if (fromEnv) return path.resolve(fromEnv);
  const candidates = [
    path.resolve(process.cwd(), "data", "kktc.db"),
    path.resolve(process.cwd(), "..", "..", "data", "kktc.db"),
    path.resolve(process.cwd(), "..", "data", "kktc.db"),
    "/app/data/kktc.db",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Veritabanı bulunamadı. KKTC_DB_PATH ayarlayın veya şu konumlardan birine koyun: ${candidates.join(", ")}`,
  );
}

const dbPath = findDatabase();
const db = new DatabaseSync(dbPath, { readOnly: true });
const app = createApp({ store: new SqliteStore(db), runtime: "node-sqlite" });

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? "0.0.0.0";

console.log(`KKTC Mevzuat API (node:sqlite) -> http://${hostname}:${port}`);
console.log(`Veritabanı: ${dbPath}`);

serve({ fetch: app.fetch, port, hostname });
