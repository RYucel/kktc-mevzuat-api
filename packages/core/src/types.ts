import type { QueryRewriter } from "./rewrite.js";
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
  /** Optional LLM query rewriter (Workers AI); used by answerQuestion. */
  rewriter?: QueryRewriter;
  /** Optional: records a user's verdict on an answer (POST /v1/feedback, MCP geri_bildirim). False when the daily cap is reached. */
  feedback?(entry: FeedbackEntry): Promise<boolean>;
}

/** A verdict on one quoted answer. The question itself is never stored, only its hash. */
export interface FeedbackEntry {
  q_hash: string;
  document_id: string;
  ref: string | null;
  verdict: "dogru" | "yanlis";
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
  /** /v1/answer: when Clef is not sure of the statute, focus on the two leading ones (default false; measured worse). */
  focus_two?: boolean;
  /** /v1/answer: show Clef the part of each article that matches the question (default true). */
  window?: boolean;
  /**
   * /v1/answer: prefer laws over regulations unless the question asks for a
   * regulation (default true). Search also uses it to rank tüzük lower.
   */
  statute_first?: boolean;
  /**
   * /v1/answer: do not quote amendment instruments or first-published copies
   * of statutes we also hold consolidated (default true).
   */
  dedupe?: boolean;
  /** /v1/answer: "low" for questions about another country's law (default true). */
  jurisdiction?: boolean;
  /** /v1/answer: allow the preamble, short title and definitions article as answers (default false). */
  boilerplate?: boolean;
  /** Internal: rank amendment instruments far down (answers). */
  skip_amendments?: boolean;
  /** /v1/answer: "high" needs the answer to come from a statute the rewrite named, when it named any (default true). */
  agree?: boolean;
  /** Internal: receives the vector hits of this search (answer focus step). */
  semantic_sink?: { doc_id: string; ref: string | null }[];
  /** /v1/answer: rewrite the question into legal terms and statute names with an LLM (default true). */
  rewrite?: boolean;
  /** /v1/answer: rewrite prompt version ("v1" default, "v2"). */
  rewrite_prompt?: "v1" | "v2";
  /** /v1/answer: choose the statute first from statute cards, then the article (default false; measuring). */
  lawpick?: boolean;
  /**
   * /v1/answer: in the focus step, also let Clef choose articles from the
   * statute's table of contents (article headings); they join the focus
   * candidates (default false; measuring).
   */
  toc?: boolean;
  /**
   * /v1/answer: before reporting high or medium, ask the decision model a
   * yes/no question about the quoted window itself ("does this text answer
   * the question?"); below verify_high "high" becomes "medium", below
   * verify_low the answer is "low" (default false; measuring).
   */
  verify?: boolean;
  /**
   * /v1/answer: once the law is chosen, offer its regulations (by their
   * cards) too: a question about detail is often answered by a regulation
   * made under the law (default false; measuring).
   */
  children?: boolean;
  /** /v1/answer: articles named by the term dictionary join the candidates (default false; measuring). */
  terms?: boolean;
  /** Subject category chosen by the user (categories.ts); absent means all statutes. */
  category?: string;
  /** soft (default): the category's statutes lead; hard: only the category's statutes. */
  category_mode?: "soft" | "hard";
  /** /v1/answer: quoted text up to this many characters (whole article when shorter; default: 320-character snippet). */
  quote_chars?: number;
  /** /v1/answer: with quote_chars, let Clef choose the paragraph of a longer first article. */
  quote_pick?: boolean;
  /** Internal: receives the dictionary terms found in the question. */
  term_sink?: { term: string; doc_id: string; ref: string; status: string }[];
  /** /v1/answer: cap "high" when a later amendment may have changed the quoted regulation article (default true). */
  amended?: boolean;
  verify_high?: number;
  verify_low?: number;
  /** /v1/answer: statutes shown in the statute-choice step (default 20, 5-30). */
  lawpick_n?: number;
  /** /v1/answer: use the statute names of the rewrite at all (default true; laws=0 keeps only its terms). */
  rewrite_laws?: boolean;
  /** /v1/answer: only statute names that match a title in full boost the search and gate "high". */
  strong_laws?: boolean;
  /** /v1/answer: rewrite model ("20b" default, "120b" larger). */
  rewrite_model?: "20b" | "120b";
  /** /v1/answer: wait for the rewrite before the main search (slower; for measurement). */
  rewrite_wait?: boolean;
  /** Internal: receives what the rewriter returned. */
  rewrite_sink?: QueryRewriteInfo[];
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
  /** Where the text comes from: "gov" (mevzuat.gov.ct.tr, consolidated) or "mahkemeler". */
  source: string;
  /**
   * Last amendment the text is known to include ("25/2026", "2024-02-13");
   * null when the source does not say, so the text may predate amendments.
   */
  consolidated_through: string | null;
  /** True when `text` is a window cut out of a longer article (see `url` for all of it). */
  excerpt: boolean;
  /** Regulations: the law it is made under, when known. */
  parent_law?: { id: string; title: string };
  /**
   * The one citation line to show for this quote: name (number), article,
   * how current the text is, source ("İş Yasası (22/1992) m.43, 25/2026
   * sayılı değişikliğe kadar birleştirilmiş metin, mevzuat.gov.ct.tr").
   */
  kaynak: string;
  /**
   * Amendments dated after this text that may change the quoted article
   * (regulations; those naming other articles only are left out).
   */
  amended_after?: { id: string; date: string; articles: string[] }[];
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
  /** Why a "high" was lowered to "medium" (absent when nothing was capped). */
  confidence_caps?: ConfidenceCap[];
  /** The subject category the question was asked under, and whether the answer is outside it. */
  category?: { id: string; name: string; mode: "soft" | "hard"; outside: boolean };
  /** debug=1 with terms=1: dictionary terms found in the question. */
  terms_matched?: { term: string; document_id: string; ref: string; status: string }[];
  /** Present when an LLM rewrote the question for the search (never the answer). */
  query_rewrite?: QueryRewriteInfo;
  /** Present when the question went to the reranker. */
  rerank?: {
    model: string;
    applied: boolean;
    candidates?: number;
    passages_per_document?: number;
    /** Focus step: Clef asked again among more articles of its chosen statute. */
    /** verify=1: the yes/no check of the first quote. */
    /** children=1: the law's regulations offered, and the one chosen. */
    children?: { law: string; regulations: number; chosen?: string; probability?: number; law_probability?: number; error?: string };
    /** quote_pick=1: the paragraph shown for the first quote. */
    quote_pick?: { paragraphs: number; chosen: number; probability: number };
    verify?: { applied: boolean; answers?: number; refers?: number; error?: string; before?: "high" | "medium" | "low" };
    focus?: {
      document_id: string;
      document_ids?: string[];
      candidates: number;
      applied: boolean;
      top_probability?: number;
      none_probability?: number;
      error?: string;
      /** toc=1: articles chosen from the table of contents, best first (debug). */
      toc?: { document_id: string; articles: number; calls: number; refs: string[]; error?: string }[];
    };
    /** Only with debug=1: every candidate Clef saw, best first. */
    debug_candidates?: { document_id: string; ref: string | null; probability: number }[];
    /** The first step chose among statutes (lawpick), not passages. */
    law_pick?: boolean;
    /** debug=1 with lawpick: the statutes and their probabilities. */
    debug_laws?: { document_id: string; probability: number }[];
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

/**
 * regulation: a tüzük answered a question that did not ask for one;
 * rewrite_disagrees: the answer is from none of the statutes the LLM named;
 * partial_text: the statute's text is incomplete (partial download or scan);
 * foreign_jurisdiction: the question asks about another country (lowered to "low");
 * outside_category: the answer is from a statute outside the category the user chose.
 */
export type ConfidenceCap =
  | "regulation"
  | "rewrite_disagrees"
  | "partial_text"
  | "foreign_jurisdiction"
  | "unverified"
  | "possibly_amended"
  | "outside_category";

export interface QueryRewriteInfo {
  terms: string[];
  laws: string[];
  /** Statutes the names resolved to (they join the candidates). */
  documents: string[];
  /** The documents whose title matches a name in full (the reliable ones). */
  strong_documents?: string[];
  /** Served from the rewrite cache (no LLM call). */
  cached?: boolean;
  error?: string;
}
