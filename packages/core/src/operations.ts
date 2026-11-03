import {
  articleListSql,
  articleSql,
  buildCountSql,
  buildSearchSql,
  chunksForDocsSql,
  chunksSql,
  documentSql,
  primaryDocsSql,
  recentSql,
  STATS_SQL,
} from "./sql.js";
import { buildCitation } from "./citation.js";
import { conceptMatch, matchConcepts } from "./legal-concepts.js";
import {
  baseArticleRef,
  buildMatch,
  foldTr,
  makeHighlights,
  makeSnippet,
  normalizeArticleRef,
  truncate,
} from "./text.js";
import {
  type ApiMeta,
  type ArticleResponse,
  type Chunk,
  type DocumentDetail,
  type DocumentResponse,
  type DocumentSummary,
  type RecentResponse,
  type SearchGroupItem,
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

function consolidatedThrough(extra: unknown): string | null {
  if (!extra || typeof extra !== "object") return null;
  const info = (extra as Record<string, unknown>).consolidation as { through?: unknown } | undefined;
  return info && typeof info.through === "string" ? info.through : null;
}

/** "25/2026 sayılı değişikliğe kadar" or "13.02.2024 tarihli değişikliğe kadar". */
export function consolidationLabel(through: string | null): string | null {
  if (!through) return null;
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(through);
  return date
    ? `${date[3]}.${date[2]}.${date[1]} tarihli değişikliğe kadar birleştirilmiş metin`
    : `${through} sayılı değişikliğe kadar birleştirilmiş metin`;
}

const LEGISLATION_TYPES = new Set([
  "yasa",
  "tuzuk",
  "anayasa",
  "yonetmelik",
  "emirname",
  "kararname",
  "andlasma",
]);
const MATCHED_TEXT_LIMIT = 8000;
const CONCEPT_BOOST = 8;

function capText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const cut = text.lastIndexOf(" ", limit);
  return {
    text: `${text.slice(0, cut > limit * 0.6 ? cut : limit).trimEnd()}…`,
    truncated: true,
  };
}

function articleUrl(origin: string, id: string, baseRef: string): string {
  const ref = baseRef.replace(/^Madde\s+/, "");
  return `${origin}/v1/documents/${encodeURIComponent(id)}/articles/${encodeURIComponent(ref)}`;
}

function matchedPart(ref: string, baseRef: string): string | null {
  const suffix = ref.slice(baseRef.length).trim().replace(/^\(|\)$/g, "");
  return suffix || null;
}

export function mapSummary(row: StoreRow, origin: string): DocumentSummary {
  const id = String(row.id);
  const extra = parseJson(row.extra_json);
  const summary = {
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
    extra,
    sources: parseJson(row.sources_json),
    url: `${origin}/v1/documents/${encodeURIComponent(id)}`,
  };
  return { ...summary, citation: buildCitation(summary), consolidated_through: consolidatedThrough(extra) };
}

export async function searchDocuments(
  store: Store,
  params: SearchParams,
  origin: string,
): Promise<SearchResponse> {
  const requestedMode = params.mode ?? "auto";
  const initialMode: "all" | "any" | "phrase" = requestedMode === "auto" ? "all" : requestedMode;
  const initialMatch = buildMatch(params.q, initialMode);
  if (!initialMatch) {
    throw new ApiError(400, "empty_query", "Arama sorgusu en az bir harf/rakam içermelidir.");
  }

  // Concept expansion is for natural-language questions, not for short
  // keyword searches: "nafaka" or "kıdem tazminatı" already retrieve the right
  // documents, while expanding them adds noise.
  const queryWords = params.q.trim().split(/\s+/).filter(Boolean).length;
  const naturalQuestion = /\b(nedir|nasil|hangi|ne kadar|en az|en fazla|oran|sart|sartlari|sonuc|sonuclari|kim|nerede)\b/.test(
    foldTr(params.q),
  );
  const conceptMatches = matchConcepts(params.q);
  const detected = conceptMatches.map((match) => match.concept);
  const concepts = queryWords >= 4 || naturalQuestion ? detected : [];
  // Only the leading concept(s) contribute canonical statutes; otherwise a
  // generic trigger such as "ceza" injects the Criminal Code into tax queries.
  const topConceptScore = conceptMatches[0]?.score ?? 0;
  const primaryConcepts = conceptMatches
    .filter((match) => match.score >= topConceptScore * 0.85)
    .map((match) => match.concept);
  const primaryIds = [...new Set(primaryConcepts.flatMap((concept) => concept.primary ?? []))];
  const searchParams: SearchParams = {
    ...params,
    prefer: params.prefer ?? (detected.length > 0 ? "mevzuat" : undefined),
    boost_ids: primaryIds,
  };

  const fetchRows = async (match: string, overrides: Partial<SearchParams> = {}) => {
    const search = buildSearchSql(match, { ...searchParams, ...overrides });
    return store.all(search.sql, search.binds);
  };

  const run = async (match: string) => {
    const count = buildCountSql(match, searchParams);
    const [rows, countRow] = await Promise.all([fetchRows(match), store.first(count.sql, count.binds)]);
    return { rows, candidate: Number(countRow?.n ?? 0) };
  };

  let { rows, candidate } = await run(initialMatch);
  let effectiveMode: "all" | "any" | "phrase" = initialMode;
  let relaxed = false;
  if (requestedMode === "auto" && rows.length === 0) {
    const relaxedMatch = buildMatch(params.q, "any");
    if (relaxedMatch && relaxedMatch !== initialMatch) {
      const retry = await run(relaxedMatch);
      if (retry.rows.length > 0) {
        rows = retry.rows;
        candidate = retry.candidate;
        effectiveMode = "any";
        relaxed = true;
      }
    }
  }

  // Concept channel: "en az oran" -> "2/3'ünden fazla olamaz", "mal rejimi"...
  const conceptRows: StoreRow[] = [];
  if (concepts.length) {
    const batches = await Promise.all(
      concepts.map((concept) => fetchRows(conceptMatch(concept))),
    );
    for (const batch of batches) conceptRows.push(...batch);
  }

  const injectPrimary =
    detected.length > 0 &&
    params.prefer !== "ictihat" &&
    (!params.type || params.type === "yasa");
  const primaryRows: StoreRow[] = [];
  if (injectPrimary) {
    for (const concept of primaryConcepts) {
      if (!concept.primary?.length) continue;
      const conceptRowsForPrimary = await fetchRows(conceptMatch(concept), {
        doc_ids: concept.primary,
        boost_ids: [],
      });
      const found = new Set<string>();
      for (const row of conceptRowsForPrimary) {
        const id = String(row.id);
        if (found.has(id)) continue;
        found.add(id);
        primaryRows.push(row);
      }
      const missing = concept.primary.filter((id) => !found.has(id));
      // Title fallback is safe only without source/year/court filters; the
      // primary query above already applied those filters.
      if (missing.length && !params.source && !params.year && !params.court) {
        const lookup = primaryDocsSql(missing);
        primaryRows.push(...(await store.all(lookup.sql, lookup.binds)));
      }
    }
  }

  const primaryOrder = new Map<string, number>();
  let primaryRank = 0;
  for (const concept of primaryConcepts) {
    for (const id of concept.primary ?? []) {
      if (!primaryOrder.has(id)) primaryOrder.set(id, primaryRank++);
    }
  }
  primaryRows.sort(
    (a, b) =>
      (primaryOrder.get(String(a.id)) ?? 999) - (primaryOrder.get(String(b.id)) ?? 999),
  );

  const byId = new Map<string, { row: StoreRow; score: number }>();
  for (const row of rows) {
    const id = String(row.id);
    byId.set(id, { row, score: -Number(row.rank ?? 0) });
  }
  for (const row of conceptRows) {
    const id = String(row.id);
    const score = -Number(row.rank ?? 0) + CONCEPT_BOOST;
    const existing = byId.get(id);
    if (!existing || score > existing.score) byId.set(id, { row, score });
  }
  for (const row of primaryRows) {
    const id = String(row.id);
    // Canonical statutes are an editorial decision, not a BM25 accident.
    byId.set(id, { row, score: 120 });
  }
  const deduped = [...byId.values()].sort((a, b) => {
    const difference = b.score - a.score;
    if (difference !== 0) return difference;
    return (
      (primaryOrder.get(String(a.row.id)) ?? 999) -
      (primaryOrder.get(String(b.row.id)) ?? 999)
    );
  });
  const conceptDocuments = new Set(conceptRows.map((row) => String(row.id))).size;
  const primaryDocuments = new Set(primaryRows.map((row) => String(row.id))).size;

  const minScore = Math.max(0, Number(params.min_score ?? 0));
  const filtered = minScore > 0 ? deduped.filter((item) => item.score >= minScore) : deduped;
  const page = filtered.slice(params.offset, params.offset + params.limit);

  const typeById = new Map(page.map(({ row }) => [String(row.id), String(row.type)]));
  const legislationIds = [
    ...new Set(
      page
        .map(({ row }) => String(row.id))
        .filter((id) => LEGISLATION_TYPES.has(typeById.get(id) ?? "")),
    ),
  ];
  const chunkQuery = chunksForDocsSql(legislationIds);
  const chunkRows = legislationIds.length ? await store.all(chunkQuery.sql, chunkQuery.binds) : [];
  const chunksByDoc = new Map<string, StoreRow[]>();
  for (const chunk of chunkRows) {
    const docId = String(chunk.doc_id);
    const list = chunksByDoc.get(docId) ?? [];
    list.push(chunk);
    chunksByDoc.set(docId, list);
  }

  const results: SearchResult[] = page.map(({ row, score }) => {
    const summary = mapSummary(row, origin);
    const rawRef = asString(row.matched_ref);
    const base = baseArticleRef(rawRef);
    const isArticle = !!base && LEGISLATION_TYPES.has(summary.type);
    let matchedRef = rawRef;
    let matchedPartValue: string | null = null;
    let matchedText: string | null = null;
    let matchedTextTruncated = false;
    let matchedUrl: string | null = null;
    let snippet = makeSnippet(String(row.chunk_text ?? ""), params.q);

    if (isArticle && base) {
      matchedRef = base;
      matchedPartValue = rawRef ? matchedPart(rawRef, base) : null;
      const parts = (chunksByDoc.get(summary.id) ?? []).filter(
        (chunk) => baseArticleRef(asString(chunk.ref)) === base,
      );
      if (parts.length) {
        const full = parts
          .map((chunk) => String(chunk.text))
          .join("\n\n")
          .trim();
        const capped = capText(full, MATCHED_TEXT_LIMIT);
        matchedText = capped.text;
        matchedTextTruncated = capped.truncated;
        // Show the clause from the whole article, not only the matched part.
        snippet = makeSnippet(full, params.q);
      }
      matchedUrl = articleUrl(origin, summary.id, base);
    }

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
      citation: summary.citation,
      consolidated_through: summary.consolidated_through,
      text_status: summary.text_status,
      content_chars: summary.content_chars,
      chunk_count: summary.chunk_count,
      matched_ref: matchedRef,
      matched_part: matchedPartValue,
      matched_kind: String(row.matched_kind ?? ""),
      matched_text: matchedText,
      matched_text_truncated: matchedTextTruncated,
      matched_url: matchedUrl,
      snippet,
      highlights: makeHighlights(snippet, params.q),
      score: Number(score.toFixed(6)),
      url: summary.url,
      source_url: summary.source_url,
    };
  });

  const groups: SearchResponse["groups"] = { mevzuat: [], ictihat: [] };
  for (const { row, score } of filtered) {
    const type = String(row.type);
    const key = type === "karar" ? "ictihat" : LEGISLATION_TYPES.has(type) ? "mevzuat" : null;
    if (!key || groups[key].length >= 3) continue;
    const summary = mapSummary(row, origin);
    groups[key].push({
      id: summary.id,
      type: summary.type,
      title: summary.title,
      citation: summary.citation,
      matched_ref: asString(row.matched_ref),
      text_status: summary.text_status,
      score: Number(score.toFixed(6)),
    });
  }

  const nextOffset = params.offset + results.length;
  const hasMore = filtered.length > nextOffset;
  const nextParams: Record<string, string> = { q: params.q };
  if (relaxed) nextParams.mode = "any";
  else if (params.mode && params.mode !== "auto") nextParams.mode = params.mode;
  if (params.type) nextParams.type = params.type;
  if (params.year) nextParams.year = String(params.year);
  if (params.source) nextParams.source = params.source;
  if (params.court) nextParams.court = params.court;
  if (params.prefer) nextParams.prefer = params.prefer;
  if (minScore > 0) nextParams.min_score = String(minScore);
  nextParams.limit = String(params.limit);
  nextParams.offset = String(nextOffset);
  const next = hasMore ? `${origin}/v1/search?${new URLSearchParams(nextParams).toString()}` : null;

  return {
    query: params.q,
    mode: params.mode ?? "auto",
    effective_mode: effectiveMode,
    relaxed,
    concepts: detected.map((concept) => ({ id: concept.id, label: concept.label })),
    concept_expanded: concepts.length > 0,
    concept_documents: conceptDocuments,
    primary_documents: primaryDocuments,
    filters: {
      type: params.type ?? null,
      year: params.year ?? null,
      source: params.source ?? null,
      court: params.court ?? null,
      prefer: searchParams.prefer ?? null,
      min_score: minScore,
    },
    count: results.length,
    candidate_documents: candidate,
    relevant_documents: filtered.length,
    total_documents: candidate,
    min_score: minScore,
    has_more: next !== null,
    next,
    groups,
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
  const [metaRows, types, years, sources, status, latest, courts] = await Promise.all([
    store.all(STATS_SQL.meta),
    store.all(STATS_SQL.types),
    store.all(STATS_SQL.years),
    store.all(STATS_SQL.sources),
    store.all(STATS_SQL.status),
    store.all(STATS_SQL.latest),
    store.all(STATS_SQL.courts),
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
      courts,
      type_labels: TYPE_LABELS,
    },
    _meta: apiMeta(origin),
  };
}

export function documentMarkdown(doc: DocumentDetail, origin: string): string {
  const label = TYPE_LABELS[doc.type] ?? doc.type;
  const lines = [`# ${doc.title}`, ""];
  lines.push(`- **Atıf:** ${doc.citation}`);
  const consolidated = consolidationLabel(doc.consolidated_through);
  if (consolidated) lines.push(`- **Güncellik:** ${consolidated}`);
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
