import {
  articleListSql,
  articleSql,
  buildCountSql,
  buildSearchSql,
  buildSearchSqlFull,
  ARTICLE_PAIRS_PER_QUERY,
  CHUNK_PAIRS_PER_QUERY,
  chunkRowsSql,
  chunksForArticlesSql,
  chunksSql,
  documentSql,
  inDocArticlesSql,
  primaryDocsSql,
  recentSql,
  STATS_SQL,
} from "./sql.js";
import { buildCitation } from "./citation.js";
import { conceptMatch, type LegalConcept, matchConcepts } from "./legal-concepts.js";
import { ANSWER_PASSAGES, RERANK_CANDIDATES, RerankLimitError, wantsRerank } from "./rerank.js";
import { legislationTitles } from "./titles.js";
import { resolveLaws, RewriteLimitError } from "./rewrite.js";
import { reciprocalRankFusion, type SemanticHit, wantsSemantic } from "./semantic.js";
import {
  baseArticleRef,
  buildMatch,
  clefPassage,
  foldTr,
  makeHighlights,
  makeSnippet,
  normalizeArticleRef,
  stemCoverage,
  stemMatch,
  truncate,
} from "./text.js";
import {
  type AnswerQuote,
  type AnswerResponse,
  type ApiMeta,
  type ArticleResponse,
  type Chunk,
  type DocumentDetail,
  type DocumentResponse,
  type DocumentSummary,
  type QueryRewriteInfo,
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
const SEMANTIC_TOP_K = 30;
/** Articles per document at most (the public API allows 3; the answer focus step more). */
const MAX_PASSAGES = 20;
/**
 * Articles of the chosen statute shown to Clef in the focus step (default).
 * Measured 2026-11-09 (eval-answer, 55 answerable + 7 unanswerable questions,
 * live Clef): right article first 40.0% -> 52.7% with focus=12 (16: same),
 * "high" right 20/35 -> 25/36, unanswerable "low" 6/7 unchanged, +0.7-0.9 s.
 */
export const FOCUS_DEFAULT = 12;
/**
 * focus2=1 only: below this first-step probability ("high"), the focus step
 * covers the two leading statutes. Measured 2026-11-09 against the single
 * statute focus: right article first 52.7% -> 50.9%, "high" right 28/35 ->
 * 27/36, so it stays off by default.
 */
const FOCUS_TWO_BELOW = 0.7;
/** ... if the second statute got at least this much of Clef's probability. */
const FOCUS_TWO_MIN_MASS = 0.05;

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

/** Set once per isolate when D1's chunks_fts lacks the scope column. */
let ftsScopeMissing = false;

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
  const concepts = queryWords >= 4 || naturalQuestion ? [...detected] : [];
  // Only the leading concept(s) contribute canonical statutes; otherwise a
  // generic trigger such as "ceza" injects the Criminal Code into tax queries.
  const topConceptScore = conceptMatches[0]?.score ?? 0;
  const primaryConcepts = conceptMatches
    .filter((match) => match.score >= topConceptScore * 0.85)
    .map((match) => match.concept);

  // LLM rewrite (answers only): its legal terms become one more concept
  // channel and its statute names canonical statutes, after the dictionary's.
  // It runs while the main lexical query does (rewrite_wait=1: before it, so
  // its statutes also get the ranking boost there).
  let semanticText = params.q;
  const rewriteTask =
    params.rewrite && store.rewriter && !params.doc_ids?.length ? runRewrite(store, params) : null;
  const applyRewrite = (result: { info: QueryRewriteInfo; concept: LegalConcept | null }) => {
    const { info, concept } = result;
    if (concept) {
      if (info.terms.length) {
        concepts.push(concept);
        semanticText = `${params.q} ${info.terms.join(" ")}`;
      }
      detected.push(concept);
      if (info.documents.length) primaryConcepts.push(concept);
    }
    params.rewrite_sink?.push(info);
  };
  if (rewriteTask && params.rewrite_wait) applyRewrite(await rewriteTask);
  const primaryIds = [...new Set(primaryConcepts.flatMap((concept) => concept.primary ?? []))];
  const searchParams: SearchParams = {
    ...params,
    prefer: params.prefer ?? (detected.length > 0 ? "mevzuat" : undefined),
    boost_ids: primaryIds,
  };

  const fetchRows = async (match: string, overrides: Partial<SearchParams> = {}) => {
    const merged = { ...searchParams, ...overrides };
    if (!ftsScopeMissing) {
      const search = buildSearchSql(match, merged);
      try {
        return await store.all(search.sql, search.binds);
      } catch (error) {
        // D1 not yet re-imported with the FTS "scope" column: use the old
        // single query until the next full import (and remember that).
        if (!/no such column|scope/i.test(String(error instanceof Error ? error.message : error))) throw error;
        ftsScopeMissing = true;
        console.warn("chunks_fts has no scope column yet; using the full-scan search");
      }
    }
    const search = buildSearchSqlFull(match, merged);
    return store.all(search.sql, search.binds);
  };

  const run = async (match: string) => fetchRows(match);

  let rows = await run(initialMatch);
  let effectiveMatch = initialMatch;
  let effectiveMode: "all" | "any" | "phrase" = initialMode;
  let relaxed = false;
  if (requestedMode === "auto" && rows.length === 0) {
    const relaxedMatch = buildMatch(params.q, "any");
    if (relaxedMatch && relaxedMatch !== initialMatch) {
      const retry = await run(relaxedMatch);
      if (retry.length > 0) {
        rows = retry;
        effectiveMatch = relaxedMatch;
        effectiveMode = "any";
        relaxed = true;
      }
    }
  }

  if (rewriteTask && !params.rewrite_wait) applyRewrite(await rewriteTask);

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
    const questionMatch = stemMatch(params.q);
    for (const concept of primaryConcepts) {
      if (!concept.primary?.length) continue;
      // Pick each canonical law's best *article* for this question, ranked on
      // the question's own word stems ("oranı" also finds "oranları") together
      // with the concept vocabulary ("2/3", "katkı payı"). Titles are excluded: the
      // concept words are in the law's title, which used to win and became
      // the quoted "answer".
      const found = new Set<string>();
      const take = (rows: StoreRow[]) => {
        for (const row of rows) {
          const id = String(row.id);
          if (found.has(id)) continue;
          found.add(id);
          primaryRows.push(row);
        }
      };
      const within = { doc_ids: concept.primary, boost_ids: [], exclude_title: true };
      const vocabulary = conceptMatch(concept);
      take(await fetchRows(questionMatch ? `(${questionMatch}) OR ${vocabulary}` : vocabulary, within));
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

  // Every matching article per document, best first, for other_passages.
  const passagesPerDoc = Math.min(MAX_PASSAGES, Math.max(1, params.passages ?? 1));
  const refsByDoc = new Map<string, string[]>();
  const noteRef = (docId: string, ref: unknown) => {
    if (passagesPerDoc < 2) return;
    const base = baseArticleRef(asString(ref));
    if (!base) return;
    const list = refsByDoc.get(docId) ?? [];
    if (!list.includes(base)) list.push(base);
    refsByDoc.set(docId, list);
  };
  let semanticHits: SemanticHit[] = [];

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
  const byScore = (a: { row: StoreRow; score: number }, b: { row: StoreRow; score: number }) => {
    const difference = b.score - a.score;
    if (difference !== 0) return difference;
    return (
      (primaryOrder.get(String(a.row.id)) ?? 999) -
      (primaryOrder.get(String(b.row.id)) ?? 999)
    );
  };
  let deduped = [...byId.values()].sort(byScore);

  // Hybrid ranking: fuse the lexical order with the vector index (articles of
  // legislation only). Canonical statutes keep their editorial top place.
  const semanticInfo = { available: !!store.semantic, used: false, hits: 0, documents: 0 };
  const legislationScope = !params.type || LEGISLATION_TYPES.has(params.type);
  if (
    store.semantic &&
    params.semantic !== false &&
    legislationScope &&
    params.prefer !== "ictihat" &&
    !params.court &&
    !params.doc_ids?.length &&
    wantsSemantic(params.q, requestedMode)
  ) {
    let hits: SemanticHit[] = [];
    try {
      hits = await store.semantic.query(semanticText, { topK: SEMANTIC_TOP_K, type: params.type });
    } catch (error) {
      // The index is optional (e.g. not filled yet); lexical search still works.
      console.warn("semantic search unavailable:", error instanceof Error ? error.message : error);
    }
    semanticHits = hits;
    params.semantic_sink?.push(...hits);
    const bestHit = new Map<string, SemanticHit>();
    for (const hit of hits) if (!bestHit.has(hit.doc_id)) bestHit.set(hit.doc_id, hit);
    if (bestHit.size) {
      // Rows for documents the lexical channel missed, or only matched by title.
      const needed = [...bestHit.values()].filter((hit) => {
        const existing = byId.get(hit.doc_id);
        return !existing || String(existing.row.matched_kind) === "title";
      });
      for (let i = 0; i < needed.length; i += CHUNK_PAIRS_PER_QUERY) {
        const query = chunkRowsSql(
          needed.slice(i, i + CHUNK_PAIRS_PER_QUERY).map((hit) => ({ docId: hit.doc_id, ord: hit.ord })),
        );
        for (const row of await store.all(query.sql, query.binds)) {
          if (params.year && Number(row.year) !== params.year) continue;
          if (params.source && String(row.source) !== params.source) continue;
          if (params.type && String(row.type) !== params.type) continue;
          const id = String(row.id);
          const existing = byId.get(id);
          byId.set(id, { row, score: existing?.score ?? 0 });
        }
      }
      const lexicalOrder = deduped.map(({ row }) => String(row.id));
      const semanticOrder = [...bestHit.keys()].filter((id) => byId.has(id));
      const fused = reciprocalRankFusion([lexicalOrder, semanticOrder]);
      const primaryIdSet = new Set(primaryRows.map((row) => String(row.id)));
      deduped = [...byId.values()]
        .map(({ row }) => {
          const id = String(row.id);
          // RRF on a 0-100-ish scale; canonical statutes stay at 120.
          return { row, score: primaryIdSet.has(id) ? 120 : Number(((fused.get(id) ?? 0) * 3000).toFixed(3)) };
        })
        .sort(byScore);
      semanticInfo.used = true;
      semanticInfo.hits = hits.length;
      semanticInfo.documents = semanticOrder.length;
    }
  }
  const conceptDocuments = new Set(conceptRows.map((row) => String(row.id))).size;
  const primaryDocuments = new Set(primaryRows.map((row) => String(row.id))).size;

  let candidate = deduped.length;
  if (params.exact_count) {
    const count = buildCountSql(effectiveMatch, searchParams);
    const countRow = await store.first(count.sql, count.binds);
    candidate = Number(countRow?.n ?? 0);
  }

  const minScore = Math.max(0, Number(params.min_score ?? 0));
  const filtered = minScore > 0 ? deduped.filter((item) => item.score >= minScore) : deduped;
  const page = filtered.slice(params.offset, params.offset + params.limit);

  // Alternatives: the vector index's articles first (it ranks by meaning),
  // then the lexical, concept and canonical-statute matches.
  if (passagesPerDoc > 1) {
    // The vector index's articles first, then the statute's own best
    // articles for the question's words (found even when the global search
    // only reached the statute through another article), then the rest.
    const inDoc = await inDocArticles(store, params.q, page.map(({ row }) => row), ftsScopeMissing);
    const semanticRefs = new Map<string, string[]>();
    for (const hit of params.semantic_hits ?? semanticHits) {
      const base = baseArticleRef(asString(hit.ref));
      if (!base) continue;
      const list = semanticRefs.get(hit.doc_id) ?? [];
      if (!list.includes(base)) list.push(base);
      semanticRefs.set(hit.doc_id, list);
    }
    for (const docId of new Set([...semanticRefs.keys(), ...inDoc.keys()])) {
      const a = semanticRefs.get(docId) ?? [];
      const b = inDoc.get(docId) ?? [];
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (i < a.length) noteRef(docId, a[i]);
        if (i < b.length) noteRef(docId, b[i]);
      }
    }
    for (const row of [...rows, ...conceptRows, ...primaryRows]) noteRef(String(row.id), row.matched_ref);
  }
  const alternatesByDoc = new Map<string, string[]>();
  const pairs = new Map<string, { docId: string; ref: string }>();
  for (const { row } of page) {
    if (!LEGISLATION_TYPES.has(String(row.type))) continue;
    const docId = String(row.id);
    const base = baseArticleRef(asString(row.matched_ref));
    if (base) pairs.set(`${docId}\u0000${base}`, { docId, ref: base });
    if (passagesPerDoc > 1) {
      const alternates = (refsByDoc.get(docId) ?? []).filter((ref) => ref !== base).slice(0, passagesPerDoc - 1);
      alternatesByDoc.set(docId, alternates);
      for (const ref of alternates) pairs.set(`${docId}\u0000${ref}`, { docId, ref });
    }
  }
  const pairList = [...pairs.values()];
  const batches: { docId: string; ref: string }[][] = [];
  for (let i = 0; i < pairList.length; i += ARTICLE_PAIRS_PER_QUERY) {
    batches.push(pairList.slice(i, i + ARTICLE_PAIRS_PER_QUERY));
  }
  const chunkRows = (
    await Promise.all(
      batches.map((batch) => {
        const query = chunksForArticlesSql(batch);
        return store.all(query.sql, query.binds);
      }),
    )
  ).flat();
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

    let otherPassages: SearchResult["other_passages"];
    if (passagesPerDoc > 1) {
      otherPassages = [];
      for (const ref of alternatesByDoc.get(summary.id) ?? []) {
        const full = (chunksByDoc.get(summary.id) ?? [])
          .filter((chunk) => baseArticleRef(asString(chunk.ref)) === ref)
          .map((chunk) => String(chunk.text))
          .join("\n\n")
          .trim();
        if (!full) continue;
        otherPassages.push({
          ref,
          text: capText(full, MATCHED_TEXT_LIMIT).text,
          snippet: makeSnippet(full, params.q),
          url: articleUrl(origin, summary.id, ref),
        });
      }
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
      ...(otherPassages ? { other_passages: otherPassages } : {}),
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
  if (params.exact_count) nextParams.exact_count = "1";
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
    semantic: semanticInfo,
    ranking: semanticInfo.used ? "hybrid" : "lexical",
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
    exact_count: Boolean(params.exact_count),
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

/**
 * Extractive answer: retrieval-only. It returns the best passages verbatim
 * with citations; it never generates or paraphrases legal text.
 */
export async function answerQuestion(
  store: Store,
  params: SearchParams,
  origin: string,
): Promise<AnswerResponse> {
  const limit = Math.min(5, Math.max(1, params.limit));
  const reranker = params.rerank !== false && wantsRerank(params.q, params.mode) ? store.rerank : undefined;
  // With reranking, Clef sees RERANK_CANDIDATES passages: either the best
  // article of that many documents, or several articles of fewer documents
  // (the right law with the wrong article was the main miss on 2026-11-04).
  const passages = reranker ? Math.min(3, Math.max(1, params.passages ?? ANSWER_PASSAGES)) : 1;
  const semanticSink: { doc_id: string; ref: string | null }[] = [];
  const rewriteSink: QueryRewriteInfo[] = [];
  const statuteFirst = params.statute_first !== false && !asksRegulation(params.q);
  const search = await searchDocuments(
    store,
    {
      ...params,
      semantic_sink: semanticSink,
      rewrite: !!reranker && params.rewrite !== false,
      rewrite_sink: rewriteSink,
      statute_first: statuteFirst,
      prefer: params.prefer ?? "mevzuat",
      limit: reranker ? Math.max(limit, Math.ceil(RERANK_CANDIDATES / passages)) : limit,
      passages,
    },
    origin,
  );

  // Only quote provisions: a law's title or a document without text is not
  // an answer to anything.
  const rounds: Passage[][] = [[]];
  for (const result of search.results) {
    if (result.text_status === "metadata") continue;
    if (result.snippet && result.matched_kind !== "title") {
      rounds[0].push({
        result,
        ref: result.matched_ref,
        text: result.matched_text || result.snippet,
        snippet: result.snippet,
        url: result.matched_url ?? result.url,
      });
    }
    (result.other_passages ?? []).forEach((other, i) => {
      (rounds[i + 1] ??= []).push({ result, ref: other.ref, text: other.text, snippet: other.snippet, url: other.url });
    });
  }
  // Best article of every document first, then each document's second, ...
  // With statute_first, regulations only fill slots the laws left free.
  let candidates: Passage[] = statuteFirst ? lawsBeforeRegulations(rounds.flat()) : rounds.flat();
  let probabilities: number[] | null = null;
  let rerank: AnswerResponse["rerank"];
  if (reranker && candidates.length > 1) {
    candidates = candidates.slice(0, RERANK_CANDIDATES);
    try {
      const result = await reranker.rerank(
        params.q,
        candidates.map((c) => ({
          label: `${c.result.citation ?? c.result.title}${c.ref ? `, ${c.ref}` : ""}`,
          text: params.window === false ? c.text : clefPassage(c.text, params.q),
        })),
      );
      const order = candidates
        .map((c, i) => ({ c, i, p: result.probabilities[i] ?? 0 }))
        .sort((a, b) => b.p - a.p || a.i - b.i);
      candidates = order.map((o) => o.c);
      probabilities = order.map((o) => o.p);
      rerank = {
        model: result.model,
        applied: true,
        candidates: order.length,
        passages_per_document: passages,
        top_probability: round3(order[0]?.p ?? 0),
        none_probability: round3(result.none),
        ...(params.debug
          ? {
              debug_candidates: order.map((o) => ({
                document_id: o.c.result.id,
                ref: o.c.ref,
                probability: round3(o.p),
              })),
            }
          : {}),
      };
    } catch (error) {
      // Quota, timeout or an unexpected answer: keep today's ranking.
      console.warn("rerank failed:", error instanceof Error ? error.message : error);
      rerank = {
        model: "clef-flash",
        applied: false,
        error: error instanceof RerankLimitError ? "daily_limit" : "unavailable",
        ...(params.debug ? { error_detail: (error instanceof Error ? error.message : String(error)).slice(0, 300) } : {}),
      };
      candidates = rounds[0];
    }
  }

  // Focus: Clef found the statute but often not the article (the right law
  // with the wrong article was the largest miss on 2026-11-09). Ask again
  // among up to `focus` articles of the chosen statute; when Clef was not
  // sure of it (below "high"), of the two leading statutes together.
  const focusCount = params.focus ?? FOCUS_DEFAULT;
  if (focusCount > 1 && reranker && rerank?.applied && probabilities && candidates.length) {
    const probs = probabilities;
    const none = rerank.none_probability ?? 0;
    const massOf = (id: string) => candidates.reduce((sum, c, i) => sum + (c.result.id === id ? probs[i] ?? 0 : 0), 0);
    const laws: SearchResult[] = [];
    for (const c of candidates) {
      if (!LEGISLATION_TYPES.has(c.result.type) || !c.ref || laws.some((law) => law.id === c.result.id)) continue;
      laws.push(c.result);
      if (laws.length === 2) break;
    }
    const first = candidates[0].result;
    if (laws[0]?.id === first.id && none < (probs[0] ?? 0)) {
      const second = laws[1];
      const both = params.focus_two === true && (probs[0] ?? 0) < FOCUS_TWO_BELOW && second && massOf(second.id) >= FOCUS_TWO_MIN_MASS;
      const targets = both
        ? [
            { law: first, count: Math.ceil(focusCount * 0.6) },
            { law: second, count: focusCount - Math.ceil(focusCount * 0.6) },
          ]
        : [{ law: first, count: focusCount }];
      const focus = await focusStatutes(store, reranker, params, origin, targets, candidates, semanticSink);
      rerank.focus = focus.info;
      if (focus.passages) {
        const focused = new Set(targets.map((t) => t.law.id));
        const rest = candidates
          .map((c, i) => ({ c, p: probs[i] ?? 0 }))
          .filter(({ c }) => !focused.has(c.result.id));
        // Reported probability: the article's within the focused statutes,
        // capped by how sure the first step was about those statutes.
        const mass = targets.reduce((sum, t) => sum + massOf(t.law.id), 0);
        candidates = [...focus.passages.map((f) => f.passage), ...rest.map((r) => r.c)];
        probabilities = [...focus.passages.map((f) => Math.min(f.p, mass)), ...rest.map((r) => r.p)];
        rerank.top_probability = round3(probabilities[0] ?? 0);
        if (params.debug) {
          rerank.debug_candidates = [
            ...focus.passages.map((f) => ({ document_id: f.passage.result.id, ref: f.passage.ref, probability: round3(f.p) })),
            ...(rerank.debug_candidates ?? []),
          ];
        }
      }
    }
  }

  const quotes: AnswerQuote[] = [];
  for (const [index, passage] of candidates.entries()) {
    if (quotes.length >= limit) break;
    const result = passage.result;
    quotes.push({
      document_id: result.id,
      title: result.title,
      ref: passage.ref,
      citation: result.citation,
      text: passage.snippet,
      url: passage.url,
      source_url: result.source_url,
      text_status: result.text_status,
      // Measured on the quoted window itself: that is what the reader gets.
      coverage: stemCoverage(passage.snippet, params.q),
      score: result.score,
      ...(probabilities ? { probability: round3(probabilities[index]) } : {}),
    });
  }

  // Confidence describes the quoted passage, not the ranking score (canonical
  // laws carry a fixed editorial score that says nothing about the passage).
  const top = quotes[0];
  const covered = top ? top.coverage.total === 0 || top.coverage.found / top.coverage.total >= 0.5 : false;
  const confidence: AnswerResponse["confidence"] = !top
    ? "low"
    : rerank?.applied
      ? // Clef's probability is the measured, better-calibrated signal here.
        // A regulation quoted for a general question is at most "medium":
        // the parent law may say otherwise or more.
        capRegulation(
          rerankConfidence(rerank.top_probability ?? 0, rerank.none_probability ?? 0),
          statuteFirst && candidates[0]?.result.type === "tuzuk",
        )
      : top.text_status === "full" && covered && top.coverage.found >= Math.min(2, top.coverage.total)
      ? "high"
      : top.coverage.found > 0
        ? "medium"
        : "low";

  return {
    query: params.q,
    answer: top?.text ?? null,
    answer_type: "extractive",
    quotes,
    citations: [...new Set(quotes.map((quote) => quote.citation))],
    confidence,
    ...(rewriteSink[0] ? { query_rewrite: rewriteSink[0] } : {}),
    ...(rerank ? { rerank } : {}),
    concepts: search.concepts,
    disclaimer:
      "Bu yanıt metinden birebir alıntıdır; hukuki yorum veya bağlayıcı görüş değildir. " +
      "Resmî/bağlayıcı metin için source_url bağlantısına başvurun.",
    _meta: apiMeta(origin),
  };
}

type Passage = { result: SearchResult; ref: string | null; text: string; snippet: string; url: string };

async function focusStatutes(
  store: Store,
  reranker: NonNullable<Store["rerank"]>,
  params: SearchParams,
  origin: string,
  targets: { law: SearchResult; count: number }[],
  seen: Passage[],
  semanticHits: { doc_id: string; ref: string | null }[],
): Promise<{ info: NonNullable<NonNullable<AnswerResponse["rerank"]>["focus"]>; passages?: { passage: Passage; p: number }[] }> {
  const info: NonNullable<NonNullable<AnswerResponse["rerank"]>["focus"]> = {
    document_id: targets[0].law.id,
    ...(targets.length > 1 ? { document_ids: targets.map((t) => t.law.id) } : {}),
    candidates: 0,
    applied: false,
  };
  const lists = await Promise.all(
    targets.map(async ({ law, count }) => {
      // Articles Clef already saw for this statute lead the vector hits.
      const hints = [
        ...seen.filter((c) => c.result.id === law.id).map((c) => ({ doc_id: law.id, ref: c.ref })),
        ...semanticHits.filter((hit) => hit.doc_id === law.id),
      ];
      const search = await searchDocuments(
        store,
        {
          q: params.q,
          mode: params.mode,
          doc_ids: [law.id],
          exclude_title: true,
          semantic_hits: hints,
          passages: count,
          limit: 1,
          offset: 0,
        },
        origin,
      );
      // What Clef already saw for this statute comes first and always stays in.
      const passages: Passage[] = seen.filter((c) => c.result.id === law.id);
      const result = search.results.find((r) => r.id === law.id);
      if (result?.matched_ref && result.matched_kind !== "title") {
        passages.push({
          result: law,
          ref: result.matched_ref,
          text: result.matched_text || result.snippet,
          snippet: result.snippet,
          url: result.matched_url ?? result.url,
        });
      }
      for (const other of result?.other_passages ?? []) {
        passages.push({ result: law, ref: other.ref, text: other.text, snippet: other.snippet, url: other.url });
      }
      return passages.filter((p, i) => passages.findIndex((q) => q.ref === p.ref) === i).slice(0, Math.max(count, 2));
    }),
  );
  const unique = lists.flat();
  info.candidates = unique.length;
  if (unique.length < 2) return { info };
  try {
    const answer = await reranker.rerank(
      params.q,
      unique.map((c) => ({
        label: `${c.result.citation ?? c.result.title}${c.ref ? `, ${c.ref}` : ""}`,
        text: params.window === false ? c.text : clefPassage(c.text, params.q),
      })),
    );
    const order = unique
      .map((passage, i) => ({ passage, i, p: answer.probabilities[i] ?? 0 }))
      .sort((a, b) => b.p - a.p || a.i - b.i);
    info.applied = true;
    info.top_probability = round3(order[0]?.p ?? 0);
    info.none_probability = round3(answer.none);
    // "None of these articles": keep the first step's choice.
    if (answer.none >= (order[0]?.p ?? 0)) return { info };
    return { info, passages: order.map(({ passage, p }) => ({ passage, p })) };
  } catch (error) {
    info.error = error instanceof RerankLimitError ? "daily_limit" : "unavailable";
    return { info };
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Thresholds from the 2026-11-04 measurement: for questions, Clef's top
 * probability >= 0.7 was right about two times in three and >= 0.9 four in
 * five; below ~0.35 the top passage was usually wrong.
 */
/** The question itself asks for a regulation, so regulations are not ranked lower. */
export function asksRegulation(question: string): boolean {
  return /t[uü]z[uü][kğ]|y[oö]netmeli[kğ]|usul ve esas/.test(question.toLocaleLowerCase("tr"));
}

/** Stable: laws (and the constitution) first, regulations after, each in their order. */
export function lawsBeforeRegulations<T extends { result: { type: string } }>(candidates: T[]): T[] {
  return [...candidates.filter((c) => c.result.type !== "tuzuk"), ...candidates.filter((c) => c.result.type === "tuzuk")];
}

export function capRegulation(confidence: AnswerResponse["confidence"], regulation: boolean): AnswerResponse["confidence"] {
  return regulation && confidence === "high" ? "medium" : confidence;
}

export function rerankConfidence(top: number, none: number): AnswerResponse["confidence"] {
  if (none >= top) return "low";
  if (top >= 0.7) return "high";
  if (top >= 0.35) return "medium";
  return "low";
}

export function answerMarkdown(response: AnswerResponse): string {
  const lines: string[] = ["## Alıntı yanıt", ""];
  if (!response.quotes.length) {
    lines.push("_Bu soru için alıntılanabilir bir hüküm bulunamadı._");
  } else {
    const quote = response.quotes[0];
    lines.push(`> ${quote.text.replace(/\n+/g, " ")}`, "");
    lines.push(`- **Atıf:** ${quote.citation}`);
    if (quote.ref) lines.push(`- **Madde:** ${quote.ref}`);
    lines.push(`- **Kaynak:** ${quote.source_url}`);
    lines.push(`- **API:** ${quote.url}`);
    lines.push(`- **Güven:** ${response.confidence}`);
    if (response.quotes.length > 1) {
      lines.push("", "### Diğer ilgili pasajlar", "");
      for (const other of response.quotes.slice(1)) {
        lines.push(`- ${other.citation}${other.ref ? `, ${other.ref}` : ""} — ${other.url}`);
      }
    }
  }
  lines.push("", `> ${response.disclaimer}`, "", `API: ${response._meta.docs}`);
  return lines.join("\n");
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
  const metaRows = await store.all(STATS_SQL.meta);
  const meta: Record<string, unknown> = {};
  for (const row of metaRows) {
    try {
      meta[String(row.key)] = JSON.parse(String(row.value));
    } catch {
      meta[String(row.key)] = row.value;
    }
  }
  // New builds carry the whole stats payload in one meta row. Fall back to the
  // seven live GROUP BY queries only for databases built before that change.
  if (meta.stats && typeof meta.stats === "object") {
    const { stats: _precomputed, ...base } = meta;
    return {
      stats: {
        ...base,
        ...(meta.stats as Record<string, unknown>),
        history: meta.history,
        type_labels: TYPE_LABELS,
      },
      _meta: apiMeta(origin),
    };
  }

  const [types, years, sources, status, latest, courts] = await Promise.all([
    store.all(STATS_SQL.types),
    store.all(STATS_SQL.years),
    store.all(STATS_SQL.sources),
    store.all(STATS_SQL.status),
    store.all(STATS_SQL.latest),
    store.all(STATS_SQL.courts),
  ]);
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

async function runRewrite(
  store: Store,
  params: SearchParams,
): Promise<{ info: QueryRewriteInfo; concept: LegalConcept | null }> {
  const info: QueryRewriteInfo = { terms: [], laws: [], documents: [] };
  try {
    const rewrite = await store.rewriter!.rewrite(params.q, { model: params.rewrite_model });
    info.terms = rewrite.terms;
    info.laws = rewrite.laws;
    if (rewrite.cached) info.cached = true;
    info.documents = rewrite.laws.length ? resolveLaws(await legislationTitles(store), rewrite.laws) : [];
    if (!info.terms.length && !info.documents.length) return { info, concept: null };
    return { info, concept: { id: "llm", label: "LLM", triggers: [], expand: info.terms, primary: info.documents, weight: 1 } };
  } catch (error) {
    info.error = error instanceof RewriteLimitError ? "daily_limit" : "unavailable";
    console.warn("query rewrite failed:", error instanceof Error ? error.message : error);
    return { info, concept: null };
  }
}

/** Statutes whose articles are searched again, per answer. */
const IN_DOC_STATUTES = 4;

/** Best articles for the question's stems inside the top statutes (doc id -> base refs, best first). */
async function inDocArticles(
  store: Store,
  q: string,
  rows: StoreRow[],
  ftsScopeMissing: boolean,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const stems = stemMatch(q);
  if (!stems || ftsScopeMissing) return result;
  const docIds = [...new Set(rows.filter((row) => LEGISLATION_TYPES.has(String(row.type))).map((row) => String(row.id)))].slice(
    0,
    IN_DOC_STATUTES,
  );
  if (!docIds.length) return result;
  const query = inDocArticlesSql(stems, docIds);
  let found: StoreRow[];
  try {
    found = await store.all(query.sql, query.binds);
  } catch (error) {
    // Extra candidates only; the answer still works without them.
    console.warn("in-statute article search failed", error);
    return result;
  }
  for (const row of found) {
    const base = baseArticleRef(asString(row.ref));
    if (!base) continue;
    const docId = String(row.doc_id);
    const list = result.get(docId) ?? [];
    if (!list.includes(base)) list.push(base);
    result.set(docId, list);
  }
  return result;
}
