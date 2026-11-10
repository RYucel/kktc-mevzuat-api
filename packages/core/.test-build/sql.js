export const DOC_COLUMNS = `
  d.id, d.type, d.subtype, d.title, d.number, d.year, d.date, d.language,
  d.source, d.source_url, d.pdf_url, d.court, d.chamber, d.parties,
  d.subject, d.summary, d.content_chars, d.chunk_count, d.text_status,
  d.updated_at, d.extra_json, d.sources_json
`;
const FILTER_TYPES = {
    type: "d.type = ?",
    year: "d.year = ?",
    source: "d.source = ?",
    court: "d.court LIKE ?",
};
function filters(params) {
    const sql = [];
    const binds = [];
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
/** FTS candidates read per channel: D1 bills every row the FTS index yields. */
export const FTS_TOP_K = 600;
const LEGISLATION = ["yasa", "tuzuk", "anayasa", "yonetmelik", "emirname", "kararname", "andlasma"];
/** FTS token of one document: "xqd" + hex of the id (crawler/kktc/build.py doc_token). */
export function docToken(docId) {
    return "xqd" + Array.from(new TextEncoder().encode(docId), (b) => b.toString(16).padStart(2, "0")).join("");
}
/** Articles fetched by the in-statute search (all documents together). */
export const IN_DOC_ARTICLES = 80;
/**
 * Best-matching articles inside the given statutes, for the answer
 * candidates: the question's stems searched again, restricted to these
 * documents with their FTS scope tokens (cheap: one MATCH, LIMIT rows).
 */
export function inDocArticlesSql(stems, docIds, limit = IN_DOC_ARTICLES) {
    const docs = docIds.map((id) => `scope:${docToken(id)}`).join(" OR ");
    return {
        sql: "SELECT c.doc_id AS doc_id, c.ref AS ref FROM " +
            "(SELECT rowid AS id, rank AS r FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?) t " +
            "JOIN chunks c ON c.id = t.id WHERE c.kind = 'article' ORDER BY t.r",
        binds: [`(${stems}) AND (${docs})`, limit],
    };
}
/** Same groups as crawler/kktc/build.py scope_tokens(). */
function scopeGroup(type) {
    return LEGISLATION.includes(type) ? "mevzuat" : type === "karar" ? "ictihat" : "diger";
}
function rankingSql(params, score) {
    const prefer = params.prefer === "mevzuat"
        ? "CASE WHEN d.type IN ('yasa', 'tuzuk', 'anayasa') THEN 1.6 ELSE 1.0 END"
        : params.prefer === "ictihat"
            ? "CASE WHEN d.type = 'karar' THEN 1.6 ELSE 1.0 END"
            : "1.0";
    const primaryBoost = params.boost_ids?.length
        ? `CASE WHEN d.id IN (${params.boost_ids
            .map((id) => `'${id.replace(/'/g, "''")}'`)
            .join(", ")}) THEN 4.0 ELSE 1.0 END`
        : "1.0";
    // A regulation implements its parent law; for a general question the law
    // is the answer. Without this, 800 new regulation texts (9 Nov 2026) took
    // the candidate slots and Clef picked them over the law.
    const statuteFirst = params.statute_first ? "CASE WHEN d.type = 'tuzuk' THEN 0.5 ELSE 1.0 END" : "1.0";
    return `
      ${score} * CASE
        -- Court titles duplicate their subject tags; do not let them bury statutes.
        WHEN c.kind = 'title' AND d.type = 'karar' THEN 1.25
        WHEN c.kind = 'title' THEN 1.8
        WHEN c.kind = 'article' THEN 1.0
        WHEN c.kind = 'paragraph' THEN 1.1
        ELSE 1.2
      END
      * CASE WHEN d.type IN ('yasa', 'tuzuk', 'anayasa') THEN 1.15 ELSE 1.0 END
      * ${prefer}
      * ${statuteFirst}
      * ${primaryBoost}
      * CASE d.source
        -- mevzuat.gov.ct.tr carries the consolidated, currently in-force text.
        WHEN 'gov' THEN 1.25
        ELSE 1.0
      END`;
}
/**
 * Two-phase search: the FTS index returns only its best FTS_TOP_K matches
 * (ORDER BY rank inside FTS5), and only those are joined with chunks and
 * documents and re-ranked. The old single query scored every match in SQL,
 * so D1 read every matching chunk and document row: ~250K rows for one
 * natural-language question on 4 November 2026, against a 5M daily quota.
 *
 * An explicit type filter is applied inside the index through the "scope"
 * column (xqt<type>); preference only re-ranks the top K. Year, source and
 * court filters are not in the index; those requests use buildSearchSqlFull.
 */
export function buildSearchSql(match, params) {
    if (params.year || params.source || params.court)
        return buildSearchSqlFull(match, params);
    const fetchLimit = Math.min(1000, Math.max(params.limit + params.offset, 1) * 20);
    const k = Math.max(FTS_TOP_K, fetchLimit);
    const channels = [];
    const base = `(${match})`;
    if (params.doc_ids?.length) {
        // Restrict inside the index with each document's own token. The former
        // "AND rowid IN (SELECT id FROM chunks WHERE doc_id IN ...)" made FTS5
        // re-run the whole MATCH once per rowid: 3.7 s for one question on the
        // local copy, and "D1 DB is overloaded" in production (9 Nov 2026).
        const docs = params.doc_ids.map((id) => `scope:${docToken(id)}`).join(" OR ");
        channels.push({ match: `${base} AND (${docs})`, limit: k });
    }
    else if (params.type) {
        channels.push({ match: `${base} AND scope:xqt${params.type.replace(/[^a-z]/g, "")}`, limit: k });
    }
    else {
        // prefer is applied in the second phase (x1.6). Filtering by group in
        // the index (AND/NOT scope:xqg...) made FTS5 intersect the doclist of a
        // token present in half the rows, twice per question: with the D1 per-
        // database CPU budget that overloaded D1 on 9 November 2026 ("Too many
        // resources consumed within a 10 second window").
        channels.push({ match: base, limit: k });
    }
    const binds = [];
    const parts = channels.map((channel) => {
        binds.push(channel.match);
        binds.push(channel.limit);
        return `SELECT * FROM (SELECT rowid AS id, rank AS r FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?)`;
    });
    const extra = [];
    if (params.exclude_title)
        extra.push("c.kind != 'title'");
    if (params.type) {
        extra.push("d.type = ?");
        binds.push(params.type);
    }
    const sql = `
    WITH top AS (${parts.join(" UNION ALL ")})
    SELECT
      c.doc_id, c.ref AS matched_ref, c.kind AS matched_kind, c.text AS chunk_text,
      ${DOC_COLUMNS},
      ${rankingSql(params, "top.r")} AS rank
    FROM top
    JOIN chunks c ON c.id = top.id
    JOIN documents d ON d.id = c.doc_id
    ${extra.length ? `WHERE ${extra.join(" AND ")}` : ""}
    ORDER BY rank
    LIMIT ?
  `;
    binds.push(fetchLimit);
    return { sql, binds };
}
/**
 * Single query that scores every match: exact for any filter, but reads every
 * matching row. Used for year/source/court filters and while D1 still has the
 * FTS table without the scope column (see searchDocuments).
 */
export function buildSearchSqlFull(match, params) {
    const f = filters(params);
    const fetchLimit = Math.min(1000, Math.max(params.limit + params.offset, 1) * 20);
    const sql = `
    SELECT
      c.doc_id, c.ref AS matched_ref, c.kind AS matched_kind, c.text AS chunk_text,
      ${DOC_COLUMNS},
      ${rankingSql(params, "bm25(chunks_fts)")} AS rank
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
export function buildCountSql(match, params) {
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
export function documentSql(id) {
    return {
        sql: `SELECT ${DOC_COLUMNS.replaceAll("d.", "")} FROM documents d WHERE d.id = ?`,
        binds: [id],
    };
}
export function chunksSql(id) {
    return {
        sql: "SELECT ord, kind, ref, text FROM chunks WHERE doc_id = ? ORDER BY ord",
        binds: [id],
    };
}
export function articleSql(id, ref) {
    return {
        sql: `SELECT ord, kind, ref, text FROM chunks
          WHERE doc_id = ? AND (ref = ? OR ref LIKE ?)
          ORDER BY ord`,
        binds: [id, ref, `${ref} (%`],
    };
}
export function articleListSql(id) {
    return {
        sql: `SELECT ref, kind, MIN(ord) AS ord FROM chunks
          WHERE doc_id = ? AND kind IN ('article', 'preamble')
          GROUP BY ref, kind ORDER BY ord`,
        binds: [id],
    };
}
/** Title chunks for canonical statutes that did not match the query tokens. */
export function primaryDocsSql(ids) {
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
export function chunksForArticlesSql(pairs) {
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
/** Document + one chunk, located by (doc_id, ord), for vector hits. */
export function chunkRowsSql(pairs) {
    if (!pairs.length) {
        return { sql: `SELECT ${DOC_COLUMNS} FROM documents d WHERE 0`, binds: [] };
    }
    const clauses = pairs.map(() => "(c.doc_id = ? AND c.ord = ?)").join(" OR ");
    return {
        sql: `SELECT ${DOC_COLUMNS}, c.ref AS matched_ref, c.kind AS matched_kind, c.text AS chunk_text
          FROM chunks c JOIN documents d ON d.id = c.doc_id
          WHERE ${clauses}`,
        binds: pairs.flatMap(({ docId, ord }) => [docId, ord]),
    };
}
/** Max (doc, ord) pairs per chunkRowsSql call (2 binds each, D1 cap 100). */
export const CHUNK_PAIRS_PER_QUERY = 45;
/** Max (doc, article) pairs per chunksForArticlesSql call (3 binds each, D1 cap 100). */
export const ARTICLE_PAIRS_PER_QUERY = 30;
export function recentSql(type, limit) {
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
