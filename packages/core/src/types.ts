/** Shared types for the KKTC mevzuat API. */

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
}

export interface SearchParams {
  q: string;
  mode?: "all" | "any" | "phrase";
  type?: string;
  year?: number;
  source?: string;
  court?: string;
  limit: number;
  offset: number;
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
  matched_ref: string | null;
  matched_kind: string;
  snippet: string;
  score: number;
  url: string;
  source_url: string;
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
  mode: string;
  filters: Record<string, string | number | null>;
  count: number;
  total_documents: number;
  has_more: boolean;
  next: string | null;
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
