import {
  articleListSql,
  articleSql,
  buildCountSql,
  buildSearchSql,
  chunksSql,
  documentSql,
  recentSql,
  STATS_SQL,
} from "./sql.js";
import { baseArticleRef, buildMatch, makeSnippet, normalizeArticleRef, truncate } from "./text.js";
import {
  type ApiMeta,
  type ArticleResponse,
  type Chunk,
  type DocumentDetail,
  type DocumentResponse,
  type DocumentSummary,
  type RecentResponse,
  type SearchParams,
  type SearchResponse,
  type SearchResult,
  type StatsResponse,
  type Store,
  type StoreRow,
  TYPE_LABELS,
} from "./types.js";

const API_NAME = "KKTC Mevzuat API";

export function apiMeta(origin: string): ApiMeta {
  return {
    api: API_NAME,
    docs: `${origin}/llms.txt`,
    openapi: `${origin}/openapi.json`,
    mcp: `${origin}/mcp`,
    hint:
      "Arama: GET /v1/search?q=nafaka. Tam metin: GET /v1/documents/{id}?format=markdown. " +
      "Madde: GET /v1/documents/{id}/articles/12. LLM kullanım talimatları: /llms.txt.",
    disclaimer:
      "Metinler resmî kaynaklardan otomatik derlenmiştir; bağlayıcı/resmî metin için source_url " +
      "alanındaki kaynağa başvurun. Yürürlük ve değişiklikler için güncel Resmî Gazete kontrol edilmelidir.",
    generated_at: new Date().toISOString(),
  };
}

function asString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function mapSummary(row: StoreRow, origin: string): DocumentSummary {
  const id = String(row.id);
  return {
    id,
    type: String(row.type),
    subtype: asString(row.subtype),
    title: String(row.title),
    number: asString(row.number),
    year: asNumber(row.year),
    date: asString(row.date),
    language: String(row.language ?? "tr"),
    source: String(row.source),
    source_url: String(row.source_url ?? ""),
    pdf_url: asString(row.pdf_url),
    court: asString(row.court),
    chamber: asString(row.chamber),
    parties: asString(row.parties),
    subject: asString(row.subject),
    summary: asString(row.summary),
    content_chars: Number(row.content_chars ?? 0),
    chunk_count: Number(row.chunk_count ?? 0),
    text_status: String(row.text_status ?? "metadata"),
    updated_at: asString(row.updated_at),
    extra: parseJson(row.extra_json),
    sources: parseJson(row.sources_json),
    url: `${origin}/v1/documents/${encodeURIComponent(id)}`,
  };
}

export async function searchDocuments(
  store: Store,
  params: SearchParams,
  origin: string,
): Promise<SearchResponse> {
  const match = buildMatch(params.q, params.mode ?? "all");
  if (!match) {
    throw new ApiError(400, "empty_query", "Arama sorgusu en az bir harf/rakam içermelidir.");
  }

  const search = buildSearchSql(match, params);
  const count = buildCountSql(match, params);
  const [rows, countRow] = await Promise.all([
    store.all(search.sql, search.binds),
    store.first(count.sql, count.binds),
  ]);

  const seen = new Set<string>();
  const deduped: { row: StoreRow; score: number }[] = [];
  for (const row of rows) {
    const id = String(row.id);
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push({ row, score: -Number(row.rank ?? 0) });
  }

  const page = deduped.slice(params.offset, params.offset + params.limit);
  const results: SearchResult[] = page.map(({ row, score }) => {
    const summary = mapSummary(row, origin);
    return {
      id: summary.id,
      type: summary.type,
      subtype: summary.subtype,
      title: summary.title,
      number: summary.number,
      year: summary.year,
      date: summary.date,
      source: summary.source,
      court: summary.court,
      matched_ref: asString(row.matched_ref),
      matched_kind: String(row.matched_kind ?? ""),
      snippet: makeSnippet(String(row.chunk_text ?? ""), params.q),
      score: Number(score.toFixed(6)),
      url: summary.url,
      source_url: summary.source_url,
    };
  });

  const nextOffset = params.offset + results.length;
  const next =
    results.length === params.limit
      ? `${origin}/v1/search?${new URLSearchParams({
          q: params.q,
          ...(params.mode && params.mode !== "all" ? { mode: params.mode } : {}),
          ...(params.type ? { type: params.type } : {}),
          ...(params.year ? { year: String(params.year) } : {}),
          ...(params.source ? { source: params.source } : {}),
          ...(params.court ? { court: params.court } : {}),
          limit: String(params.limit),
          offset: String(nextOffset),
        }).toString()}`
      : null;

  return {
    query: params.q,
    mode: params.mode ?? "all",
    filters: {
      type: params.type ?? null,
      year: params.year ?? null,
      source: params.source ?? null,
      court: params.court ?? null,
    },
    count: results.length,
    total_documents: Number(countRow?.n ?? 0),
    has_more: next !== null,
    next,
    results,
    _meta: apiMeta(origin),
  };
}

export async function getDocument(
  store: Store,
  id: string,
  origin: string,
  includeChunks = false,
): Promise<DocumentResponse | null> {
  const docQuery = documentSql(id);
  const row = await store.first(docQuery.sql, docQuery.binds);
  if (!row) return null;

  const chunkQuery = chunksSql(id);
  const chunkRows = await store.all(chunkQuery.sql, chunkQuery.binds);
  const chunks: Chunk[] = chunkRows.map((chunk) => ({
    ord: Number(chunk.ord),
    kind: String(chunk.kind),
    ref: asString(chunk.ref),
    text: String(chunk.text),
  }));

  const body = chunks.filter((chunk) => chunk.kind !== "title");
  const content = body.map((chunk) => chunk.text).join("\n\n").trim();
  const summary = mapSummary(row, origin);
  const document: DocumentDetail = {
    ...summary,
    content,
    ...(includeChunks ? { chunks } : {}),
  };
  return { document, _meta: apiMeta(origin) };
}

export async function getArticle(
  store: Store,
  id: string,
  rawRef: string,
  origin: string,
): Promise<ArticleResponse | null> {
  const ref = normalizeArticleRef(rawRef);
  if (!ref) {
    throw new ApiError(
      400,
      "invalid_ref",
      'Madde referansı "12", "Madde 12" veya "30A" biçiminde olmalıdır.',
    );
  }
  const docQuery = documentSql(id);
  const row = await store.first(docQuery.sql, docQuery.binds);
  if (!row) return null;

  const query = articleSql(id, ref);
  const partRows = await store.all(query.sql, query.binds);
  if (!partRows.length) {
    const listQuery = articleListSql(id);
    const list = await store.all(listQuery.sql, listQuery.binds);
    const refs = Array.from(
      new Set(list.map((item) => baseArticleRef(asString(item.ref))).filter(Boolean)),
    ).slice(0, 40);
    throw new ApiError(
      404,
      "article_not_found",
      `${id} içinde ${ref} bulunamadı. Mevcut referanslar: ${refs.join(", ") || "yok"}.`,
    );
  }

  const parts: Chunk[] = partRows.map((chunk) => ({
    ord: Number(chunk.ord),
    kind: String(chunk.kind),
    ref: asString(chunk.ref),
    text: String(chunk.text),
  }));
  return {
    document: mapSummary(row, origin),
    ref,
    parts,
    text: parts.map((part) => part.text).join("\n\n").trim(),
    _meta: apiMeta(origin),
  };
}

export async function listArticleRefs(
  store: Store,
  id: string,
  origin: string,
): Promise<{ document: DocumentSummary; articles: string[]; _meta: ApiMeta } | null> {
  const docQuery = documentSql(id);
  const row = await store.first(docQuery.sql, docQuery.binds);
  if (!row) return null;
  const query = articleListSql(id);
  const rows = await store.all(query.sql, query.binds);
  const articles = Array.from(
    new Set(rows.map((item) => baseArticleRef(asString(item.ref))).filter(Boolean)),
  ) as string[];
  const unique = Array.from(new Set(articles));
  return { document: mapSummary(row, origin), articles: unique, _meta: apiMeta(origin) };
}

export async function listRecent(
  store: Store,
  type: string | undefined,
  limit: number,
  origin: string,
): Promise<RecentResponse> {
  const query = recentSql(type, limit);
  const rows = await store.all(query.sql, query.binds);
  const results = rows.map((row) => mapSummary(row, origin));
  return { count: results.length, results, _meta: apiMeta(origin) };
}

export async function getStats(store: Store, origin: string): Promise<StatsResponse> {
  const [metaRows, types, years, sources, status, latest] = await Promise.all([
    store.all(STATS_SQL.meta),
    store.all(STATS_SQL.types),
    store.all(STATS_SQL.years),
    store.all(STATS_SQL.sources),
    store.all(STATS_SQL.status),
    store.all(STATS_SQL.latest),
  ]);
  const meta: Record<string, unknown> = {};
  for (const row of metaRows) {
    try {
      meta[String(row.key)] = JSON.parse(String(row.value));
    } catch {
      meta[String(row.key)] = row.value;
    }
  }
  return {
    stats: {
      ...meta,
      by_type: types,
      by_year: years,
      by_source: sources,
      text_status: status,
      latest_by_type: latest,
      type_labels: TYPE_LABELS,
    },
    _meta: apiMeta(origin),
  };
}

export function documentMarkdown(doc: DocumentDetail, origin: string): string {
  const label = TYPE_LABELS[doc.type] ?? doc.type;
  const lines = [`# ${doc.title}`, ""];
  lines.push(`- **Tür:** ${label}`);
  if (doc.number) lines.push(`- **Sayı:** ${doc.number}`);
  if (doc.date) lines.push(`- **Tarih:** ${doc.date}`);
  if (doc.court) lines.push(`- **Mahkeme:** ${doc.court}`);
  if (doc.parties) lines.push(`- **Taraflar:** ${doc.parties}`);
  if (doc.subject) lines.push(`- **Konu:** ${doc.subject}`);
  lines.push(`- **Kaynak:** ${doc.source} — ${doc.source_url}`);
  lines.push("", "> Resmî ve bağlayıcı metin için yukarıdaki kaynak bağlantısını kullanın.", "");
  if (doc.summary) lines.push(`**Özet:** ${doc.summary}`, "");
  lines.push("---", "", doc.content || "_Bu belge için tam metin henüz indekslenmemiştir._");
  lines.push("", "---", `API: ${doc.url} · ${origin}/llms.txt`);
  return lines.join("\n");
}

export function articleMarkdown(
  doc: DocumentSummary,
  ref: string,
  text: string,
  origin: string,
): string {
  return [
    `# ${doc.title} — ${ref}`,
    "",
    `- **Belge:** ${doc.title}`,
    ...(doc.number ? [`- **Sayı:** ${doc.number}`] : []),
    `- **Kaynak:** ${doc.source_url}`,
    `- **API:** ${doc.url}/articles/${encodeURIComponent(ref.replace(/^Madde\s+/i, ""))}`,
    "",
    text || "_Metin bulunamadı._",
    "",
    "---",
    `Resmî metin için kaynak bağlantısına başvurun. · ${origin}/llms.txt`,
  ].join("\n");
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function short(text: string, limit = 600): string {
  return truncate(text, limit);
}
