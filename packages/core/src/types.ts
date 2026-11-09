/** Shared types for the KKTC mevzuat API. */
import type { Reranker } from "./rerank.js";
import type { SemanticIndex } from "./semantic.js";

export const DOC_TYPES = [
  "yasa",
  "tuzuk",
  "karar",
  "anayasa",
  "yonetmelik",
  "emirname",
  "kararname",
  "andlasma",
] as const;

export type DocType = (typeof DOC_TYPES)[number];

export const TYPE_LABELS: Record<string, string> = {
  yasa: "Yasa",
  tuzuk: "Tüzük",
  karar: "Mahkeme Kararı",
  anayasa: "Anayasa",
  yonetmelik: "Yönetmelik",
  emirname: "Emirname",
  kararname: "Kararname",
  andlasma: "Uluslararası Andlaşma",
};

export type StoreRow = Record<string, unknown>;

/** Minimal database seam shared by Cloudflare D1 and Node's node:sqlite. */
export interface Store {
  all(sql: string, binds?: unknown[]): Promise<StoreRow[]>;
  first(sql: string, binds?: unknown[]): Promise<StoreRow | null>;
  /** Optional vector index (Worker with Workers AI + Vectorize bindings). */
  semantic?: SemanticIndex;
  /** Optional answer reranker (Clef on Workers AI); used by answerQuestion. */
  rerank?: Reranker;
}

export interface SearchParams {
  q: string;
  mode?: "auto" | "all" | "any" | "phrase";
  type?: string;
  year?: number;
  source?: string;
  court?: string;
  prefer?: "mevzuat" | "ictihat";
  min_score?: number;
  /** Run the expensive COUNT(DISTINCT) query; off by default. */
  exact_count?: boolean;
  /** Internal: canonical statutes for the detected legal concept. */
  boost_ids?: string[];
  /** Internal: restrict to these document ids (primary-law lookup). */
  doc_ids?: string[];
  /** Internal: skip title chunks, so a law's best passage is an article. */
  exclude_title?: boolean;
  /** Use the vector index when available (default true). */
  semantic?: boolean;
  /** Rerank answer candidates with Clef when available (default true; answer only). */
  rerank?: boolean;
  /** Matching articles per document to return (1-3, default 1); extra ones go to other_passages. */
  passages?: number;
  /** /v1/answer: list every candidate the reranker saw (for measurement). */
  debug?: boolean;
  /** /v1/answer: after Clef picks a statute, ask again among this many of its articles (0 = off). */
  focus?: number;
  /** /v1/answer: when Clef is not sure of the statute, focus on the two leading ones (default true). */
  focus_two?: boolean;
  /** /v1/answer: show Clef the part of each article that matches the question (default true). */
  window?: boolean;
  /** Internal: receives the vector hits of this search (answer focus step). */
  semantic_sink?: { doc_id: string; ref: string | null }[];
  /** Internal: vector hits to use instead of querying the index (with doc_ids). */
  semantic_hits?: { doc_id: string; ref: string | null }[];
  limit: number;
  offset: number;
}

export interface SearchHighlight {
  start: number;
  end: number;
}

export interface SearchResult {
  id: string;
  type: string;
  subtype: string | null;
  title: string;
  number: string | null;
  year: number | null;
  date: string | null;
  source: string;
  court: string | null;
  citation: string;
  consolidated_through: string | null;
  text_status: string;
  content_chars: number;
  chunk_count: number;
  matched_ref: string | null;
  matched_part: string | null;
  matched_kind: string;
  /** Full matched article (laws/regulations), capped; null for decisions/titles. */
  matched_text: string | null;
  matched_text_truncated: boolean;
  /** Direct link to the matched article, when the hit is an article. */
  matched_url: string | null;
  snippet: string;
  highlights: SearchHighlight[];
  score: number;
  url: string;
  source_url: string;
  /**
   * Other matching articles of the same document (best first), only when
   * the request asks for more than one passage per document.
   */
  other_passages?: { ref: string; text: string; snippet: string; url: string }[];
}

export interface SearchGroupItem {
  id: string;
  type: string;
  title: string;
  citation: string;
  matched_ref: string | null;
  text_status: string;
  score: number;
}

export interface AnswerQuote {
  document_id: string;
  title: string;
  ref: string | null;
  citation: string;
  text: string;
  url: string;
  source_url: string;
  text_status: string;
  /** Query content words found in the quoted passage. */
  coverage: { found: number; total: number };
  score: number;
  /** Clef's probability that this passage answers the question (when reranked). */
  probability?: number;
}

export interface AnswerResponse {
  query: string;
  answer: string | null;
  answer_type: "extractive";
  quotes: AnswerQuote[];
  citations: string[];
  confidence: "high" | "medium" | "low";
  /** Present when the question went to the reranker. */
  rerank?: {
    model: string;
    applied: boolean;
    candidates?: number;
    passages_per_document?: number;
    /** Focus step: Clef asked again among more articles of its chosen statute. */
    focus?: { document_id: string; document_ids?: string[]; candidates: number; applied: boolean; top_probability?: number; none_probability?: number; error?: string };
    /** Only with debug=1: every candidate Clef saw, best first. */
    debug_candidates?: { document_id: string; ref: string | null; probability: number }[];
    top_probability?: number;
    none_probability?: number;
    error?: string;
    /** Only with debug=1. */
    error_detail?: string;
  };
  concepts: { id: string; label: string }[];
  disclaimer: string;
  _meta: ApiMeta;
}

export interface DocumentSummary {
  id: string;
  type: string;
  subtype: string | null;
  title: string;
  number: string | null;
  year: number | null;
  date: string | null;
  language: string;
  source: string;
  source_url: string;
  pdf_url: string | null;
  court: string | null;
  chamber: string | null;
  citation: string;
  /** Last amendment the consolidated text includes, e.g. "25/2026" or "2024-02-13". */
  consolidated_through: string | null;
  parties: string | null;
  subject: string | null;
  summary: string | null;
  content_chars: number;
  chunk_count: number;
  text_status: string;
  updated_at: string | null;
  extra: unknown;
  sources: unknown;
  url: string;
}

export interface Chunk {
  ord: number;
  kind: string;
  ref: string | null;
  text: string;
}

export interface DocumentDetail extends DocumentSummary {
  content: string;
  chunks?: Chunk[];
}

export interface ApiMeta {
  api: string;
  docs: string;
  openapi: string;
  mcp: string;
  hint: string;
  disclaimer: string;
  generated_at: string;
}

export interface SearchResponse {
  query: string;
  /** Requested mode; "auto" falls back from all to any. */
  mode: string;
  effective_mode: "all" | "any" | "phrase";
  relaxed: boolean;
  concepts: { id: string; label: string }[];
  concept_expanded: boolean;
  concept_documents: number;
  primary_documents: number;
  /** Hybrid ranking: lexical (BM25) fused with the vector index. */
  semantic: { available: boolean; used: boolean; hits: number; documents: number };
  ranking: "lexical" | "hybrid";
  filters: Record<string, string | number | null>;
  count: number;
  /** Distinct documents in the retrieved window (or exact FTS count). */
  candidate_documents: number;
  /** True when candidate_documents came from COUNT(DISTINCT). */
  exact_count: boolean;
  /** Distinct documents in the retrieved window passing min_score. */
  relevant_documents: number;
  /** Backwards-compatible alias of candidate_documents. */
  total_documents: number;
  min_score: number;
  has_more: boolean;
  next: string | null;
  groups: {
    mevzuat: SearchGroupItem[];
    ictihat: SearchGroupItem[];
  };
  results: SearchResult[];
  _meta: ApiMeta;
}

export interface DocumentResponse {
  document: DocumentDetail;
  _meta: ApiMeta;
}

export interface ArticleResponse {
  document: DocumentSummary;
  ref: string;
  parts: Chunk[];
  text: string;
  _meta: ApiMeta;
}

export interface RecentResponse {
  count: number;
  results: DocumentSummary[];
  _meta: ApiMeta;
}

export interface StatsResponse {
  stats: Record<string, unknown>;
  _meta: ApiMeta;
}
