"""Build the searchable SQLite database and export data for Cloudflare D1."""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import time
from collections import Counter
from datetime import date as _date
from pathlib import Path
from typing import Any, Iterable, Optional

from .config import DB_PATH, DIST_DIR
from .history import HISTORY_TABLES_SQL
from .cards import display_title, statute_card
from .parents import LawIndex, parent_law
from .amendments import later_amendments
from .textproc import Chunk, chunk_document, clean_text, index_text, normalize_title

log = logging.getLogger(__name__)

SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    subtype TEXT,
    title TEXT NOT NULL,
    title_norm TEXT NOT NULL,
    number TEXT,
    year INTEGER,
    date TEXT,
    language TEXT NOT NULL DEFAULT 'tr',
    source TEXT NOT NULL,
    source_url TEXT NOT NULL,
    pdf_url TEXT,
    court TEXT,
    chamber TEXT,
    parties TEXT,
    subject TEXT,
    summary TEXT,
    content_chars INTEGER NOT NULL DEFAULT 0,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    text_status TEXT NOT NULL DEFAULT 'metadata',
    fetched_at TEXT,
    updated_at TEXT,
    checksum TEXT,
    extra_json TEXT,
    sources_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type);
CREATE INDEX IF NOT EXISTS idx_documents_year ON documents(year);
CREATE INDEX IF NOT EXISTS idx_documents_date ON documents(date);
CREATE INDEX IF NOT EXISTS idx_documents_number ON documents(number);
CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source);

CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT,
    text TEXT NOT NULL,
    chars INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id, ord);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    text_norm,
    scope,
    tokenize = 'unicode61 remove_diacritics 2'
);
"""


def _subtype(doc: dict[str, Any]) -> Optional[str]:
    extra = doc.get("extra") or {}
    return extra.get("tur") or extra.get("yasa_turu") or extra.get("category")


def _chunks_for(doc: dict[str, Any]) -> list[Chunk]:
    title = clean_text(doc.get("title") or "")
    # Index the number with the title so metadata-only documents (many tüzük
    # PDFs) are still found by "1122-2024" or "24/1982".
    number = clean_text(str(doc.get("number") or ""))
    label = f"{title} {number}".strip() if number and number not in title else title
    chunks: list[Chunk] = [Chunk("title", "Başlık", label)] if label else []
    content = clean_text(doc.get("content") or "")
    if content:
        chunks.extend(chunk_document(content, doc.get("type") or "yasa"))
    return chunks


def _unique_id(base: str, used: set[str], pkey: Any) -> str:
    if base not in used:
        used.add(base)
        return base
    candidate = f"{base}-{pkey}" if pkey else base
    if candidate not in used:
        used.add(candidate)
        return candidate
    index = 2
    while f"{candidate}-{index}" in used:
        index += 1
    final = f"{candidate}-{index}"
    used.add(final)
    return final


def _valid_year(doc: dict[str, Any]) -> Optional[int]:
    """Normalise the year; case numbers and source typos are not years."""
    try:
        year = int(doc.get("year"))
    except (TypeError, ValueError):
        year = None
    if year is not None and 1800 <= year <= 2100:
        return year
    date = str(doc.get("date") or "")
    if len(date) >= 4 and date[:4].isdigit():
        candidate = int(date[:4])
        if 1800 <= candidate <= 2100:
            return candidate
    return None


def _valid_date(doc: dict[str, Any]) -> Optional[str]:
    """Keep plausible ISO dates; catalogue typos such as 2202-12-29 are dropped.

    mevzuat.mahkemeler.net carries a few impossible dates (2202-12-29,
    0198-04-12, 1878-12-05). They would otherwise become the "latest" date in
    statistics and sort a document to the top for no reason. The original value
    is preserved as ``extra.source_date_raw`` when it is rejected.
    """
    raw = str(doc.get("date") or "").strip()[:10]
    if len(raw) != 10:
        return None
    try:
        parsed = _date.fromisoformat(raw)
    except ValueError:
        return None
    current_year = time.gmtime().tm_year
    if 1900 <= parsed.year <= current_year + 1:
        return parsed.isoformat()
    return None


CARD_TYPES = {"yasa", "tuzuk", "anayasa"}


def build_database(docs: list[dict[str, Any]], db_path: Path = DB_PATH) -> dict[str, Any]:
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if db_path.exists():
        db_path.unlink()
    for suffix in ("-wal", "-shm"):
        sidecar = Path(str(db_path) + suffix)
        if sidecar.exists():
            sidecar.unlink()

    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    used: set[str] = set()
    stats_types: Counter[str] = Counter()
    stats_sources: Counter[str] = Counter()
    total_chunks = 0
    total_chars = 0

    document_rows = []
    chunk_rows = []
    # Regulations name the law they are made under (OPUS-GOREVLER-4 item 8).
    laws = LawIndex((d["_id"], clean_text(d.get("title") or "")) for d in docs if (d.get("type") or "yasa") == "yasa")
    parents_found = parents_missing = 0
    # Amendment regulations dated after a regulation's text (OPUS-GOREVLER-4 item 11).
    later = later_amendments((d["_id"], d, _valid_date(d)) for d in docs if d.get("type") == "tuzuk")

    for doc in sorted(docs, key=lambda d: (d.get("type") or "", d.get("date") or "", d.get("title") or "")):
        pkey = (doc.get("extra") or {}).get("pkey") or doc.get("number")
        doc_id = _unique_id(doc["_id"], used, pkey)
        title = clean_text(doc.get("title") or "") or doc_id
        content = clean_text(doc.get("content") or "")
        chunks = _chunks_for(doc)
        if content:
            status = "full" if len(content) >= 500 else "partial"
        else:
            status = "metadata"
        sources = doc.get("sources") or []
        extra = {k: v for k, v in (doc.get("extra") or {}).items() if v is not None}
        if (doc.get("type") or "yasa") in CARD_TYPES and chunks:
            # Readable name and subject card for choosing the statute first.
            extra["display_title"] = display_title(title, doc.get("number"))
            card = statute_card(chunks)
            if card:
                extra["card"] = card
        if doc["_id"] in later:
            extra["amended_after"] = later[doc["_id"]][:20]
        if doc.get("type") == "tuzuk" and content:
            parent = parent_law(content[:4000], laws)
            if parent:
                extra["parent_law"] = parent
                parents_found += 1
            elif "degisiklik" not in normalize_title(title):
                parents_missing += 1
        date = _valid_date(doc)
        if doc.get("date") and not date:
            extra["source_date_raw"] = str(doc.get("date"))
        document_rows.append(
            (
                doc_id,
                doc.get("type") or "yasa",
                _subtype(doc),
                title,
                normalize_title(title),
                doc.get("number"),
                _valid_year(doc),
                date,
                doc.get("language") or "tr",
                doc.get("source") or "gov",
                doc.get("source_url") or "",
                doc.get("pdf_url"),
                doc.get("court"),
                doc.get("chamber"),
                doc.get("parties"),
                doc.get("subject"),
                doc.get("summary"),
                len(content),
                len(chunks),
                status,
                now,
                now,
                _checksum(content or title),
                json.dumps(extra, ensure_ascii=False) if extra else None,
                json.dumps(sources, ensure_ascii=False) if sources else None,
            )
        )
        stats_types[doc.get("type") or "yasa"] += 1
        stats_sources[doc.get("source") or "gov"] += 1
        total_chars += len(content)
        for ord_, chunk in enumerate(chunks):
            text = clean_text(chunk.text)
            if not text:
                continue
            chunk_rows.append((doc_id, ord_, chunk.kind, chunk.ref, text, len(text)))
            total_chunks += 1

    conn.executemany(
        """
        INSERT INTO documents (
            id, type, subtype, title, title_norm, number, year, date, language,
            source, source_url, pdf_url, court, chamber, parties, subject, summary,
            content_chars, chunk_count, text_status, fetched_at, updated_at,
            checksum, extra_json, sources_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        document_rows,
    )

    # Chunk ids are derived from (doc_id, ord), so an unchanged document keeps
    # its ids from build to build. That is what lets the D1 export send only
    # changed documents (see export_d1).
    chunk_ids: list[tuple[int, Any]] = []
    used_ids: set[int] = set()
    for row in chunk_rows:
        chunk_ids.append((_chunk_id(row[0], row[1], used_ids), row))

    conn.executemany(
        "INSERT INTO chunks (id, doc_id, ord, kind, ref, text, chars) VALUES (?,?,?,?,?,?,?)",
        [(cid, *row) for cid, row in chunk_ids],
    )
    doc_types = {row[0]: row[1] for row in document_rows}
    conn.executemany(
        "INSERT INTO chunks_fts (rowid, text_norm, scope) VALUES (?, ?, ?)",
        [(cid, index_text(row[4]), scope_tokens(doc_types.get(row[0], "yasa"), row[0])) for cid, row in chunk_ids],
    )

    # Precompute the /v1/stats payload. Reading it back is one meta row instead
    # of seven GROUP BY scans over documents on every request.
    conn.row_factory = sqlite3.Row

    def stat_rows(sql: str) -> list[dict[str, Any]]:
        return [dict(row) for row in conn.execute(sql)]

    stats_payload = {
        "by_type": stat_rows(
            "SELECT type, COUNT(*) AS documents, "
            "SUM(CASE WHEN text_status = 'full' THEN 1 ELSE 0 END) AS full_text, "
            "SUM(CASE WHEN text_status = 'partial' THEN 1 ELSE 0 END) AS partial_text "
            "FROM documents GROUP BY type ORDER BY documents DESC"
        ),
        "by_year": stat_rows(
            "SELECT year, COUNT(*) AS documents FROM documents "
            "WHERE year IS NOT NULL GROUP BY year ORDER BY year DESC LIMIT 30"
        ),
        "by_source": stat_rows(
            "SELECT source, COUNT(*) AS documents, "
            "SUM(CASE WHEN text_status = 'full' THEN 1 ELSE 0 END) AS full_text "
            "FROM documents GROUP BY source ORDER BY documents DESC"
        ),
        "text_status": stat_rows(
            "SELECT text_status, COUNT(*) AS documents FROM documents GROUP BY text_status"
        ),
        "latest_by_type": stat_rows(
            "SELECT type, MAX(date) AS latest_date FROM documents "
            "WHERE date IS NOT NULL GROUP BY type ORDER BY type"
        ),
        "courts": stat_rows(
            "SELECT court, COUNT(*) AS documents, MIN(year) AS first_year, MAX(year) AS last_year, "
            "SUM(CASE WHEN text_status = 'full' THEN 1 ELSE 0 END) AS full_text "
            "FROM documents WHERE type = 'karar' GROUP BY court ORDER BY documents DESC"
        ),
    }

    meta = {
        "built_at": now,
        "document_count": len(document_rows),
        "chunk_count": total_chunks,
        "chars": total_chars,
        "by_type": dict(stats_types),
        "by_source": dict(stats_sources),
        "schema_version": 1,
        "stats": stats_payload,
    }
    conn.executemany("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [(k, json.dumps(v)) for k, v in meta.items()])
    conn.commit()
    conn.execute(FTS_RANK_CONFIG)
    conn.execute("INSERT INTO chunks_fts (chunks_fts) VALUES ('optimize')")
    conn.commit()
    conn.execute("PRAGMA optimize")
    conn.commit()
    conn.close()

    meta["db_bytes"] = db_path.stat().st_size
    log.info("regulations with later amendments not in their text: %d", len(later))
    log.info("regulations with a parent law: %d (not found: %d, amendments excluded)", parents_found, parents_missing)
    log.info(
        "built %s: %d documents, %d chunks, %.1f MB",
        db_path,
        len(document_rows),
        total_chunks,
        meta["db_bytes"] / 1024 / 1024,
    )
    return meta


# Document type and group as FTS tokens (column "scope"), so a search can be
# restricted to legislation or court decisions inside the FTS index itself and
# only the top matches are read from D1 (see packages/core/src/sql.ts). The
# "xq" prefix keeps them from matching any word of the text.
LEGISLATION_TYPES = {"yasa", "tuzuk", "anayasa", "yonetmelik", "emirname", "kararname", "andlasma"}


def doc_token(doc_id: str) -> str:
    """FTS token naming one document: "xqd" + hex of the id (same in sql.ts)."""
    return "xqd" + doc_id.encode("utf-8").hex()


def scope_tokens(doc_type: str, doc_id: str = "") -> str:
    group = "mevzuat" if doc_type in LEGISLATION_TYPES else "ictihat" if doc_type == "karar" else "diger"
    tokens = f"xqt{doc_type} xqg{group}"
    return f"{tokens} {doc_token(doc_id)}" if doc_id else tokens


# The scope column only filters; it must not move bm25 (weights: text 1, scope 0).
FTS_RANK_CONFIG = "INSERT INTO chunks_fts(chunks_fts, rank) VALUES('rank', 'bm25(1.0, 0.0)');"


def _chunk_id(doc_id: str, ord_: int, used: set[int]) -> int:
    """Stable 52-bit id (safe as a JavaScript number); probes on the rare clash."""
    value = int(hashlib.sha1(f"{doc_id}\x00{ord_}".encode("utf-8")).hexdigest()[:13], 16) or 1
    while value in used:
        value = value % (2**52 - 1) + 1
    used.add(value)
    return value


def _checksum(text: str) -> str:
    import hashlib

    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def read_stats(db_path: Path = DB_PATH) -> dict[str, Any]:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    meta = {row["key"]: json.loads(row["value"]) for row in conn.execute("SELECT key, value FROM meta")}
    meta["types"] = {
        row["type"]: row["n"] for row in conn.execute("SELECT type, COUNT(*) AS n FROM documents GROUP BY type ORDER BY n DESC")
    }
    meta["years"] = {
        str(row["year"]): row["n"]
        for row in conn.execute("SELECT year, COUNT(*) AS n FROM documents WHERE year IS NOT NULL GROUP BY year ORDER BY year DESC LIMIT 20")
    }
    meta["text_status"] = {
        row["text_status"]: row["n"] for row in conn.execute("SELECT text_status, COUNT(*) AS n FROM documents GROUP BY text_status")
    }
    conn.close()
    return meta


# ---------------------------------------------------------------------------
# Cloudflare D1 export
# ---------------------------------------------------------------------------

D1_SCHEMA = """
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    subtype TEXT,
    title TEXT NOT NULL,
    title_norm TEXT NOT NULL,
    number TEXT,
    year INTEGER,
    date TEXT,
    language TEXT NOT NULL DEFAULT 'tr',
    source TEXT NOT NULL,
    source_url TEXT NOT NULL,
    pdf_url TEXT,
    court TEXT,
    chamber TEXT,
    parties TEXT,
    subject TEXT,
    summary TEXT,
    content_chars INTEGER NOT NULL DEFAULT 0,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    text_status TEXT NOT NULL DEFAULT 'metadata',
    fetched_at TEXT,
    updated_at TEXT,
    checksum TEXT,
    extra_json TEXT,
    sources_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type);
CREATE INDEX IF NOT EXISTS idx_documents_year ON documents(year);
CREATE INDEX IF NOT EXISTS idx_documents_date ON documents(date);
CREATE INDEX IF NOT EXISTS idx_documents_number ON documents(number);
CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source);

CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY,
    doc_id TEXT NOT NULL,
    ord INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT,
    text TEXT NOT NULL,
    chars INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id, ord);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    text_norm,
    scope,
    content = '',
    contentless_delete = 1,
    tokenize = 'unicode61 remove_diacritics 2'
);

-- Worker-side daily counters (Clef budget); never reset by the data import.
CREATE TABLE IF NOT EXISTS usage_counters (
    day TEXT NOT NULL,
    key TEXT NOT NULL,
    n INTEGER NOT NULL,
    PRIMARY KEY (day, key)
);

-- Worker-side LLM query-rewrite cache (apps/worker/src/index.ts); never reset by the data import.
CREATE TABLE IF NOT EXISTS rewrite_cache (
    model TEXT NOT NULL,
    q TEXT NOT NULL,
    terms TEXT NOT NULL,
    laws TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (model, q)
);
""" + HISTORY_TABLES_SQL


def _sql(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value).replace("\x00", "")
    return "'" + text.replace("'", "''") + "'"


class SqlFileWriter:
    def __init__(self, path: Path, max_bytes: int = 40 * 1024 * 1024):
        self.path = path
        self.max_bytes = max_bytes
        self.index = 1
        self.handle = None
        self.size = 0
        self.files: list[Path] = []
        self._open()

    def _open(self) -> None:
        out = self.path.parent / f"{self.path.stem}-{self.index:03d}.sql"
        self.handle = out.open("w", encoding="utf-8", newline="\n")
        self.files.append(out)
        self.size = 0

    def write(self, statement: str) -> None:
        data = statement.rstrip() + "\n"
        if self.size + len(data.encode("utf-8")) > self.max_bytes and self.size > 0:
            self.handle.close()
            self.index += 1
            self._open()
        self.handle.write(data)
        self.size += len(data.encode("utf-8"))

    def close(self) -> list[Path]:
        if self.handle:
            self.handle.close()
            self.handle = None
        return self.files


D1_STATE_VERSION = 5  # bump when chunk ids or the D1 layout change: forces a full import
# v3: chunks_fts gained the "scope" column.
# v4: chunks_fts is contentless in D1 (content='', contentless_delete=1).
# v5: scope carries a per-document token (xqd<hex id>) and bm25 ignores scope.
D1_STATE_FILE = "d1-state.json"
# In D1 the FTS table keeps only the index, not a second copy of every
# chunk's text: that copy was ~37% of the database, and D1 refused writes
# with "Exceeded maximum DB size" (500 MB free tier) on 9 November 2026. The
# API only reads rowid and rank from it. contentless_delete keeps DELETE
# working for incremental imports. The local build keeps the content (the
# export reads it).
_FTS_CREATE = """
CREATE VIRTUAL TABLE chunks_fts USING fts5(text_norm, scope, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2');
"""
_DELETE_BATCH = 100
_VOLATILE_COLUMNS = {"fetched_at", "updated_at"}


def _fingerprints(conn: sqlite3.Connection) -> dict[str, str]:
    """One hash per document over its row, chunks and FTS text."""
    hashes: dict[str, Any] = {}
    for row in conn.execute("SELECT * FROM documents ORDER BY id"):
        h = hashlib.sha1()
        # fetched_at/updated_at are stamped with the build time; they would
        # mark every document as changed. D1 keeps the time of the last real
        # change instead.
        values = [row[k] for k in row.keys() if k not in _VOLATILE_COLUMNS]
        h.update(json.dumps(values, ensure_ascii=False, default=str).encode("utf-8"))
        hashes[row["id"]] = h
    for row in conn.execute(
        "SELECT c.doc_id, c.id, c.ord, c.kind, c.ref, c.text, c.chars, f.text_norm, f.scope "
        "FROM chunks c JOIN chunks_fts f ON f.rowid = c.id ORDER BY c.doc_id, c.ord"
    ):
        h = hashes.get(row["doc_id"])
        if h is not None:
            h.update(json.dumps(list(row), ensure_ascii=False).encode("utf-8"))
    return {doc_id: h.hexdigest() for doc_id, h in hashes.items()}


def _history_fingerprint(conn: sqlite3.Connection) -> Optional[str]:
    has = conn.execute("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'changes'").fetchone()[0]
    if not has:
        return None
    h = hashlib.sha1()
    for table in ("doc_versions", "changes"):
        for row in conn.execute(f"SELECT * FROM {table} ORDER BY 1, 2, 3"):
            h.update(json.dumps(list(row), ensure_ascii=False, default=str).encode("utf-8"))
    return h.hexdigest()


def load_d1_state(path: Optional[Path]) -> Optional[dict[str, Any]]:
    if not path or not Path(path).exists():
        return None
    try:
        state = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        log.warning("d1: unreadable state %s; full import", path)
        return None
    if state.get("version") != D1_STATE_VERSION:
        log.warning("d1: state version %s != %s; full import", state.get("version"), D1_STATE_VERSION)
        return None
    return state


def export_d1(
    db_path: Path = DB_PATH,
    out_dir: Path = DIST_DIR / "d1",
    previous_state: Optional[dict[str, Any]] = None,
) -> list[Path]:
    """Export SQL files that can be imported with wrangler d1 execute.

    With ``previous_state`` (what is already in D1, from the last successful
    import) only new, changed and removed documents are written: their old
    chunks and FTS rows are deleted by doc_id and the new ones inserted. This
    keeps a weekly refresh to a small share of the D1 free-tier daily row
    read/write quota; a full reset rewrites every row. Without a usable state
    the export is a full import, as before.

    ``d1-state.json`` describing the exported database is written next to the
    SQL files; the workflow keeps it only after the import succeeded.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in list(out_dir.glob("*.sql")) + [out_dir / D1_STATE_FILE]:
        if stale.exists():
            stale.unlink()
    (out_dir / "001-schema.sql").write_text(D1_SCHEMA, encoding="utf-8")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    fingerprints = _fingerprints(conn)
    history_fp = _history_fingerprint(conn)
    incremental = previous_state is not None
    old = (previous_state or {}).get("docs", {})
    if incremental:
        changed = sorted(doc_id for doc_id, fp in fingerprints.items() if old.get(doc_id) != fp)
        removed = sorted(doc_id for doc_id in old if doc_id not in fingerprints)
        write_history = history_fp != (previous_state or {}).get("history")
    else:
        changed = sorted(fingerprints)
        removed = []
        write_history = history_fp is not None
        # The FTS table is dropped and recreated rather than emptied: that
        # picks up schema changes (CREATE ... IF NOT EXISTS would keep an old
        # table) and costs no row reads.
        (out_dir / "002-reset.sql").write_text(
            "DROP TABLE IF EXISTS chunks_fts;\n"
            + _FTS_CREATE.strip()
            + "\n"
            + FTS_RANK_CONFIG
            + "\nDELETE FROM chunks;\nDELETE FROM documents;\nDELETE FROM meta;\n"
            "DELETE FROM changes;\nDELETE FROM doc_versions;\n",
            encoding="utf-8",
        )

    if incremental and (changed or removed):
        writer = SqlFileWriter(out_dir / "005-delete.sql")
        targets = changed + removed
        for start in range(0, len(targets), _DELETE_BATCH):
            ids = ",".join(_sql(doc_id) for doc_id in targets[start : start + _DELETE_BATCH])
            # FTS rows are keyed by chunk id, so they go before the chunks.
            writer.write(f"DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE doc_id IN ({ids}));")
            writer.write(f"DELETE FROM chunks WHERE doc_id IN ({ids});")
            writer.write(f"DELETE FROM documents WHERE id IN ({ids});")
        writer.close()

    conn.execute("CREATE TEMP TABLE export_ids (id TEXT PRIMARY KEY)")
    conn.executemany("INSERT INTO export_ids (id) VALUES (?)", [(doc_id,) for doc_id in changed])

    if changed:
        writer = SqlFileWriter(out_dir / "010-documents.sql")
        for row in conn.execute("SELECT d.* FROM documents d JOIN export_ids e ON e.id = d.id ORDER BY d.id"):
            cols = ",".join(row.keys())
            values = ",".join(_sql(row[k]) for k in row.keys())
            writer.write(f"INSERT OR REPLACE INTO documents ({cols}) VALUES ({values});")
        writer.close()

        writer = SqlFileWriter(out_dir / "020-chunks.sql")
        for row in conn.execute("SELECT c.* FROM chunks c JOIN export_ids e ON e.id = c.doc_id ORDER BY c.doc_id, c.ord"):
            writer.write(
                "INSERT OR REPLACE INTO chunks (id,doc_id,ord,kind,ref,text,chars) VALUES "
                f"({row['id']},{_sql(row['doc_id'])},{row['ord']},{_sql(row['kind'])},{_sql(row['ref'])},{_sql(row['text'])},{row['chars']});"
            )
        writer.close()

        writer = SqlFileWriter(out_dir / "030-fts.sql")
        for row in conn.execute(
            "SELECT f.rowid AS rowid, f.text_norm, f.scope FROM chunks_fts f JOIN chunks c ON c.id = f.rowid "
            "JOIN export_ids e ON e.id = c.doc_id ORDER BY c.doc_id, c.ord"
        ):
            writer.write(
                f"INSERT INTO chunks_fts (rowid, text_norm, scope) VALUES ({row['rowid']},{_sql(row['text_norm'])},{_sql(row['scope'])});"
            )
        writer.close()

    # Version history: small; rewritten whole, and only when it changed.
    if write_history:
        writer = SqlFileWriter(out_dir / "040-history.sql")
        if incremental:
            writer.write("DELETE FROM changes;")
            writer.write("DELETE FROM doc_versions;")
        for table in ("doc_versions", "changes"):
            for row in conn.execute(f"SELECT * FROM {table}"):
                cols = ",".join(row.keys())
                values = ",".join(_sql(row[k]) for k in row.keys())
                writer.write(f"INSERT OR REPLACE INTO {table} ({cols}) VALUES ({values});")
        writer.close()

    writer = SqlFileWriter(out_dir / "090-meta.sql")
    for row in conn.execute("SELECT key, value FROM meta"):
        writer.write(f"INSERT OR REPLACE INTO meta (key, value) VALUES ({_sql(row['key'])},{_sql(row['value'])});")
    writer.close()
    conn.close()

    summary = {
        "mode": "incremental" if incremental else "full",
        "documents": len(fingerprints),
        "written": len(changed),
        "removed": len(removed),
        "history": bool(write_history),
    }
    (out_dir / D1_STATE_FILE).write_text(
        json.dumps({"version": D1_STATE_VERSION, "docs": fingerprints, "history": history_fp, "last_export": summary}),
        encoding="utf-8",
    )
    (out_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    manifest = out_dir / "import-order.txt"
    files = sorted(out_dir.glob("*.sql"))
    manifest.write_text(
        "# Run in this order with:\n"
        "#   npx wrangler d1 execute kktc-mevzuat --remote --file=dist/d1/<file>\n"
        + "\n".join(p.name for p in files),
        encoding="utf-8",
    )
    log.info("d1 export: %s (%d SQL files)", summary, len(files))
    return files
