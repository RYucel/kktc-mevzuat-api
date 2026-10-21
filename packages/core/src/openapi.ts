export function openapiDocument(origin: string): Record<string, unknown> {
  const errorResponse = {
    description: "Hata",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string" },
                message: { type: "string" },
              },
            },
          },
        },
      },
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "KKTC Mevzuat API",
      version: "1.0.0",
      summary:
        "KKTC güncel yasa, tüzük, anayasa ve mahkeme kararları için tam metin arama API'si.",
      description:
        "Türkçe diakritikten bağımsız FTS5 araması, madde bazlı erişim, Markdown çıktısı ve MCP araçları. " +
        "LLM kullanım talimatları için /llms.txt adresine bakın. Metinler otomatik derlenmiştir; " +
        "bağlayıcı metin için her belgedeki source_url kullanılmalıdır.",
      license: { name: "MIT" },
    },
    servers: [{ url: origin, description: "Bu sunucu" }],
    tags: [
      { name: "search", description: "Tam metin arama" },
      { name: "documents", description: "Belge ve madde erişimi" },
      { name: "meta", description: "Kapsam ve istatistikler" },
    ],
    paths: {
      "/v1/search": {
        get: {
          tags: ["search"],
          operationId: "searchDocuments",
          summary: "Yasa, tüzük ve kararlarda tam metin arama",
          parameters: [
            {
              name: "q",
              in: "query",
              required: true,
              description: "Arama sözcükleri. Tırnak içinde tam ifade kullanılabilir.",
              schema: { type: "string", examples: ["nafaka", '"mal paylaşımı"'] },
            },
            {
              name: "mode",
              in: "query",
              schema: { type: "string", enum: ["all", "any", "phrase"], default: "all" },
            },
            {
              name: "type",
              in: "query",
              schema: {
                type: "string",
                enum: ["yasa", "tuzuk", "karar", "anayasa", "yonetmelik", "emirname", "kararname", "andlasma"],
              },
            },
            { name: "year", in: "query", schema: { type: "integer", minimum: 1900, maximum: 2100 } },
            { name: "source", in: "query", schema: { type: "string", enum: ["gov", "mahkemeler"] } },
            { name: "court", in: "query", schema: { type: "string" } },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 50, default: 10 },
            },
            {
              name: "offset",
              in: "query",
              schema: { type: "integer", minimum: 0, maximum: 1000, default: 0 },
            },
          ],
          responses: {
            "200": {
              description: "Arama sonuçları",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      query: { type: "string" },
                      count: { type: "integer" },
                      total_documents: { type: "integer" },
                      has_more: { type: "boolean" },
                      next: { type: ["string", "null"] },
                      results: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            title: { type: "string" },
                            type: { type: "string" },
                            number: { type: ["string", "null"] },
                            year: { type: ["integer", "null"] },
                            date: { type: ["string", "null"] },
                            matched_ref: { type: ["string", "null"] },
                            snippet: { type: "string" },
                            score: { type: "number", description: "Büyük olan daha iyidir." },
                            url: { type: "string" },
                            source_url: { type: "string" },
                          },
                        },
                      },
                      _meta: { $ref: "#/components/schemas/ApiMeta" },
                    },
                  },
                },
              },
            },
            "400": errorResponse,
          },
        },
      },
      "/v1/documents/{id}": {
        get: {
          tags: ["documents"],
          operationId: "getDocument",
          summary: "Belge künyesi ve tam metni",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            {
              name: "format",
              in: "query",
              schema: { type: "string", enum: ["json", "markdown", "text"], default: "json" },
            },
            {
              name: "include_chunks",
              in: "query",
              description: "1 ise madde/paragraf parçaları da döner.",
              schema: { type: "boolean", default: false },
            },
          ],
          responses: {
            "200": {
              description: "Belge; format=markdown ise text/markdown döner.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      document: { $ref: "#/components/schemas/Document" },
                      _meta: { $ref: "#/components/schemas/ApiMeta" },
                    },
                  },
                },
                "text/markdown": { schema: { type: "string" } },
              },
            },
            "404": errorResponse,
          },
        },
      },
      "/v1/documents/{id}/articles": {
        get: {
          tags: ["documents"],
          operationId: "listDocumentArticles",
          summary: "Belgedeki madde referanslarını listele",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Madde referansları" },
            "404": errorResponse,
          },
        },
      },
      "/v1/documents/{id}/articles/{ref}": {
        get: {
          tags: ["documents"],
          operationId: "getArticle",
          summary: "Tek bir maddeyi getir",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            {
              name: "ref",
              in: "path",
              required: true,
              description: "12, Madde 12, m. 12 veya 30A",
              schema: { type: "string", examples: ["12", "30A"] },
            },
            {
              name: "format",
              in: "query",
              schema: { type: "string", enum: ["json", "markdown"], default: "json" },
            },
          ],
          responses: {
            "200": { description: "Madde metni" },
            "404": errorResponse,
          },
        },
      },
      "/v1/recent": {
        get: {
          tags: ["meta"],
          operationId: "listRecent",
          summary: "En yeni belgeler",
          parameters: [
            {
              name: "type",
              in: "query",
              schema: { type: "string", enum: ["yasa", "tuzuk", "karar", "anayasa"] },
            },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
          ],
          responses: { "200": { description: "Belge listesi" } },
        },
      },
      "/v1/stats": {
        get: {
          tags: ["meta"],
          operationId: "getStats",
          summary: "Kapsam istatistikleri",
          responses: { "200": { description: "İstatistikler" } },
        },
      },
      "/llms.txt": {
        get: {
          tags: ["meta"],
          operationId: "getLlmsTxt",
          summary: "LLM kullanım talimatları",
          responses: { "200": { description: "text/plain", content: { "text/plain": { schema: { type: "string" } } } } },
        },
      },
      "/openapi.json": {
        get: {
          tags: ["meta"],
          operationId: "getOpenApi",
          summary: "Bu OpenAPI belgesi",
          responses: { "200": { description: "OpenAPI 3.1" } },
        },
      },
      "/mcp": {
        post: {
          tags: ["meta"],
          operationId: "mcpJsonRpc",
          summary: "Model Context Protocol (Streamable HTTP)",
          description:
            "JSON-RPC 2.0. initialize, tools/list ve tools/call desteklenir. " +
            "Araçlar: search_mevzuat, get_document, get_article, list_document_articles, list_recent, get_stats.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    jsonrpc: { const: "2.0" },
                    id: { type: ["string", "integer"] },
                    method: { type: "string" },
                    params: { type: "object" },
                  },
                  required: ["jsonrpc", "method"],
                },
              },
            },
          },
          responses: { "200": { description: "JSON-RPC yanıtı" }, "202": { description: "Bildirim kabul edildi" } },
        },
      },
    },
    components: {
      schemas: {
        ApiMeta: {
          type: "object",
          properties: {
            api: { type: "string" },
            docs: { type: "string" },
            openapi: { type: "string" },
            mcp: { type: "string" },
            hint: { type: "string" },
            disclaimer: { type: "string" },
            generated_at: { type: "string", format: "date-time" },
          },
        },
        Document: {
          type: "object",
          properties: {
            id: { type: "string" },
            type: { type: "string" },
            subtype: { type: ["string", "null"] },
            title: { type: "string" },
            number: { type: ["string", "null"] },
            year: { type: ["integer", "null"] },
            date: { type: ["string", "null"] },
            language: { type: "string" },
            source: { type: "string" },
            source_url: { type: "string" },
            pdf_url: { type: ["string", "null"] },
            court: { type: ["string", "null"] },
            parties: { type: ["string", "null"] },
            subject: { type: ["string", "null"] },
            summary: { type: ["string", "null"] },
            content_chars: { type: "integer" },
            chunk_count: { type: "integer" },
            text_status: { type: "string", enum: ["full", "partial", "metadata"] },
            updated_at: { type: ["string", "null"] },
            extra: {},
            sources: {},
            url: { type: "string" },
            content: { type: "string" },
            chunks: { type: "array", items: { type: "object" } },
          },
        },
      },
    },
  };
}
