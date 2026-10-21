"""Build the searchable SQLite database and export data for Cloudflare D1."""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from collections import Counter
from pathlib import Path
from typing import Any, Iterable, Optional

from .config import DB_PATH, DIST_DIR
from .textproc import Chunk, chunk_document, clean_text, fold_tr, normalize_title

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
    tokenize = 'unicode61 remove_diacritics 2'
);
"""


def _subtype(doc: dict[str, Any]) -> Optional[str]:
    extra = doc.get("extra") or {}
    return extra.get("tur") or extra.get("yasa_turu") or extra.get("category")


def _chunks_for(doc: dict[str, Any]) -> list[Chunk]:
    title = clean_text(doc.get("title") or "")
    chunks: list[Chunk] = [Chunk("title", "Başlık", title)] if title else []
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
        document_rows.append(
            (
                doc_id,
                doc.get("type") or "yasa",
                _subtype(doc),
                title,
                normalize_title(title),
                doc.get("number"),
                doc.get("year"),
                doc.get("date"),
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

    # Insert chunks first to obtain stable ids, then feed the FTS index.
    chunk_ids: list[tuple[int, str]] = []
    next_id = 1
    for row in chunk_rows:
        chunk_ids.append((next_id, row))
        next_id += 1

    conn.executemany(
        "INSERT INTO chunks (id, doc_id, ord, kind, ref, text, chars) VALUES (?,?,?,?,?,?,?)",
        [(cid, *row) for cid, row in chunk_ids],
    )
    conn.executemany(
        "INSERT INTO chunks_fts (rowid, text_norm) VALUES (?, ?)",
        [(cid, fold_tr(row[4])) for cid, row in chunk_ids],
    )

    meta = {
        "built_at": now,
        "document_count": len(document_rows),
        "chunk_count": total_chunks,
        "chars": total_chars,
        "by_type": dict(stats_types),
        "by_source": dict(stats_sources),
        "schema_version": 1,
    }
    conn.executemany("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [(k, json.dumps(v)) for k, v in meta.items()])
    conn.commit()
    conn.execute("INSERT INTO chunks_fts (chunks_fts) VALUES ('optimize')")
    conn.commit()
    conn.execute("PRAGMA optimize")
    conn.commit()
    conn.close()

    meta["db_bytes"] = db_path.stat().st_size
    log.info(
        "built %s: %d documents, %d chunks, %.1f MB",
        db_path,
        len(document_rows),
        total_chunks,
        meta["db_bytes"] / 1024 / 1024,
    )
    return meta


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
    tokenize = 'unicode61 remove_diacritics 2'
);
"""


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


def export_d1(db_path: Path = DB_PATH, out_dir: Path = DIST_DIR / "d1") -> list[Path]:
    """Export SQL files that can be imported with wrangler d1 execute."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("*.sql"):
        stale.unlink()
    (out_dir / "001-schema.sql").write_text(D1_SCHEMA, encoding="utf-8")
    (out_dir / "002-reset.sql").write_text(
        "DELETE FROM chunks_fts;\nDELETE FROM chunks;\nDELETE FROM documents;\nDELETE FROM meta;\n",
        encoding="utf-8",
    )

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    writer = SqlFileWriter(out_dir / "010-documents.sql")
    for row in conn.execute("SELECT * FROM documents ORDER BY id"):
        cols = ",".join(row.keys())
        values = ",".join(_sql(row[k]) for k in row.keys())
        writer.write(f"INSERT OR REPLACE INTO documents ({cols}) VALUES ({values});")
    files = writer.close()

    writer = SqlFileWriter(out_dir / "020-chunks.sql")
    for row in conn.execute("SELECT * FROM chunks ORDER BY id"):
        writer.write(
            "INSERT OR REPLACE INTO chunks (id,doc_id,ord,kind,ref,text,chars) VALUES "
            f"({row['id']},{_sql(row['doc_id'])},{row['ord']},{_sql(row['kind'])},{_sql(row['ref'])},{_sql(row['text'])},{row['chars']});"
        )
    files += writer.close()

    writer = SqlFileWriter(out_dir / "030-fts.sql")
    for row in conn.execute("SELECT rowid, text_norm FROM chunks_fts ORDER BY rowid"):
        writer.write(f"INSERT INTO chunks_fts (rowid, text_norm) VALUES ({row['rowid']},{_sql(row['text_norm'])});")
    files += writer.close()

    writer = SqlFileWriter(out_dir / "090-meta.sql")
    for row in conn.execute("SELECT key, value FROM meta"):
        writer.write(f"INSERT OR REPLACE INTO meta (key, value) VALUES ({_sql(row['key'])},{_sql(row['value'])});")
    files += writer.close()
    conn.close()

    manifest = out_dir / "import-order.txt"
    manifest.write_text(
        "# Run in this order with:\n"
        "#   npx wrangler d1 execute kktc-mevzuat --remote --file=dist/d1/<file>\n"
        + "\n".join(p.name for p in sorted(out_dir.glob("*.sql"))),
        encoding="utf-8",
    )
    log.info("exported %d SQL files to %s", len(files) + 2, out_dir)
    return sorted(out_dir.glob("*.sql"))
