import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  ApiError,
  answerMarkdown,
  answerQuestion,
  rewriteQuestion,
  apiMeta,
  articleMarkdown,
  documentMarkdown,
  getArticle,
  getDocument,
  getStats,
  listArticleRefs,
  listRecent,
  searchDocuments,
  FOCUS_DEFAULT,
} from "./operations.js";
import { DOC_TYPES, type SearchParams, type Store, TYPE_LABELS } from "./types.js";
import { llmsText } from "./llms.js";
import { changesHtml, changesMarkdown, feedHtml, getDocumentChanges, listChanges } from "./changes.js";
import { openapiDocument } from "./openapi.js";
import { findStatutes, statuteCatalog } from "./titles.js";
import { handleMcp } from "./mcp.js";
import { SEMANTIC_DIMS, SEMANTIC_MODEL, type VectorUnit, type VectorWriter } from "./semantic.js";

export const DECISION_MODELS = {
  clef: "@cf/cloudflare/clef",
  "clef-flash": "@cf/cloudflare/clef-flash",
} as const;
export type DecisionModel = keyof typeof DECISION_MODELS;

export interface AppOptions {
  store: Store;
  /** Vector write side for /admin/vectors/* (Worker only). */
  vectors?: VectorWriter;
  /** Bearer token for /admin/vectors/*; the endpoints are disabled without it. */
  adminToken?: string;
  /**
   * Decision-model passthrough for /admin/decide (Worker only), used by the
   * Clef evaluation workflow. Admin-only; not part of the public API.
   */
  decide?: (model: DecisionModel, input: Record<string, unknown>) => Promise<unknown>;
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

function floatParam(
  value: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new ApiError(400, "invalid_parameter", `${name} ${min} ile ${max} arasında bir sayı olmalıdır.`);
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

export function createApp({ store, runtime = "unknown", vectors, adminToken, decide }: AppOptions): Hono {
  const app = new Hono();

  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Content-Type", "Accept", "Mcp-Session-Id"] }));

  // Cache the read-heavy endpoints at the edge. This keeps repeated LLM/tool
  // calls from consuming D1 row reads; it is a no-op on the Node target.
  const cacheable = new Set(["/v1/search", "/v1/answer", "/v1/stats"]);
  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" || !cacheable.has(new URL(c.req.url).pathname)) {
      return next();
    }
    const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    if (!cache) return next();
    const key = new Request(c.req.url, { method: "GET" });
    const hit = await cache.match(key);
    if (hit) return hit;
    await next();
    if (c.res.status === 200) {
      c.header("cache-control", "public, max-age=120");
      try {
        c.executionCtx.waitUntil(cache.put(key, c.res.clone()));
      } catch {
        // Node/Hono adapters without an execution context.
      }
    }
    return;
  });

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
        answer: `${origin}/v1/answer?q=nafaka`,
        document: `${origin}/v1/documents/{id}`,
        article: `${origin}/v1/documents/{id}/articles/12`,
        recent: `${origin}/v1/recent`,
        changes: `${origin}/v1/changes`,
        document_changes: `${origin}/v1/documents/{id}/changes`,
        changes_viewer: `${origin}/degisiklikler`,
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
    const modeRaw = c.req.query("mode") ?? "auto";
    if (!["auto", "all", "any", "phrase"].includes(modeRaw)) {
      throw new ApiError(400, "invalid_mode", "mode auto, all, any veya phrase olmalıdır.");
    }
    const preferRaw = c.req.query("prefer");
    if (preferRaw && !["mevzuat", "ictihat"].includes(preferRaw)) {
      throw new ApiError(400, "invalid_prefer", "prefer mevzuat veya ictihat olmalıdır.");
    }
    const yearRaw = c.req.query("year");
    const params: SearchParams = {
      q: query,
      mode: modeRaw as SearchParams["mode"],
      type: typeParam(c.req.query("type")),
      year: yearRaw ? intParam(yearRaw, "year", 0, 1900, 2100) : undefined,
      source: c.req.query("source") || undefined,
      court: c.req.query("court") || undefined,
      prefer: (preferRaw || undefined) as SearchParams["prefer"],
      min_score: floatParam(c.req.query("min_score"), "min_score", 0, 0, 1000),
      exact_count: ["1", "true", "yes"].includes((c.req.query("exact_count") ?? "").toLowerCase()),
      semantic: !["0", "false", "no"].includes((c.req.query("semantic") ?? "").toLowerCase()),
      passages: c.req.query("passages") ? intParam(c.req.query("passages"), "passages", 1, 1, 3) : undefined,
      limit: intParam(c.req.query("limit"), "limit", 10, 1, 50),
      offset: intParam(c.req.query("offset"), "offset", 0, 0, 1000),
    };
    return c.json(await searchDocuments(store, params, origin));
  });

  app.get("/v1/answer", async (c) => {
    const origin = requestOrigin(c);
    const query = c.req.query("q") ?? c.req.query("query") ?? c.req.query("soru") ?? "";
    if (!query.trim()) {
      throw new ApiError(400, "missing_query", "q parametresi zorunludur. Örnek: /v1/answer?q=nafaka");
    }
    const modeRaw = c.req.query("mode") ?? "auto";
    if (!["auto", "all", "any", "phrase"].includes(modeRaw)) {
      throw new ApiError(400, "invalid_mode", "mode auto, all, any veya phrase olmalıdır.");
    }
    const preferRaw = c.req.query("prefer");
    if (preferRaw && !["mevzuat", "ictihat"].includes(preferRaw)) {
      throw new ApiError(400, "invalid_prefer", "prefer mevzuat veya ictihat olmalıdır.");
    }
    const yearRaw = c.req.query("year");
    const params: SearchParams = {
      q: query,
      mode: modeRaw as SearchParams["mode"],
      type: typeParam(c.req.query("type")),
      year: yearRaw ? intParam(yearRaw, "year", 0, 1900, 2100) : undefined,
      source: c.req.query("source") || undefined,
      court: c.req.query("court") || undefined,
      prefer: (preferRaw || undefined) as SearchParams["prefer"],
      min_score: floatParam(c.req.query("min_score"), "min_score", 0, 0, 1000),
      semantic: !["0", "false", "no"].includes((c.req.query("semantic") ?? "").toLowerCase()),
      rerank: !["0", "false", "no"].includes((c.req.query("rerank") ?? "").toLowerCase()),
      passages: c.req.query("passages") ? intParam(c.req.query("passages"), "passages", 1, 1, 3) : undefined,
      debug: ["1", "true", "yes"].includes((c.req.query("debug") ?? "").toLowerCase()),
      focus: focusParam(c.req.query("focus")),
      rewrite: !["0", "false", "no"].includes((c.req.query("rewrite") ?? "").toLowerCase()),
      rewrite_model: (["20b", "120b"] as const).find((m) => m === (c.req.query("rewrite_model") ?? "").toLowerCase()),
      rewrite_wait: ["1", "true", "yes"].includes((c.req.query("rewrite_wait") ?? "").toLowerCase()),
      rewrite_prompt: (["v1", "v2"] as const).find((v) => v === (c.req.query("rewrite_prompt") ?? "").toLowerCase()),
      strong_laws: ["1", "true", "yes"].includes((c.req.query("strong") ?? "").toLowerCase()),
      rewrite_laws: !["0", "false", "no"].includes((c.req.query("laws") ?? "").toLowerCase()),
      concept_agree: ["1", "true", "yes"].includes((c.req.query("concept_agree") ?? "").toLowerCase()),
      doc_ids: documentParam(c.req.query("document_id")),
      lawpick: ["1", "true", "yes"].includes((c.req.query("lawpick") ?? "").toLowerCase()),
      verify: ["1", "true", "yes"].includes((c.req.query("verify") ?? "").toLowerCase()),
      verify_high: floatParam(c.req.query("verify_high"), "verify_high", 0.5, 0, 1),
      verify_low: floatParam(c.req.query("verify_low"), "verify_low", 0.15, 0, 1),
      toc: ["1", "true", "yes"].includes((c.req.query("toc") ?? "").toLowerCase()),
      lawpick_n: c.req.query("lawpick_n") ? intParam(c.req.query("lawpick_n"), "lawpick_n", 20, 5, 30) : undefined,
      focus_two: ["1", "true", "yes"].includes((c.req.query("focus2") ?? "").toLowerCase()),
      window: !["0", "false", "no"].includes((c.req.query("window") ?? "").toLowerCase()),
      statute_first: !["0", "false", "no"].includes((c.req.query("statute_first") ?? "").toLowerCase()),
      agree: !["0", "false", "no"].includes((c.req.query("agree") ?? "").toLowerCase()),
      dedupe: !["0", "false", "no"].includes((c.req.query("dedupe") ?? "").toLowerCase()),
      jurisdiction: !["0", "false", "no"].includes((c.req.query("jurisdiction") ?? "").toLowerCase()),
      boilerplate: ["1", "true", "yes"].includes((c.req.query("boilerplate") ?? "").toLowerCase()),
      limit: intParam(c.req.query("limit"), "limit", 3, 1, 5),
      offset: 0,
    };
    const response = await answerQuestion(store, params, origin);
    const format = (c.req.query("format") ?? "json").toLowerCase();
    if (format === "markdown" || format === "md") {
      return c.text(answerMarkdown(response), 200, {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "public, max-age=300",
      });
    }
    return c.json(response);
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

  app.get("/v1/changes", async (c) => {
    const origin = requestOrigin(c);
    const feed = await listChanges(
      store,
      {
        since: c.req.query("since") || undefined,
        type: typeParam(c.req.query("type")),
        limit: intParam(c.req.query("limit"), "limit", 50, 1, 200),
      },
      origin,
    );
    return c.json(feed);
  });

  app.get("/v1/documents/:id/changes", async (c) => {
    const origin = requestOrigin(c);
    const id = c.req.param("id");
    const versionRaw = c.req.query("version");
    const version = versionRaw ? intParam(versionRaw, "version", 0, 2, 100000) : undefined;
    const response = await getDocumentChanges(store, id, origin, version);
    if (!response) throw new ApiError(404, "document_not_found", `Belge bulunamadı: ${id}`);
    const format = (c.req.query("format") ?? "json").toLowerCase();
    if (format === "markdown" || format === "md") {
      return c.text(changesMarkdown(response), 200, { "content-type": "text/markdown; charset=utf-8" });
    }
    if (format === "html") return c.html(changesHtml(response, origin));
    return c.json(response);
  });

  // Human-facing viewer: green = added, red = removed.
  app.get("/degisiklikler", async (c) => {
    const origin = requestOrigin(c);
    const feed = await listChanges(
      store,
      { since: c.req.query("since") || undefined, type: typeParam(c.req.query("type")), limit: 200 },
      origin,
    );
    return c.html(feedHtml(feed, origin));
  });

  app.get("/degisiklikler/:id", async (c) => {
    const origin = requestOrigin(c);
    const id = c.req.param("id");
    const response = await getDocumentChanges(store, id, origin);
    if (!response) throw new ApiError(404, "document_not_found", `Belge bulunamadı: ${id}`);
    return c.html(changesHtml(response, origin));
  });

  // Statute finder and catalog (no model): ?name=Ceza Yasası or ?type=yasa&page=1.
  app.get("/v1/statutes", async (c) => {
    const name = (c.req.query("name") ?? c.req.query("q") ?? "").trim();
    if (name) {
      if (name.length > 200) throw new ApiError(400, "query_too_long", "name en fazla 200 karakter olabilir.");
      return c.json({ query: name, results: await findStatutes(store, name) });
    }
    const type = c.req.query("type");
    if (type && !["yasa", "tuzuk", "anayasa"].includes(type)) throw new ApiError(400, "invalid_type", "type yasa, tuzuk veya anayasa olmalıdır.");
    const page = intParam(c.req.query("page"), "page", 1, 1, 50);
    return c.json({ page, page_size: 200, ...(await statuteCatalog(store, type, page)) });
  });

  app.get("/v1/stats", async (c) => {
    const origin = requestOrigin(c);
    return c.json(await getStats(store, origin));
  });

  // Vector index sync, called by the vectors workflow. Disabled unless the
  // runtime provides a writer and an admin token.
  const requireAdmin = (header: string | undefined) => {
    if (!vectors || !adminToken) {
      throw new ApiError(501, "vectors_unavailable", "Vektör dizini bu çalışma ortamında yok.");
    }
    if (!header || !timingSafeEqual(header, `Bearer ${adminToken}`)) {
      throw new ApiError(401, "unauthorized", "Yetkisiz.");
    }
    return vectors;
  };

  app.get("/admin/vectors/info", (c) => {
    requireAdmin(c.req.header("authorization"));
    return c.json({ model: SEMANTIC_MODEL, dimensions: SEMANTIC_DIMS });
  });

  app.post("/admin/vectors/upsert", async (c) => {
    const writer = requireAdmin(c.req.header("authorization"));
    const body = (await c.req.json()) as { units?: VectorUnit[] };
    const units = Array.isArray(body.units) ? body.units : [];
    if (!units.length || units.length > 100) {
      throw new ApiError(400, "invalid_units", "units 1-100 öğe olmalıdır.");
    }
    for (const unit of units) {
      if (typeof unit.id !== "string" || unit.id.length > 64 || typeof unit.text !== "string" || !unit.text) {
        throw new ApiError(400, "invalid_unit", "Her öğede id (≤64 bayt) ve text gerekir.");
      }
    }
    return c.json({ upserted: await writer.upsert(units) });
  });

  app.post("/admin/vectors/delete", async (c) => {
    const writer = requireAdmin(c.req.header("authorization"));
    const body = (await c.req.json()) as { ids?: string[] };
    const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === "string") : [];
    if (!ids.length || ids.length > 1000) {
      throw new ApiError(400, "invalid_ids", "ids 1-1000 öğe olmalıdır.");
    }
    return c.json({ deleted: await writer.remove(ids) });
  });

  // Clef decision-model passthrough for the measurement workflow
  // (.github/workflows/eval-clef.yml). Same admin token as the vector sync.
  app.post("/admin/decide", async (c) => {
    if (!decide || !adminToken) {
      throw new ApiError(501, "decide_unavailable", "Karar modeli bu çalışma ortamında yok.");
    }
    const header = c.req.header("authorization");
    if (!header || !timingSafeEqual(header, `Bearer ${adminToken}`)) {
      throw new ApiError(401, "unauthorized", "Yetkisiz.");
    }
    const body = (await c.req.json()) as { model?: string; input?: Record<string, unknown> };
    const model = body.model as DecisionModel;
    if (!model || !(model in DECISION_MODELS)) {
      throw new ApiError(400, "invalid_model", `model şunlardan biri olmalı: ${Object.keys(DECISION_MODELS).join(", ")}`);
    }
    const input = body.input;
    if (!input || typeof input !== "object" || JSON.stringify(input).length > 64_000) {
      throw new ApiError(400, "invalid_input", "input bir nesne olmalı (en fazla 64 KB).");
    }
    const started = Date.now();
    try {
      const output = await decide(model, input);
      return c.json({ model: DECISION_MODELS[model], ms: Date.now() - started, output });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: "model_error", message, ms: Date.now() - started }, /quota|neuron|limit|429/i.test(message) ? 429 : 502);
    }
  });

  // The LLM rewrite of one question and the statutes its names resolve to,
  // for scripts/eval-rewrite.mjs: measures prompt versions without spending
  // Clef. Counted on the admin LLM budget like any admin rewrite.
  app.get("/admin/rewrite", async (c) => {
    const header = c.req.header("authorization");
    if (!adminToken || !header || !timingSafeEqual(header, `Bearer ${adminToken}`)) {
      throw new ApiError(401, "unauthorized", "Yetkisiz.");
    }
    const q = c.req.query("q") ?? "";
    if (!q.trim()) throw new ApiError(400, "missing_query", "q zorunludur.");
    const info = await rewriteQuestion(store, {
      q,
      rewrite_prompt: (["v1", "v2"] as const).find((v) => v === (c.req.query("prompt") ?? "").toLowerCase()),
      limit: 1,
      offset: 0,
    });
    return c.json(info);
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
    // MCP is how assistants use this API, and it is POST, so the GET edge
    // cache above never saw it. Cache single tools/call results (all tools
    // are read-only) keyed by tool + arguments; the JSON-RPC id is put back
    // on each response.
    const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    const call = cacheableToolCall(payload);
    if (cache && call) {
      const key = new Request(`${origin}/__cache/mcp/${await sha256Hex(call.key)}`, { method: "GET" });
      const hit = await cache.match(key);
      if (hit) {
        return c.json({ jsonrpc: "2.0", id: call.id, result: await hit.json() });
      }
      const result = await handleMcp(payload, store, origin);
      const body = result.body as { result?: { isError?: boolean } } | undefined;
      if (result.status === 200 && body?.result && !body.result.isError) {
        const stored = new Response(JSON.stringify(body.result), {
          headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
        });
        try {
          c.executionCtx.waitUntil(cache.put(key, stored));
        } catch {
          // No execution context (Node).
        }
      }
      if (result.status === 202) return c.body(null, 202);
      return c.json(result.body as Record<string, unknown>, result.status as 200);
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
    const message = err instanceof Error ? err.message : String(err);
    if (/daily row read limit|exceeded D1/i.test(message)) {
      const retry = new Date();
      retry.setUTCHours(24, 0, 0, 0);
      return c.json(
        {
          error: {
            code: "d1_quota_exceeded",
            message:
              "D1 ücretsiz katmanının günlük satır okuma sınırı doldu. " +
              "Kota 00:00 UTC'de sıfırlanır; bu süre içinde arama yapılamaz.",
            retry_at: retry.toISOString(),
          },
          _meta: apiMeta(requestOrigin(c)),
        },
        503,
      );
    }
    console.error(err);
    // debug=1 (measurement scripts) also gets the underlying message.
    const debug = ["1", "true", "yes"].includes((c.req.query("debug") ?? "").toLowerCase());
    return c.json(
      {
        error: {
          code: "internal_error",
          message: "Beklenmeyen bir hata oluştu.",
          ...(debug ? { detail: message.slice(0, 500) } : {}),
        },
        _meta: apiMeta(requestOrigin(c)),
      },
      500,
    );
  });

  return app;
}

/** A statute id to restrict an answer to ("yasa-22-1992"); undefined when absent. */
function documentParam(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  if (!/^[a-z0-9][a-z0-9-]{1,120}$/.test(raw)) {
    throw new ApiError(400, "invalid_document_id", "document_id geçerli bir belge kimliği olmalıdır (ör. yasa-22-1992).");
  }
  return [raw];
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cacheableToolCall(payload: unknown): { id: unknown; key: string } | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const request = payload as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  if (request.jsonrpc !== "2.0" || request.method !== "tools/call" || request.id === undefined) return null;
  const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
  if (typeof params.name !== "string") return null;
  return { id: request.id, key: JSON.stringify([params.name, sortKeys(params.arguments ?? {})]) };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
curl "${origin}/v1/answer?q=nafaka&format=markdown"
curl "${origin}/v1/documents/yasa-1-1998?format=markdown"
curl "${origin}/v1/documents/yasa-1-1998/articles/4"
curl "${origin}/v1/recent?type=karar&limit=5"
curl "${origin}/v1/changes?since=2026-11-01"
curl "${origin}/v1/stats"</pre>
<h2>Uçlar</h2>
<table>
<tr><th>Uç</th><th>Açıklama</th></tr>
<tr><td><code>GET /v1/search</code></td><td>Tam metin arama (FTS5, Türkçe katlama)</td></tr>
<tr><td><code>GET /v1/answer</code></td><td>Birebir alıntı + atıf (üretken değil)</td></tr>
<tr><td><code>GET /v1/documents/{id}</code></td><td>Belge ve tam metin</td></tr>
<tr><td><code>GET /v1/documents/{id}/articles/{ref}</code></td><td>Tek madde (ör. 4, 30A)</td></tr>
<tr><td><code>GET /v1/documents/{id}/articles</code></td><td>Madde listesi</td></tr>
<tr><td><code>GET /v1/recent</code></td><td>En yeni belgeler</td></tr>
<tr><td><code>GET /v1/changes</code></td><td>Mevzuatta saptanan değişiklikler (<a href="/degisiklikler">görüntüleyici</a>)</td></tr>
<tr><td><code>GET /v1/documents/{id}/changes</code></td><td>Bir belgenin sürüm geçmişi; <code>format=markdown|html</code></td></tr>
<tr><td><code>GET /v1/stats</code></td><td>Kapsam ve kaynak istatistikleri</td></tr>
<tr><td><code>POST /mcp</code></td><td>Model Context Protocol araçları</td></tr>
</table>
<p class="muted">Metinler otomatik derlenmiştir; resmî/bağlayıcı metin için belgedeki <code>source_url</code> adresine başvurun.</p>
</body>
</html>`;
}

/** Absent -> the default (on); focus=1|true -> the default count; focus=N -> N articles (2-20); 0 -> off. */
function focusParam(raw: string | undefined): number | undefined {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return undefined;
  if (["0", "false", "no"].includes(value)) return 0;
  if (["1", "true", "yes"].includes(value)) return FOCUS_DEFAULT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 2 || n > 20) {
    throw new ApiError(400, "invalid_focus", "focus 0, 1 veya 2-20 arası bir sayı olmalıdır.");
  }
  return n;
}
