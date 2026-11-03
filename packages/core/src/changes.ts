/**
 * Version history of consolidated legislation: what changed, article by article.
 *
 * Rows come from the `doc_versions` and `changes` tables, which the crawler
 * fills from its persistent history.db (see crawler/kktc/history.py). Tracking
 * starts on the first recorded run; nothing earlier is known.
 */
import { ApiError, apiMeta, mapSummary } from "./operations.js";
import { documentSql } from "./sql.js";
import type { ApiMeta, DocumentSummary, Store, StoreRow } from "./types.js";
import { TYPE_LABELS } from "./types.js";

export type DiffOp = ["=" | "-" | "+", string];

export interface SectionChange {
  ref: string | null;
  kind: "added" | "removed" | "modified";
  old_text: string | null;
  new_text: string | null;
  ops: DiffOp[];
}

export interface VersionInfo {
  version: number;
  captured_at: string;
  source_url: string | null;
  source_updated: string | null;
  chars: number;
}

export interface ChangeSet {
  from_version: number;
  to_version: number;
  detected_at: string;
  counts: { added: number; removed: number; modified: number };
  sections: SectionChange[];
}

export interface DocumentChangesResponse {
  document: DocumentSummary;
  tracking_since: string | null;
  versions: VersionInfo[];
  changes: ChangeSet[];
  _meta: ApiMeta;
}

export interface ChangeFeedItem {
  id: string;
  title: string;
  type: string;
  number: string | null;
  from_version: number;
  to_version: number;
  detected_at: string;
  counts: { added: number; removed: number; modified: number };
  refs: string[];
  url: string;
  changes_url: string;
  diff_url: string;
}

export interface ChangeFeedResponse {
  tracking_since: string | null;
  count: number;
  results: ChangeFeedItem[];
  _meta: ApiMeta;
}

const KIND_LABELS: Record<string, string> = {
  added: "eklendi",
  removed: "kaldırıldı",
  modified: "değişti",
};

/** Missing tables (an index built before history existed) read as "no history". */
async function safeAll(store: Store, sql: string, binds: unknown[] = []): Promise<StoreRow[]> {
  try {
    return await store.all(sql, binds);
  } catch (error) {
    if (/no such table/i.test(String(error instanceof Error ? error.message : error))) return [];
    throw error;
  }
}

async function trackingSince(store: Store): Promise<string | null> {
  try {
    const row = await store.first("SELECT value FROM meta WHERE key = 'history'");
    if (!row) return null;
    const parsed = JSON.parse(String(row.value)) as { tracking_since?: string | null };
    return parsed.tracking_since ?? null;
  } catch {
    return null;
  }
}

function parseOps(value: unknown): DiffOp[] {
  if (typeof value !== "string" || !value) return [];
  try {
    return JSON.parse(value) as DiffOp[];
  } catch {
    return [];
  }
}

function sinceParam(since: string | undefined): string | undefined {
  if (!since) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}/.test(since)) {
    throw new ApiError(400, "invalid_since", "since YYYY-AA-GG biçiminde olmalıdır, ör. 2026-11-01.");
  }
  return since;
}

export async function listChanges(
  store: Store,
  options: { since?: string; type?: string; limit: number },
  origin: string,
): Promise<ChangeFeedResponse> {
  const since = sinceParam(options.since);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (since) {
    where.push("c.detected_at >= ?");
    binds.push(since);
  }
  if (options.type) {
    where.push("d.type = ?");
    binds.push(options.type);
  }
  const rows = await safeAll(
    store,
    `SELECT c.doc_id, c.from_version, c.to_version, MAX(c.detected_at) AS detected_at,
            SUM(CASE WHEN c.kind = 'added' THEN 1 ELSE 0 END) AS added,
            SUM(CASE WHEN c.kind = 'removed' THEN 1 ELSE 0 END) AS removed,
            SUM(CASE WHEN c.kind = 'modified' THEN 1 ELSE 0 END) AS modified,
            GROUP_CONCAT(COALESCE(c.ref, ''), '|') AS refs,
            d.title, d.type, d.number
     FROM changes c
     LEFT JOIN documents d ON d.id = c.doc_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     GROUP BY c.doc_id, c.from_version, c.to_version
     ORDER BY detected_at DESC, c.doc_id
     LIMIT ?`,
    [...binds, options.limit],
  );
  const results: ChangeFeedItem[] = rows.map((row) => {
    const id = String(row.doc_id);
    const enc = encodeURIComponent(id);
    return {
      id,
      title: String(row.title ?? id),
      type: String(row.type ?? ""),
      number: row.number === null || row.number === undefined ? null : String(row.number),
      from_version: Number(row.from_version),
      to_version: Number(row.to_version),
      detected_at: String(row.detected_at),
      counts: { added: Number(row.added), removed: Number(row.removed), modified: Number(row.modified) },
      refs: String(row.refs ?? "")
        .split("|")
        .filter(Boolean),
      url: `${origin}/v1/documents/${enc}`,
      changes_url: `${origin}/v1/documents/${enc}/changes`,
      diff_url: `${origin}/degisiklikler/${enc}`,
    };
  });
  return {
    tracking_since: await trackingSince(store),
    count: results.length,
    results,
    _meta: apiMeta(origin),
  };
}

export async function getDocumentChanges(
  store: Store,
  id: string,
  origin: string,
  version?: number,
): Promise<DocumentChangesResponse | null> {
  const docQuery = documentSql(id);
  const row = await store.first(docQuery.sql, docQuery.binds);
  if (!row) return null;
  const versionRows = await safeAll(
    store,
    `SELECT version, captured_at, source_url, source_updated, chars
     FROM doc_versions WHERE doc_id = ? ORDER BY version`,
    [id],
  );
  const changeRows = await safeAll(
    store,
    `SELECT from_version, to_version, detected_at, ref, kind, old_text, new_text, ops_json
     FROM changes WHERE doc_id = ? ${version ? "AND to_version = ?" : ""}
     ORDER BY to_version DESC, ord`,
    version ? [id, version] : [id],
  );
  const sets = new Map<number, ChangeSet>();
  for (const change of changeRows) {
    const to = Number(change.to_version);
    let set = sets.get(to);
    if (!set) {
      set = {
        from_version: Number(change.from_version),
        to_version: to,
        detected_at: String(change.detected_at),
        counts: { added: 0, removed: 0, modified: 0 },
        sections: [],
      };
      sets.set(to, set);
    }
    const kind = String(change.kind) as SectionChange["kind"];
    set.counts[kind] += 1;
    set.sections.push({
      ref: change.ref === null || change.ref === undefined ? null : String(change.ref),
      kind,
      old_text: change.old_text === null || change.old_text === undefined ? null : String(change.old_text),
      new_text: change.new_text === null || change.new_text === undefined ? null : String(change.new_text),
      ops: parseOps(change.ops_json),
    });
  }
  return {
    document: mapSummary(row, origin),
    tracking_since: await trackingSince(store),
    versions: versionRows.map((v) => ({
      version: Number(v.version),
      captured_at: String(v.captured_at),
      source_url: v.source_url === null || v.source_url === undefined ? null : String(v.source_url),
      source_updated: v.source_updated === null || v.source_updated === undefined ? null : String(v.source_updated),
      chars: Number(v.chars),
    })),
    changes: Array.from(sets.values()),
    _meta: apiMeta(origin),
  };
}

function day(iso: string | null | undefined): string {
  if (!iso) return "?";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

/** Markdown for LLMs: old and new text in full, so nothing is inferred from markers. */
export function changesMarkdown(response: DocumentChangesResponse): string {
  const doc = response.document;
  const lines = [`# ${doc.title} — değişiklik geçmişi`, ""];
  lines.push(`- **Atıf:** ${doc.citation}`);
  lines.push(`- **Kaynak:** ${doc.source_url}`);
  lines.push(`- **Takip başlangıcı:** ${day(response.tracking_since)} (öncesindeki değişiklikler kayıtlı değildir)`);
  lines.push(`- **Kayıtlı sürümler:** ${response.versions.length}`);
  lines.push("");
  if (!response.changes.length) {
    lines.push("_Takip başladığından beri bu belgede değişiklik saptanmadı._");
    return lines.join("\n");
  }
  for (const set of response.changes) {
    lines.push(
      `## Sürüm ${set.from_version} → ${set.to_version} (saptanma: ${day(set.detected_at)})`,
      "",
      `${set.counts.modified} madde değişti, ${set.counts.added} eklendi, ${set.counts.removed} kaldırıldı.`,
      "",
    );
    for (const section of set.sections) {
      lines.push(`### ${section.ref ?? "Metin"} — ${KIND_LABELS[section.kind] ?? section.kind}`, "");
      if (section.old_text) lines.push("**Önceki metin:**", "", `> ${section.old_text}`, "");
      if (section.new_text) lines.push("**Yeni metin:**", "", `> ${section.new_text}`, "");
    }
  }
  lines.push("---", "Saptanma tarihi, değişikliğin kaynakta görüldüğü haftadır; yürürlük tarihi için Resmî Gazete'ye bakın.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTML viewer (green = eklenen, red = çıkarılan)
// ---------------------------------------------------------------------------

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

const KEEP_CONTEXT = 160;

function renderEqual(text: string): string {
  if (text.length <= KEEP_CONTEXT * 2 + 80) return esc(text);
  const head = text.slice(0, KEEP_CONTEXT);
  const tail = text.slice(-KEEP_CONTEXT);
  const middle = text.slice(KEEP_CONTEXT, -KEEP_CONTEXT);
  return (
    `${esc(head)}<details class="fold"><summary>… ${middle.length.toLocaleString("tr-TR")} karakter aynı …</summary>` +
    `${esc(middle)}</details>${esc(tail)}`
  );
}

function renderOps(ops: DiffOp[]): string {
  return ops
    .map(([op, text]) => {
      if (op === "+") return `<ins>${esc(text)}</ins>`;
      if (op === "-") return `<del>${esc(text)}</del>`;
      return renderEqual(text);
    })
    .join("");
}

const STYLE = `
:root{--bg:#fbfbf9;--fg:#1d1f21;--muted:#6b6f73;--line:#e3e3df;--card:#fff;
--add:#dcf5e3;--add-fg:#0f5a2a;--del:#fde2e1;--del-fg:#8f1d18;--accent:#0a7a55}
@media (prefers-color-scheme:dark){:root{--bg:#141516;--fg:#e6e6e3;--muted:#9a9ea2;--line:#2c2e30;--card:#1c1d1f;
--add:#173d26;--add-fg:#a6e9bd;--del:#4a1f1d;--del-fg:#ffb4ae;--accent:#5fd3a6}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:920px;margin:0 auto;padding:2rem 16px 4rem}
a{color:var(--accent)}
h1{font-size:1.5rem;line-height:1.3;margin:.2rem 0 .4rem}
.muted{color:var(--muted)}
.meta{color:var(--muted);font-size:.9rem;margin:0 0 1.5rem}
.set{margin:2rem 0}
.set>h2{font-size:1.05rem;margin:0 0 .75rem;padding-bottom:.4rem;border-bottom:1px solid var(--line)}
.sec{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:.75rem 0;overflow:hidden}
.sec header{display:flex;gap:.6rem;align-items:baseline;padding:.55rem .9rem;border-bottom:1px solid var(--line);font-weight:600}
.tag{font-size:.75rem;font-weight:600;padding:.05rem .5rem;border-radius:99px}
.tag.added{background:var(--add);color:var(--add-fg)}.tag.removed{background:var(--del);color:var(--del-fg)}
.tag.modified{background:var(--line);color:var(--fg)}
.body{padding:.75rem .9rem;white-space:pre-wrap;overflow-wrap:anywhere}
ins{background:var(--add);color:var(--add-fg);text-decoration:none;border-radius:3px}
del{background:var(--del);color:var(--del-fg);border-radius:3px}
.sec.added .body{background:var(--add);color:var(--add-fg)}.sec.removed .body{background:var(--del);color:var(--del-fg)}
.sec.added ins,.sec.removed del{background:none}
details.fold{display:inline}details.fold summary{display:inline;cursor:pointer;color:var(--muted);font-size:.85rem}
details.fold[open] summary{display:none}
.legend{display:flex;gap:1rem;font-size:.85rem;margin:-.75rem 0 1.5rem}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.5rem .4rem;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:.8rem;color:var(--muted);font-weight:600}
.counts .tag{display:inline-block;margin:0 .2rem .25rem 0;white-space:nowrap}
.empty{padding:2rem;border:1px dashed var(--line);border-radius:10px;text-align:center;color:var(--muted)}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

const LEGEND = `<div class="legend"><span><ins>yeşil</ins> eklenen</span><span><del>kırmızı</del> çıkarılan</span></div>`;

export function changesHtml(response: DocumentChangesResponse, origin: string): string {
  const doc = response.document;
  const parts = [
    `<p class="muted"><a href="${origin}/degisiklikler">← Tüm değişiklikler</a></p>`,
    `<h1>${esc(doc.title)}</h1>`,
    `<p class="meta">${esc(TYPE_LABELS[doc.type] ?? doc.type)} · ${esc(doc.citation)} · ` +
      `<a href="${esc(doc.source_url)}">resmî metin</a> · ${response.versions.length} kayıtlı sürüm · ` +
      `takip başlangıcı ${day(response.tracking_since)}</p>`,
    LEGEND,
  ];
  if (!response.changes.length) {
    parts.push(`<div class="empty">Takip başladığından beri bu belgede değişiklik saptanmadı.</div>`);
  }
  for (const set of response.changes) {
    parts.push(
      `<section class="set"><h2>Sürüm ${set.from_version} → ${set.to_version} · ${day(set.detected_at)} ` +
        `<span class="muted">(${set.counts.modified} değişti, ${set.counts.added} eklendi, ${set.counts.removed} kaldırıldı)</span></h2>`,
    );
    for (const section of set.sections) {
      parts.push(
        `<article class="sec ${section.kind}"><header>${esc(section.ref ?? "Metin")}` +
          `<span class="tag ${section.kind}">${KIND_LABELS[section.kind]}</span></header>` +
          `<div class="body">${renderOps(section.ops)}</div></article>`,
      );
    }
    parts.push(`</section>`);
  }
  parts.push(
    `<p class="muted" style="font-size:.85rem">Saptanma tarihi, değişikliğin kaynakta görüldüğü haftadır; ` +
      `yürürlük tarihi için Resmî Gazete'ye bakın. JSON: <a href="${esc(doc.url)}/changes">${esc(doc.url)}/changes</a></p>`,
  );
  return page(`${doc.title} — değişiklikler`, parts.join("\n"));
}

function countTags(counts: { added: number; removed: number; modified: number }): string {
  const tags: string[] = [];
  if (counts.modified) tags.push(`<span class="tag modified">${counts.modified} değişti</span>`);
  if (counts.added) tags.push(`<span class="tag added">${counts.added} eklendi</span>`);
  if (counts.removed) tags.push(`<span class="tag removed">${counts.removed} kaldırıldı</span>`);
  return tags.join(" ");
}

export function feedHtml(feed: ChangeFeedResponse, origin: string): string {
  const parts = [
    `<p class="muted"><a href="${origin}/">KKTC Mevzuat API</a></p>`,
    `<h1>Mevzuat değişiklikleri</h1>`,
    `<p class="meta">Güncel birleştirilmiş metinlerde (mevzuat.gov.ct.tr) saptanan madde değişiklikleri. ` +
      `Takip başlangıcı: ${day(feed.tracking_since)}.</p>`,
  ];
  if (!feed.results.length) {
    parts.push(
      `<div class="empty">${feed.tracking_since ? "Henüz değişiklik saptanmadı." : "Sürüm takibi henüz başlamadı."}</div>`,
    );
  } else {
    parts.push(`<table><tr><th>Saptanma</th><th>Belge</th><th>Değişen</th></tr>`);
    for (const item of feed.results) {
      const refs = item.refs.slice(0, 6).join(", ") + (item.refs.length > 6 ? ` +${item.refs.length - 6}` : "");
      parts.push(
        `<tr><td>${day(item.detected_at)}</td><td><a href="${esc(item.diff_url)}">${esc(item.title)}</a>` +
          `<div class="muted" style="font-size:.85rem">${esc(refs)}</div></td>` +
          `<td class="counts">${countTags(item.counts)}</td></tr>`,
      );
    }
    parts.push(`</table>`);
  }
  return page("Mevzuat değişiklikleri", parts.join("\n"));
}
