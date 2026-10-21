import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  ApiError,
  apiMeta,
  articleMarkdown,
  documentMarkdown,
  getArticle,
  getDocument,
  getStats,
  listArticleRefs,
  listRecent,
  searchDocuments,
} from "./operations.js";
import { DOC_TYPES, type SearchParams, type Store, TYPE_LABELS } from "./types.js";
import { llmsText } from "./llms.js";
import { openapiDocument } from "./openapi.js";
import { handleMcp } from "./mcp.js";

export interface AppOptions {
  store: Store;
  /** Optional label shown by /health, e.g. "cloudflare-d1" or "node-sqlite". */
  runtime?: string;
}

function requestOrigin(c: { req: { url: string; header(name: string): string | undefined } }): string {
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host")?.split(",")[0]?.trim() || c.req.header("host") || url.host;
  return `${proto}://${host}`;
}

function intParam(
  value: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ApiError(400, "invalid_parameter", `${name} ${min} ile ${max} arasında bir tam sayı olmalıdır.`);
  }
  return parsed;
}

function typeParam(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!(DOC_TYPES as readonly string[]).includes(value)) {
    throw new ApiError(
      400,
      "invalid_type",
      `Geçersiz tür: ${value}. Geçerli değerler: ${DOC_TYPES.join(", ")}.`,
    );
  }
  return value;
}

export function createApp({ store, runtime = "unknown" }: AppOptions): Hono {
  const app = new Hono();

  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Content-Type", "Accept", "Mcp-Session-Id"] }));

  app.get("/health", (c) =>
    c.json({ status: "ok", runtime, time: new Date().toISOString() }),
  );

  app.get("/", (c) => c.html(landingPage(requestOrigin(c))));

  app.get("/llms.txt", async (c) => {
    const origin = requestOrigin(c);
    const stats = await getStats(store, origin);
    return c.text(llmsText(origin, stats.stats), 200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    });
  });

  app.get("/openapi.json", (c) => {
    const origin = requestOrigin(c);
    return c.json(openapiDocument(origin));
  });

  app.get("/v1", (c) => {
    const origin = requestOrigin(c);
    return c.json({
      api: "KKTC Mevzuat API",
      version: "v1",
      endpoints: {
        search: `${origin}/v1/search?q=nafaka`,
        document: `${origin}/v1/documents/{id}`,
        article: `${origin}/v1/documents/{id}/articles/12`,
        recent: `${origin}/v1/recent`,
        stats: `${origin}/v1/stats`,
        llms: `${origin}/llms.txt`,
        openapi: `${origin}/openapi.json`,
        mcp: `${origin}/mcp`,
      },
      types: TYPE_LABELS,
      _meta: apiMeta(origin),
    });
  });

  app.get("/v1/search", async (c) => {
    const origin = requestOrigin(c);
    const query = c.req.query("q") ?? c.req.query("query") ?? "";
    if (!query.trim()) {
      throw new ApiError(400, "missing_query", "q parametresi zorunludur. Örnek: /v1/search?q=nafaka");
    }
    const modeRaw = c.req.query("mode") ?? "all";
    if (!["all", "any", "phrase"].includes(modeRaw)) {
      throw new ApiError(400, "invalid_mode", "mode all, any veya phrase olmalıdır.");
    }
    const yearRaw = c.req.query("year");
    const params: SearchParams = {
      q: query,
      mode: modeRaw as SearchParams["mode"],
      type: typeParam(c.req.query("type")),
      year: yearRaw ? intParam(yearRaw, "year", 0, 1900, 2100) : undefined,
      source: c.req.query("source") || undefined,
      court: c.req.query("court") || undefined,
      limit: intParam(c.req.query("limit"), "limit", 10, 1, 50),
      offset: intParam(c.req.query("offset"), "offset", 0, 0, 1000),
    };
    return c.json(await searchDocuments(store, params, origin));
  });

  app.get("/v1/documents/:id", async (c) => {
    const origin = requestOrigin(c);
    const id = c.req.param("id");
    const includeChunks = ["1", "true", "yes"].includes((c.req.query("include_chunks") ?? "").toLowerCase());
    const response = await getDocument(store, id, origin, includeChunks);
    if (!response) {
      throw new ApiError(404, "document_not_found", `Belge bulunamadı: ${id}`);
    }
    const format = (c.req.query("format") ?? "json").toLowerCase();
    if (format === "markdown" || format === "md") {
      return c.text(documentMarkdown(response.document, origin), 200, {
        "content-type": "text/markdown; charset=utf-8",
      });
    }
    if (format === "text" || format === "txt") {
      return c.text(response.document.content, 200, { "content-type": "text/plain; charset=utf-8" });
    }
    return c.json(response);
  });

  app.get("/v1/documents/:id/articles", async (c) => {
    const origin = requestOrigin(c);
    const response = await listArticleRefs(store, c.req.param("id"), origin);
    if (!response) {
      throw new ApiError(404, "document_not_found", `Belge bulunamadı: ${c.req.param("id")}`);
    }
    return c.json(response);
  });

  app.get("/v1/documents/:id/articles/:ref", async (c) => {
    const origin = requestOrigin(c);
    const id = c.req.param("id");
    const ref = c.req.param("ref");
    const response = await getArticle(store, id, ref, origin);
    if (!response) {
      throw new ApiError(404, "document_not_found", `Belge bulunamadı: ${id}`);
    }
    const format = (c.req.query("format") ?? "json").toLowerCase();
    if (format === "markdown" || format === "md") {
      return c.text(articleMarkdown(response.document, response.ref, response.text, origin), 200, {
        "content-type": "text/markdown; charset=utf-8",
      });
    }
    return c.json(response);
  });

  app.get("/v1/recent", async (c) => {
    const origin = requestOrigin(c);
    const type = typeParam(c.req.query("type"));
    const limit = intParam(c.req.query("limit"), "limit", 20, 1, 100);
    return c.json(await listRecent(store, type, limit, origin));
  });

  app.get("/v1/stats", async (c) => {
    const origin = requestOrigin(c);
    return c.json(await getStats(store, origin));
  });

  app.post("/mcp", async (c) => {
    const origin = requestOrigin(c);
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        400,
      );
    }
    const result = await handleMcp(payload, store, origin);
    if (result.status === 202) return c.body(null, 202);
    return c.json(result.body as Record<string, unknown>, result.status as 200);
  });

  app.get("/mcp", (c) =>
    c.json(
      {
        error: {
          code: "method_not_allowed",
          message:
            "Bu MCP sunucusu Streamable HTTP POST kullanır. GET/SSE desteklenmez. " +
            "POST /mcp ile JSON-RPC isteği gönderin. Ayrıntılar: /llms.txt",
        },
      },
      405,
      { allow: "POST" },
    ),
  );

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: "not_found",
          message: `${c.req.method} ${c.req.path} bulunamadı.`,
          hint: "Kullanılabilir uçlar için /v1 veya /llms.txt adresine bakın.",
        },
        _meta: apiMeta(requestOrigin(c)),
      },
      404,
    ),
  );

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(
        {
          error: { code: err.code, message: err.message },
          _meta: apiMeta(requestOrigin(c)),
        },
        err.status as 400,
      );
    }
    console.error(err);
    return c.json(
      {
        error: {
          code: "internal_error",
          message: "Beklenmeyen bir hata oluştu.",
        },
        _meta: apiMeta(requestOrigin(c)),
      },
      500,
    );
  });

  return app;
}

function landingPage(origin: string): string {
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KKTC Mevzuat API</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, -apple-system, Segoe UI, sans-serif; max-width: 860px; margin: 3rem auto; padding: 0 1.25rem; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
  pre { background: #8881; padding: 1rem; border-radius: 8px; overflow-x: auto; }
  h1 { margin-bottom: .25rem; }
  .muted { opacity: .7; }
  a { color: #0a7; }
  table { border-collapse: collapse; width: 100%; }
  td, th { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #8883; }
</style>
</head>
<body>
<h1>KKTC Mevzuat API</h1>
<p class="muted">Kuzey Kıbrıs Türk Cumhuriyeti güncel yasaları, tüzükleri ve mahkeme kararları için arama API'si.</p>
<p><strong>LLM'ler için:</strong> <a href="/llms.txt">/llms.txt</a> · <a href="/openapi.json">OpenAPI</a> · MCP: <code>${origin}/mcp</code></p>
<h2>Hızlı başlangıç</h2>
<pre>curl "${origin}/v1/search?q=nafaka&limit=5"
curl "${origin}/v1/documents/yasa-1-1998?format=markdown"
curl "${origin}/v1/documents/yasa-1-1998/articles/4"
curl "${origin}/v1/recent?type=karar&limit=5"
curl "${origin}/v1/stats"</pre>
<h2>Uçlar</h2>
<table>
<tr><th>Uç</th><th>Açıklama</th></tr>
<tr><td><code>GET /v1/search</code></td><td>Tam metin arama (FTS5, Türkçe katlama)</td></tr>
<tr><td><code>GET /v1/documents/{id}</code></td><td>Belge ve tam metin</td></tr>
<tr><td><code>GET /v1/documents/{id}/articles/{ref}</code></td><td>Tek madde (ör. 4, 30A)</td></tr>
<tr><td><code>GET /v1/documents/{id}/articles</code></td><td>Madde listesi</td></tr>
<tr><td><code>GET /v1/recent</code></td><td>En yeni belgeler</td></tr>
<tr><td><code>GET /v1/stats</code></td><td>Kapsam ve kaynak istatistikleri</td></tr>
<tr><td><code>POST /mcp</code></td><td>Model Context Protocol araçları</td></tr>
</table>
<p class="muted">Metinler otomatik derlenmiştir; resmî/bağlayıcı metin için belgedeki <code>source_url</code> adresine başvurun.</p>
</body>
</html>`;
}
