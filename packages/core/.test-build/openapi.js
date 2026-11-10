export function openapiDocument(origin) {
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
            summary: "KKTC güncel yasa, tüzük, anayasa ve mahkeme kararları için tam metin arama API'si.",
            description: "Türkçe diakritikten bağımsız FTS5 araması, madde bazlı erişim, hazır atıf (citation), " +
                "sürüm geçmişi/değişiklik akışı, Markdown çıktısı ve MCP araçları. " +
                "LLM kullanım talimatları için /llms.txt adresine bakın. Metinler otomatik derlenmiştir; " +
                "bağlayıcı metin için her belgedeki source_url kullanılmalıdır.",
            license: { name: "MIT" },
        },
        servers: [{ url: origin, description: "Bu sunucu" }],
        tags: [
            { name: "search", description: "Tam metin arama" },
            { name: "documents", description: "Belge ve madde erişimi" },
            { name: "changes", description: "Sürüm geçmişi ve madde bazlı değişiklikler" },
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
                            description: "auto: önce tüm sözcükler, sonuç yoksa herhangi biri.",
                            schema: { type: "string", enum: ["auto", "all", "any", "phrase"], default: "auto" },
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
                        { name: "court", in: "query", description: "Mahkeme adı içinde geçen ifade.", schema: { type: "string" } },
                        {
                            name: "semantic",
                            in: "query",
                            description: "0: yalnız anahtar kelime (BM25). Varsayılan: doğal dil mevzuat sorularında BM25 + vektör (RRF).",
                            schema: { type: "string", enum: ["0", "1"] },
                        },
                        {
                            name: "prefer",
                            in: "query",
                            description: "mevzuat: yasa/tüzük/anayasayı öne çıkarır; ictihat: kararları öne çıkarır.",
                            schema: { type: "string", enum: ["mevzuat", "ictihat"] },
                        },
                        {
                            name: "min_score",
                            in: "query",
                            description: "Bu skorun altındaki sonuçları eler.",
                            schema: { type: "number", minimum: 0, default: 0 },
                        },
                        {
                            name: "exact_count",
                            in: "query",
                            description: "1 ise pahalı COUNT(DISTINCT) çalışır ve candidate_documents tam sayı olur.",
                            schema: { type: "boolean", default: false },
                        },
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
                                            mode: { type: "string", description: "İstenen mod; auto olabilir." },
                                            effective_mode: { type: "string", enum: ["all", "any", "phrase"] },
                                            relaxed: { type: "boolean", description: "auto modunda any'ye düşüldüyse true." },
                                            concepts: {
                                                type: "array",
                                                description: "Sorguda tanınan hukuk kavramları.",
                                                items: {
                                                    type: "object",
                                                    properties: {
                                                        id: { type: "string" },
                                                        label: { type: "string" },
                                                    },
                                                },
                                            },
                                            concept_expanded: {
                                                type: "boolean",
                                                description: "Kavram terimleriyle ek arama yapıldıysa true.",
                                            },
                                            concept_documents: { type: "integer" },
                                            primary_documents: {
                                                type: "integer",
                                                description: "Kavramın kanonik yasalarından gelen belge sayısı.",
                                            },
                                            count: { type: "integer" },
                                            candidate_documents: {
                                                type: "integer",
                                                description: "Getirilen penceredeki aday belge sayısı; exact_count=1 ise FTS toplamı.",
                                            },
                                            exact_count: { type: "boolean" },
                                            relevant_documents: {
                                                type: "integer",
                                                description: "Getirilen pencere içinde min_score eşiğini geçen belge sayısı.",
                                            },
                                            total_documents: { type: "integer", description: "candidate_documents ile aynı." },
                                            min_score: { type: "number" },
                                            has_more: { type: "boolean" },
                                            next: { type: ["string", "null"] },
                                            groups: {
                                                type: "object",
                                                properties: {
                                                    mevzuat: { type: "array", items: { type: "object" } },
                                                    ictihat: { type: "array", items: { type: "object" } },
                                                },
                                            },
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
                                                        court: { type: ["string", "null"] },
                                                        citation: { type: "string", description: "Hazır atıf; aynen kullanın." },
                                                        consolidated_through: { type: ["string", "null"] },
                                                        text_status: { type: "string", enum: ["full", "partial", "metadata"] },
                                                        content_chars: { type: "integer" },
                                                        chunk_count: { type: "integer" },
                                                        matched_ref: {
                                                            type: ["string", "null"],
                                                            description: "Madde eşleşmesinde parçasız ref, ör. 'Madde 26'.",
                                                        },
                                                        matched_part: {
                                                            type: ["string", "null"],
                                                            description: "Parçalı maddede eşleşen bölüm, ör. '3/7'.",
                                                        },
                                                        matched_kind: { type: "string" },
                                                        matched_text: {
                                                            type: ["string", "null"],
                                                            description: "Eşleşen maddenin tam metni (yasa/tüzük); 8000 karaktere kadar.",
                                                        },
                                                        matched_text_truncated: { type: "boolean" },
                                                        matched_url: {
                                                            type: ["string", "null"],
                                                            description: "Eşleşen maddeye doğrudan bağlantı.",
                                                        },
                                                        snippet: { type: "string" },
                                                        highlights: {
                                                            type: "array",
                                                            items: {
                                                                type: "object",
                                                                properties: {
                                                                    start: { type: "integer" },
                                                                    end: { type: "integer" },
                                                                },
                                                            },
                                                        },
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
            "/v1/answer": {
                get: {
                    tags: ["search"],
                    operationId: "answerQuestion",
                    summary: "Metinden birebir alıntı ve hazır atıf",
                    description: "Üretken değildir; en iyi pasajları birebir alıntılar, citation ve source_url ile döndürür.",
                    parameters: [
                        {
                            name: "q",
                            in: "query",
                            required: true,
                            description: "Doğal dilde hukuk sorusu.",
                            schema: { type: "string", examples: ["mal paylaşımında eşlere düşen en az oran"] },
                        },
                        {
                            name: "mode",
                            in: "query",
                            schema: { type: "string", enum: ["auto", "all", "any", "phrase"], default: "auto" },
                        },
                        {
                            name: "type",
                            in: "query",
                            schema: {
                                type: "string",
                                enum: ["yasa", "tuzuk", "karar", "anayasa", "yonetmelik", "emirname", "kararname", "andlasma"],
                            },
                        },
                        { name: "prefer", in: "query", schema: { type: "string", enum: ["mevzuat", "ictihat"] } },
                        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 5, default: 3 } },
                        {
                            name: "rerank",
                            in: "query",
                            description: "Doğal dil sorularında ilk 10 aday Cloudflare Clef ile yeniden sıralanır ve güven Clef olasılığından gelir (rerank alanı). 0 ile kapatılır; kısa anahtar kelime aramalarında hiç kullanılmaz.",
                            schema: { type: "string", enum: ["1", "0"], default: "1" },
                        },
                        {
                            name: "focus",
                            in: "query",
                            description: "Clef bir yasa seçtikten sonra o yasanın bu kadar maddesi arasından ikinci kez seçer (varsayılan 12; 0 kapatır). Doğru madde oranını belirgin artırır, ~0,8 sn ekler.",
                            schema: { type: "integer", minimum: 0, maximum: 20, default: 12 },
                        },
                        {
                            name: "rewrite",
                            in: "query",
                            description: "Doğal dil sorularında bir LLM soruyu hukuki terimlere ve olası yasa adlarına çevirir; bunlar yalnızca aramayı besler, cevap yine birebir alıntıdır (query_rewrite alanı). 0 ile kapatılır.",
                            schema: { type: "string", enum: ["1", "0"], default: "1" },
                        },
                        {
                            name: "agree",
                            in: "query",
                            description: "LLM soruya uygun yasaları adlandırdıysa ve cevap bunların hiçbirinden gelmiyorsa güven 'high' yerine 'medium' olur (confidence_caps alanı). 0 ile kapatılır.",
                            schema: { type: "string", enum: ["1", "0"], default: "1" },
                        },
                        {
                            name: "statute_first",
                            in: "query",
                            description: "Soru tüzük veya yönetmelik demedikçe yasalar tüzüklerden önce gelir; bir tüzükten alıntılanan cevabın güveni en fazla 'medium' olur. 0 ile kapatılır.",
                            schema: { type: "string", enum: ["1", "0"], default: "1" },
                        },
                        { name: "format", in: "query", schema: { type: "string", enum: ["json", "markdown"], default: "json" } },
                    ],
                    responses: {
                        "200": {
                            description: "Alıntı yanıtı",
                            content: {
                                "application/json": {
                                    schema: {
                                        type: "object",
                                        properties: {
                                            query: { type: "string" },
                                            answer: { type: ["string", "null"] },
                                            answer_type: { type: "string", enum: ["extractive"] },
                                            rerank: {
                                                type: "object",
                                                description: "Yalnız soru yeniden sıralamaya gittiyse vardır.",
                                                properties: {
                                                    model: { type: "string" },
                                                    applied: { type: "boolean" },
                                                    candidates: { type: "integer" },
                                                    top_probability: { type: "number" },
                                                    none_probability: { type: "number" },
                                                    error: { type: "string" },
                                                },
                                            },
                                            quotes: {
                                                type: "array",
                                                items: {
                                                    type: "object",
                                                    properties: {
                                                        document_id: { type: "string" },
                                                        title: { type: "string" },
                                                        ref: { type: ["string", "null"] },
                                                        citation: { type: "string" },
                                                        text: { type: "string" },
                                                        url: { type: "string" },
                                                        source_url: { type: "string" },
                                                        text_status: { type: "string" },
                                                        source: { type: "string", description: "gov (birleştirilmiş güncel metin) veya mahkemeler" },
                                                        consolidated_through: {
                                                            type: ["string", "null"],
                                                            description: "Metnin içerdiği son değişiklik; null ise kaynak belirtmiyor (metin değişikliklerden önceki hâl olabilir).",
                                                        },
                                                        excerpt: { type: "boolean", description: "Alıntı maddenin bir bölümü ise true; tamamı url'de." },
                                                        probability: { type: "number" },
                                                        score: { type: "number" },
                                                    },
                                                },
                                            },
                                            citations: { type: "array", items: { type: "string" } },
                                            confidence: { type: "string", enum: ["high", "medium", "low"] },
                                            confidence_caps: {
                                                type: "array",
                                                items: { type: "string", enum: ["regulation", "rewrite_disagrees", "partial_text"] },
                                                description: "'high' güvenin neden 'medium'a düşürüldüğü.",
                                            },
                                            concepts: { type: "array", items: { type: "object" } },
                                            disclaimer: { type: "string" },
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
            "/v1/changes": {
                get: {
                    tags: ["changes"],
                    operationId: "listChanges",
                    summary: "Mevzuatta saptanan değişiklikler (sürüm geçişleri)",
                    description: "Birleştirilmiş yasa ve tüzük metinleri izlenir (gov; gov\'da olmayanlar için mahkemeler). Takip ilk kayıttan başlar; tracking_since " +
                        "öncesindeki değişiklikler bilinmez. detected_at, değişikliğin kaynakta görüldüğü " +
                        "çalıştırmadır (yürürlük tarihi değildir).",
                    parameters: [
                        { name: "since", in: "query", description: "YYYY-AA-GG", schema: { type: "string" } },
                        {
                            name: "type",
                            in: "query",
                            schema: {
                                type: "string",
                                enum: ["yasa", "tuzuk", "anayasa", "yonetmelik", "emirname", "kararname", "andlasma"],
                            },
                        },
                        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
                    ],
                    responses: { "200": { description: "Değişiklik listesi; tracking_since takip başlangıcıdır." } },
                },
            },
            "/v1/documents/{id}/changes": {
                get: {
                    tags: ["changes"],
                    operationId: "getDocumentChanges",
                    summary: "Bir belgenin sürüm geçmişi ve madde bazlı farkları",
                    description: "versions: kayıtlı sürümler. changes: her sürüm geçişi için eklenen/kaldırılan/değişen " +
                        "maddeler; ops kelime bazlı farkı verir. Takip başlangıcından öncesi kayıtlı değildir.",
                    parameters: [
                        { name: "id", in: "path", required: true, schema: { type: "string" } },
                        { name: "version", in: "query", description: "Yalnız bu sürüme geçiş.", schema: { type: "integer", minimum: 2 } },
                        {
                            name: "format",
                            in: "query",
                            schema: { type: "string", enum: ["json", "markdown", "html"], default: "json" },
                        },
                    ],
                    responses: {
                        "200": { description: "Sürümler ve değişiklikler (ops: [[\"=\"|\"-\"|\"+\", metin], ...])" },
                        "404": { description: "Belge bulunamadı" },
                    },
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
                    description: "JSON-RPC 2.0. initialize, tools/list ve tools/call desteklenir. Araçlar: " +
                        "search_mevzuat, ictihat_ara, karar_getir, list_courts, son_degisiklikler, " +
                        "degisiklikleri_getir, get_document, get_article, list_document_articles, list_recent, get_stats.",
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
                        citation: { type: "string", description: "Hazır atıf; aynen kullanın." },
                        consolidated_through: {
                            type: ["string", "null"],
                            description: "Birleştirilmiş metnin içerdiği son değişiklik: '25/2026' (yasa no) veya '2024-02-13' (tüzük tarihi).",
                        },
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
