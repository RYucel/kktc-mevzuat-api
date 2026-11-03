import type { SearchParams } from "./types.js";

export const DOC_COLUMNS = `
  d.id, d.type, d.subtype, d.title, d.number, d.year, d.date, d.language,
  d.source, d.source_url, d.pdf_url, d.court, d.chamber, d.parties,
  d.subject, d.summary, d.content_chars, d.chunk_count, d.text_status,
  d.updated_at, d.extra_json, d.sources_json
`;

const FILTER_TYPES: Record<string, string> = {
  type: "d.type = ?",
  year: "d.year = ?",
  source: "d.source = ?",
  court: "d.court LIKE ?",
};

function filters(params: SearchParams): { sql: string[]; binds: unknown[] } {
  const sql: string[] = [];
  const binds: unknown[] = [];
  if (params.type) {
    sql.push(FILTER_TYPES.type);
    binds.push(params.type);
  }
  if (params.year) {
    sql.push(FILTER_TYPES.year);
    binds.push(params.year);
  }
  if (params.source) {
    sql.push(FILTER_TYPES.source);
    binds.push(params.source);
  }
  if (params.court) {
    sql.push(FILTER_TYPES.court);
    binds.push(`%${params.court}%`);
  }
  if (params.exclude_title) {
    sql.push("c.kind != 'title'");
  }
  if (params.doc_ids?.length) {
    sql.push(`d.id IN (${params.doc_ids.map(() => "?").join(", ")})`);
    binds.push(...params.doc_ids);
  }
  return { sql, binds };
}

export function buildSearchSql(match: string, params: SearchParams): { sql: string; binds: unknown[] } {
  const f = filters(params);
  const fetchLimit = Math.min(1000, Math.max(params.limit + params.offset, 1) * 20);
  const prefer =
    params.prefer === "mevzuat"
      ? "CASE WHEN d.type IN ('yasa', 'tuzuk', 'anayasa') THEN 1.6 ELSE 1.0 END"
      : params.prefer === "ictihat"
        ? "CASE WHEN d.type = 'karar' THEN 1.6 ELSE 1.0 END"
        : "1.0";
  const primaryBoost = params.boost_ids?.length
    ? `CASE WHEN d.id IN (${params.boost_ids
        .map((id) => `'${id.replace(/'/g, "''")}'`)
        .join(", ")}) THEN 4.0 ELSE 1.0 END`
    : "1.0";
  const sql = `
    SELECT
      c.doc_id, c.ref AS matched_ref, c.kind AS matched_kind, c.text AS chunk_text,
      ${DOC_COLUMNS},
      bm25(chunks_fts) * CASE
        -- Court titles duplicate their subject tags; do not let them bury statutes.
        WHEN c.kind = 'title' AND d.type = 'karar' THEN 1.25
        WHEN c.kind = 'title' THEN 1.8
        WHEN c.kind = 'article' THEN 1.0
        WHEN c.kind = 'paragraph' THEN 1.1
        ELSE 1.2
      END
      * CASE WHEN d.type IN ('yasa', 'tuzuk', 'anayasa') THEN 1.15 ELSE 1.0 END
      * ${prefer}
      * ${primaryBoost}
      * CASE d.source
        -- mevzuat.gov.ct.tr carries the consolidated, currently in-force text.
        WHEN 'gov' THEN 1.25
        ELSE 1.0
      END AS rank
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    JOIN documents d ON d.id = c.doc_id
    WHERE chunks_fts MATCH ?
      ${f.sql.map((clause) => `AND ${clause}`).join("\n      ")}
    ORDER BY rank
    LIMIT ?
  `;
  return { sql, binds: [match, ...f.binds, fetchLimit] };
}

export function buildCountSql(match: string, params: SearchParams): { sql: string; binds: unknown[] } {
  const f = filters(params);
  const sql = `
    SELECT COUNT(DISTINCT c.doc_id) AS n
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    JOIN documents d ON d.id = c.doc_id
    WHERE chunks_fts MATCH ?
      ${f.sql.map((clause) => `AND ${clause}`).join("\n      ")}
  `;
  return { sql, binds: [match, ...f.binds] };
}

export function documentSql(id: string): { sql: string; binds: unknown[] } {
  return {
    sql: `SELECT ${DOC_COLUMNS.replaceAll("d.", "")} FROM documents d WHERE d.id = ?`,
    binds: [id],
  };
}

export function chunksSql(id: string): { sql: string; binds: unknown[] } {
  return {
    sql: "SELECT ord, kind, ref, text FROM chunks WHERE doc_id = ? ORDER BY ord",
    binds: [id],
  };
}

export function articleSql(id: string, ref: string): { sql: string; binds: unknown[] } {
  return {
    sql: `SELECT ord, kind, ref, text FROM chunks
          WHERE doc_id = ? AND (ref = ? OR ref LIKE ?)
          ORDER BY ord`,
    binds: [id, ref, `${ref} (%`],
  };
}

export function articleListSql(id: string): { sql: string; binds: unknown[] } {
  return {
    sql: `SELECT ref, kind, MIN(ord) AS ord FROM chunks
          WHERE doc_id = ? AND kind IN ('article', 'preamble')
          GROUP BY ref, kind ORDER BY ord`,
    binds: [id],
  };
}

/** Title chunks for canonical statutes that did not match the query tokens. */
export function primaryDocsSql(ids: string[]): { sql: string; binds: unknown[] } {
  if (!ids.length) {
    return {
      sql: `SELECT ${DOC_COLUMNS}, c.ref AS matched_ref, c.kind AS matched_kind, c.text AS chunk_text
            FROM documents d LEFT JOIN chunks c ON c.doc_id = d.id AND c.kind = 'title'
            WHERE 0`,
      binds: [],
    };
  }
  const placeholders = ids.map(() => "?").join(",");
  return {
    sql: `SELECT ${DOC_COLUMNS}, c.ref AS matched_ref, c.kind AS matched_kind, c.text AS chunk_text
          FROM documents d LEFT JOIN chunks c ON c.doc_id = d.id AND c.kind = 'title'
          WHERE d.id IN (${placeholders})
          ORDER BY d.id`,
    binds: ids,
  };
}

/**
 * Chunks of the matched articles only, used to rebuild whole articles for a
 * page of results. Reading every chunk of every law on the page cost hundreds
 * of D1 rows per search (Gelir Vergisi ~150, 34/2007 ~600 chunks); an article
 * is a handful. D1 allows 100 bound parameters, so callers batch the pairs.
 */
export function chunksForArticlesSql(pairs: { docId: string; ref: string }[]): { sql: string; binds: unknown[] } {
  if (!pairs.length) {
    return { sql: "SELECT doc_id, ord, kind, ref, text FROM chunks WHERE 0", binds: [] };
  }
  const clauses = pairs.map(() => "(doc_id = ? AND (ref = ? OR ref LIKE ?))").join(" OR ");
  return {
    sql: `SELECT doc_id, ord, kind, ref, text FROM chunks
          WHERE ${clauses}
          ORDER BY doc_id, ord`,
    binds: pairs.flatMap(({ docId, ref }) => [docId, ref, `${ref} (%`]),
  };
}

/** Max (doc, article) pairs per chunksForArticlesSql call (3 binds each, D1 cap 100). */
export const ARTICLE_PAIRS_PER_QUERY = 30;

export function recentSql(type: string | undefined, limit: number): { sql: string; binds: unknown[] } {
  const where = type ? "WHERE d.type = ?" : "";
  return {
    sql: `SELECT ${DOC_COLUMNS.replaceAll("d.", "")}
          FROM documents d
          ${where}
          ORDER BY (d.date IS NULL) ASC,
                   COALESCE(d.date, substr(d.updated_at, 1, 10)) DESC,
                   CASE d.source WHEN 'gov' THEN 0 ELSE 1 END,
                   d.year DESC, d.id ASC
          LIMIT ?`,
    binds: type ? [type, limit] : [limit],
  };
}

export const STATS_SQL = {
  types: `SELECT type, COUNT(*) AS documents,
                 SUM(CASE WHEN text_status = 'full' THEN 1 ELSE 0 END) AS full_text,
                 SUM(CASE WHEN text_status = 'partial' THEN 1 ELSE 0 END) AS partial_text
          FROM documents GROUP BY type ORDER BY documents DESC`,
  years: `SELECT year, COUNT(*) AS documents FROM documents
          WHERE year IS NOT NULL GROUP BY year ORDER BY year DESC LIMIT 30`,
  sources: `SELECT source, COUNT(*) AS documents,
                   SUM(CASE WHEN text_status = 'full' THEN 1 ELSE 0 END) AS full_text
            FROM documents GROUP BY source ORDER BY documents DESC`,
  status: `SELECT text_status, COUNT(*) AS documents FROM documents GROUP BY text_status`,
  latest: `SELECT type, MAX(date) AS latest_date FROM documents
           WHERE date IS NOT NULL GROUP BY type ORDER BY type`,
  meta: `SELECT key, value FROM meta`,
  courts: `SELECT court, COUNT(*) AS documents, MIN(year) AS first_year, MAX(year) AS last_year,
                  SUM(CASE WHEN text_status = 'full' THEN 1 ELSE 0 END) AS full_text
           FROM documents WHERE type = 'karar' GROUP BY court ORDER BY documents DESC`,
};
