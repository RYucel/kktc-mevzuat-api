import {
  ApiError,
  articleMarkdown,
  documentMarkdown,
  getArticle,
  getDocument,
  getStats,
  listArticleRefs,
  listRecent,
  searchDocuments,
} from "./operations.js";
import type { SearchParams, Store } from "./types.js";

const PROTOCOL_VERSION = "2025-06-18";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResult {
  status: number;
  body?: unknown;
}

const TOOLS = [
  {
    name: "search_mevzuat",
    description:
      "KKTC yasa, tüzük, anayasa ve mahkeme kararlarında Türkçe tam metin arama yapar. " +
      "Sonuçlardaki id ile get_document veya get_article çağırın. İlk adım olarak bunu kullanın.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Arama sözcükleri; tırnak içinde tam ifade." },
        type: {
          type: "string",
          enum: ["yasa", "tuzuk", "karar", "anayasa", "yonetmelik", "emirname", "kararname", "andlasma"],
        },
        year: { type: "integer", minimum: 1900, maximum: 2100 },
        source: { type: "string", enum: ["gov", "mahkemeler"], description: "gov = güncel birleştirilmiş resmî metin." },
        court: { type: "string", description: "Mahkeme adı içinde geçen ifade (yalnız kararlar)." },
        mode: { type: "string", enum: ["all", "any", "phrase"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        offset: { type: "integer", minimum: 0, maximum: 1000 },
      },
      required: ["query"],
    },
  },
  {
    name: "ictihat_ara",
    description:
      "Yalnızca KKTC mahkeme kararlarında (içtihat) arama yapar. Her sonuç hazır bir `citation` " +
      "(atıf) taşır; karara atıf yaparken künyeyi kendin oluşturma, bu alanı aynen kullan. " +
      "Mahkeme adlarını görmek için list_courts çağır. Tam metin için karar_getir.",
    inputSchema: {
      type: "object",
      properties: {
        ifade: { type: "string", description: "Aranacak sözcükler; tırnak içinde tam ifade." },
        mahkeme: {
          type: "string",
          description: "Mahkeme adı içinde geçen ifade, ör. 'Yargıtay', 'Anayasa', 'İdare'. Boş = tümü.",
        },
        yil: { type: "integer", minimum: 1900, maximum: 2100 },
        mod: { type: "string", enum: ["all", "any", "phrase"] },
        adet: { type: "integer", minimum: 1, maximum: 50 },
        sayfa: { type: "integer", minimum: 1, maximum: 50, description: "1'den başlar." },
      },
      required: ["ifade"],
    },
  },
  {
    name: "karar_getir",
    description:
      "Bir mahkeme kararının künyesini, hazır atfını ve resmî tam metnini Markdown olarak getirir.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "ictihat_ara sonucundaki id, ör. karar-e-5-1990-17712." } },
      required: ["id"],
    },
  },
  {
    name: "list_courts",
    description: "Veritabanındaki mahkemeleri karar sayısı ve yıl aralığıyla listeler.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_document",
    description:
      "Bir belgenin künyesini ve tam metnini getirir. format=markdown LLM'e doğrudan verilebilir.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Arama sonucundaki id, ör. yasa-1-1998." },
        format: { type: "string", enum: ["json", "markdown"], default: "markdown" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_article",
    description:
      "Bir yasa/tüzük belgesindeki tek bir maddeyi getirir. ref: 12, Madde 12 veya 30A.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        ref: { type: "string" },
      },
      required: ["id", "ref"],
    },
  },
  {
    name: "list_document_articles",
    description: "Belgede bulunan madde referanslarını listeler.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_recent",
    description: "En yeni yayımlanmış belgeleri listeler (özellikle mahkeme kararları).",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["yasa", "tuzuk", "karar", "anayasa"] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "get_stats",
    description: "API kapsamı: belge sayıları, türler, yıllar ve tam metin durumu.",
    inputSchema: { type: "object", properties: {} },
  },
];

function rpcError(id: JsonRpcId, code: number, message: string): McpResult {
  return { status: 200, body: { jsonrpc: "2.0", id, error: { code, message } } };
}

function rpcResult(id: JsonRpcId, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: "2.0", id, result } };
}

function textResult(value: unknown, structured = true): Record<string, unknown> {
  const isString = typeof value === "string";
  return {
    content: [{ type: "text", text: isString ? value : JSON.stringify(value, null, 2) }],
    ...(structured && !isString ? { structuredContent: value } : {}),
  };
}

function toolError(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `Hata: ${message}` }], isError: true };
}

function intArg(args: Record<string, unknown>, name: string, fallback?: number): number | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function strArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return value === undefined || value === null ? undefined : String(value);
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  store: Store,
  origin: string,
): Promise<Record<string, unknown>> {
  switch (name) {
    case "search_mevzuat": {
      const query = strArg(args, "query") ?? "";
      if (!query.trim()) throw new ApiError(400, "missing_query", "query zorunludur.");
      const params: SearchParams = {
        q: query,
        mode: (strArg(args, "mode") as SearchParams["mode"]) ?? "all",
        type: strArg(args, "type"),
        year: intArg(args, "year"),
        source: strArg(args, "source"),
        court: strArg(args, "court"),
        limit: Math.min(50, Math.max(1, intArg(args, "limit", 10) ?? 10)),
        offset: Math.min(1000, Math.max(0, intArg(args, "offset", 0) ?? 0)),
      };
      return textResult(await searchDocuments(store, params, origin));
    }
    case "ictihat_ara": {
      const query = strArg(args, "ifade") ?? strArg(args, "query") ?? "";
      if (!query.trim()) throw new ApiError(400, "missing_query", "ifade zorunludur.");
      const limit = Math.min(50, Math.max(1, intArg(args, "adet", 10) ?? 10));
      const page = Math.min(50, Math.max(1, intArg(args, "sayfa", 1) ?? 1));
      const response = await searchDocuments(
        store,
        {
          q: query,
          mode: (strArg(args, "mod") as SearchParams["mode"]) ?? "all",
          type: "karar",
          year: intArg(args, "yil"),
          court: strArg(args, "mahkeme") || undefined,
          limit,
          offset: Math.min(1000, (page - 1) * limit),
        },
        origin,
      );
      return textResult(response);
    }
    case "karar_getir": {
      const id = strArg(args, "id");
      if (!id) throw new ApiError(400, "missing_id", "id zorunludur.");
      const response = await getDocument(store, id, origin);
      if (!response) throw new ApiError(404, "document_not_found", `Karar bulunamadı: ${id}`);
      if (response.document.type !== "karar") {
        throw new ApiError(400, "not_a_decision", `${id} bir mahkeme kararı değil; get_document kullanın.`);
      }
      return textResult(documentMarkdown(response.document, origin), false);
    }
    case "list_courts": {
      const stats = await getStats(store, origin);
      return textResult({ courts: stats.stats.courts });
    }
    case "get_document": {
      const id = strArg(args, "id");
      if (!id) throw new ApiError(400, "missing_id", "id zorunludur.");
      const format = (strArg(args, "format") ?? "markdown").toLowerCase();
      const response = await getDocument(store, id, origin);
      if (!response) throw new ApiError(404, "document_not_found", `Belge bulunamadı: ${id}`);
      if (format === "markdown" || format === "md") {
        return textResult(documentMarkdown(response.document, origin), false);
      }
      return textResult(response);
    }
    case "get_article": {
      const id = strArg(args, "id");
      const ref = strArg(args, "ref");
      if (!id || !ref) throw new ApiError(400, "missing_argument", "id ve ref zorunludur.");
      const response = await getArticle(store, id, ref, origin);
      if (!response) throw new ApiError(404, "document_not_found", `Belge bulunamadı: ${id}`);
      return textResult(response);
    }
    case "list_document_articles": {
      const id = strArg(args, "id");
      if (!id) throw new ApiError(400, "missing_id", "id zorunludur.");
      const response = await listArticleRefs(store, id, origin);
      if (!response) throw new ApiError(404, "document_not_found", `Belge bulunamadı: ${id}`);
      return textResult(response);
    }
    case "list_recent": {
      const type = strArg(args, "type");
      const limit = Math.min(100, Math.max(1, intArg(args, "limit", 20) ?? 20));
      return textResult(await listRecent(store, type, limit, origin));
    }
    case "get_stats":
      return textResult(await getStats(store, origin));
    default:
      throw new ApiError(400, "unknown_tool", `Bilinmeyen araç: ${name}`);
  }
}

async function handleOne(
  request: JsonRpcRequest,
  store: Store,
  origin: string,
): Promise<McpResult> {
  const id = request.id ?? null;
  try {
    switch (request.method) {
      case "initialize": {
        const requested = String(request.params?.protocolVersion ?? "");
        const supported = ["2025-06-18", "2025-03-26", "2024-11-05"];
        return rpcResult(id, {
          protocolVersion: supported.includes(requested) ? requested : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "kktc-mevzuat", version: "1.1.0" },
          instructions:
            "KKTC güncel mevzuatı ve içtihadı. Mevzuat için search_mevzuat, mahkeme kararları için " +
            "ictihat_ara kullanın; sonuç id'siyle get_document/get_article veya karar_getir çağırın. " +
            "Atıf yaparken sonuçtaki citation alanını aynen kullanın, künye uydurmayın. " +
            "Yanıtlarda source_url verin; bağlayıcı metin resmî kaynaktır. " +
            "Tam talimatlar: " + origin + "/llms.txt",
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: TOOLS });
      case "tools/call": {
        const name = String(request.params?.name ?? "");
        const args = (request.params?.arguments as Record<string, unknown>) ?? {};
        try {
          const result = await callTool(name, args, store, origin);
          return rpcResult(id, result);
        } catch (error) {
          return rpcResult(id, toolError(error));
        }
      }
      case "resources/list":
        return rpcResult(id, { resources: [] });
      case "resources/templates/list":
        return rpcResult(id, { resourceTemplates: [] });
      case "prompts/list":
        return rpcResult(id, { prompts: [] });
      default:
        return rpcError(id, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    return rpcError(id, -32603, error instanceof Error ? error.message : "Internal error");
  }
}

/** Handle a Streamable HTTP MCP POST body (single request or JSON-RPC batch). */
export async function handleMcp(payload: unknown, store: Store, origin: string): Promise<McpResult> {
  if (Array.isArray(payload)) {
    const responses: unknown[] = [];
    for (const item of payload) {
      if (!isRequest(item)) continue;
      if (item.id === undefined) continue;
      const result = await handleOne(item, store, origin);
      if (result.body !== undefined) responses.push(result.body);
    }
    if (!responses.length) return { status: 202 };
    return { status: 200, body: responses };
  }
  if (!isRequest(payload)) {
    return rpcError(null, -32600, "Invalid Request");
  }
  if (payload.id === undefined) {
    // Notification (e.g. notifications/initialized): acknowledge without a body.
    return { status: 202 };
  }
  return handleOne(payload, store, origin);
}

function isRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.jsonrpc === "2.0" && typeof candidate.method === "string";
}
