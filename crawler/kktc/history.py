"""Version history for consolidated legislation.

Every build compares the current consolidated text of each tracked law or
regulation (mevzuat.gov.ct.tr, or mevzuat.mahkemeler.net for laws the
government site does not carry) with the last version stored in
``history.db``. When the normalised text changes, a new version is stored and
the difference is recorded article by article, with a word-level diff inside
each modified article.

``history.db`` is the only state that must survive between builds (the search
database is rebuilt from scratch every time). In CI it is kept as a GitHub
Release asset; see ``.github/workflows/data.yml``.

Tracking starts on the first run: that run stores a baseline and records no
changes.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import logging
import re
import sqlite3
import time
import zlib
from collections import Counter, OrderedDict
from pathlib import Path
from typing import Any, Iterable, Optional

from .textproc import chunk_document, clean_text

log = logging.getLogger(__name__)

# Both sources publish consolidated texts ("... sayılı Değişiklik Yasaları ile
# değiştirilmiş ve birleştirilmiş şekliyle"). A document present on both is
# merged under the gov copy, so each law is tracked once.
TRACKED_SOURCES = {"gov", "mahkemeler"}
# A new text shorter than this share of the previous one is far more likely to
# be a failed or truncated extraction than a real amendment; it is not stored.
MIN_LENGTH_RATIO = 0.4
MIN_CHARS = 500

HISTORY_SCHEMA = """
CREATE TABLE IF NOT EXISTS versions (
    doc_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    checksum TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    title TEXT,
    type TEXT,
    source_url TEXT,
    source_updated TEXT,
    chars INTEGER NOT NULL,
    content_z BLOB NOT NULL,
    PRIMARY KEY (doc_id, version)
);

CREATE TABLE IF NOT EXISTS changes (
    id INTEGER PRIMARY KEY,
    doc_id TEXT NOT NULL,
    from_version INTEGER NOT NULL,
    to_version INTEGER NOT NULL,
    detected_at TEXT NOT NULL,
    ord INTEGER NOT NULL,
    ref TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('added', 'removed', 'modified')),
    old_text TEXT,
    new_text TEXT,
    ops_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_changes_doc ON changes(doc_id, to_version, ord);
CREATE INDEX IF NOT EXISTS idx_changes_detected ON changes(detected_at);

CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    captured_at TEXT NOT NULL,
    tracked INTEGER NOT NULL,
    baseline INTEGER NOT NULL,
    changed INTEGER NOT NULL,
    skipped INTEGER NOT NULL
);
"""


# ---------------------------------------------------------------------------
# Text normalisation and article alignment
# ---------------------------------------------------------------------------

_SOFT_HYPHEN = re.compile(r"(\w)-\s*\n\s*(\w)")


def normalise(text: str) -> str:
    """Canonical text for comparison: layout differences are not changes."""
    text = clean_text(text or "")
    text = _SOFT_HYPHEN.sub(r"\1\2", text)
    return re.sub(r"\s+", " ", text).strip()


def checksum(text: str) -> str:
    return hashlib.sha1(normalise(text).encode("utf-8")).hexdigest()


_PART_SUFFIX = re.compile(r"\s*\(\d+/\d+\)$")


def sections(text: str, doc_type: str) -> "OrderedDict[str, str]":
    """Split a text into comparable sections keyed by article reference.

    Long articles are chunked into parts by the indexer; the parts are joined
    back so an article compares as a whole. A reference that repeats (e.g. a
    schedule restarting its numbering) gets an occurrence suffix.
    """
    out: "OrderedDict[str, str]" = OrderedDict()
    seen: Counter[str] = Counter()
    last_key: Optional[str] = None
    last_base: Optional[str] = None
    for index, chunk in enumerate(chunk_document(text, doc_type)):
        body = normalise(chunk.text)
        if not body:
            continue
        if chunk.kind == "article" and chunk.ref:
            base = _PART_SUFFIX.sub("", chunk.ref)
            is_continuation = base == last_base and chunk.ref != base
            if is_continuation and last_key:
                out[last_key] += " " + body
                continue
            seen[base] += 1
            key = base if seen[base] == 1 else f"{base} [{seen[base]}]"
            last_base = base
        elif chunk.ref == "Başlangıç":
            key = "Başlangıç"
            if key in out:
                out[key] += " " + body
                continue
            last_base = None
        else:
            # Paragraph-chunked text has no stable references; compare it as
            # one block so the word diff can locate the change.
            key = "Metin"
            if key in out:
                out[key] += " " + body
                continue
            last_base = None
        out[key] = body
        last_key = key
    return out


_TOKEN = re.compile(r"\s+|[^\s]+")
_SENTENCE = re.compile(r"[^.;:]+[.;:]?\s*")
# Above this many token comparisons the word diff gets slow; sentences are
# used as the unit instead.
_MAX_WORD_PAIRS = 40_000_000


def word_ops(old: str, new: str) -> list[list[str]]:
    """Word-level diff as ``[["=", text], ["-", text], ["+", text], ...]``."""
    a = _TOKEN.findall(old)
    b = _TOKEN.findall(new)
    if len(a) * len(b) > _MAX_WORD_PAIRS:
        a = _SENTENCE.findall(old)
        b = _SENTENCE.findall(new)
    ops: list[list[str]] = []

    def push(op: str, tokens: Iterable[str]) -> None:
        text = "".join(tokens)
        if not text:
            return
        if ops and ops[-1][0] == op:
            ops[-1][1] += text
        else:
            ops.append([op, text])

    matcher = difflib.SequenceMatcher(None, a, b, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            push("=", a[i1:i2])
        else:
            push("-", a[i1:i2])
            push("+", b[j1:j2])
    return ops


def diff_sections(old_text: str, new_text: str, doc_type: str) -> list[dict[str, Any]]:
    """Article-level changes between two versions, in new-text order."""
    old = sections(old_text, doc_type)
    new = sections(new_text, doc_type)
    changes: list[dict[str, Any]] = []
    for ref, body in new.items():
        if ref not in old:
            changes.append({"ref": ref, "kind": "added", "old_text": None, "new_text": body, "ops": [["+", body]]})
        elif old[ref] != body:
            changes.append(
                {"ref": ref, "kind": "modified", "old_text": old[ref], "new_text": body, "ops": word_ops(old[ref], body)}
            )
    for ref, body in old.items():
        if ref not in new:
            changes.append({"ref": ref, "kind": "removed", "old_text": body, "new_text": None, "ops": [["-", body]]})
    return changes


# ---------------------------------------------------------------------------
# history.db
# ---------------------------------------------------------------------------


def open_history(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript(HISTORY_SCHEMA)
    return conn


def _pack(text: str) -> bytes:
    return zlib.compress(text.encode("utf-8"), 9)


def _unpack(blob: bytes) -> str:
    return zlib.decompress(blob).decode("utf-8")


def record_versions(
    docs: list[dict[str, Any]],
    history_path: Path,
    *,
    now: Optional[str] = None,
) -> dict[str, Any]:
    """Store new versions of tracked documents and their article-level changes.

    ``docs`` are merged catalogue documents carrying ``_id`` and ``content``.
    Documents missing from this run (e.g. a source that timed out) are left
    untouched: absence is never recorded as a repeal.
    """
    now = now or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    conn = open_history(history_path)
    latest = {
        row[0]: (row[1], row[2], row[3])
        for row in conn.execute(
            """
            SELECT v.doc_id, v.version, v.checksum, v.chars FROM versions v
            JOIN (SELECT doc_id, MAX(version) AS version FROM versions GROUP BY doc_id) m
              ON m.doc_id = v.doc_id AND m.version = v.version
            """
        )
    }
    counts = Counter()
    for doc in docs:
        if doc.get("source") not in TRACKED_SOURCES or doc.get("type") == "karar":
            continue
        content = doc.get("content") or ""
        canonical = normalise(content)
        if len(canonical) < MIN_CHARS:
            continue
        doc_id = doc["_id"]
        digest = hashlib.sha1(canonical.encode("utf-8")).hexdigest()
        counts["tracked"] += 1
        previous = latest.get(doc_id)
        if previous and previous[1] == digest:
            continue
        if previous and len(canonical) < previous[2] * MIN_LENGTH_RATIO:
            log.warning(
                "history: %s shrank from %d to %d chars; skipped as a probable extraction failure",
                doc_id,
                previous[2],
                len(canonical),
            )
            counts["skipped"] += 1
            continue
        version = (previous[0] + 1) if previous else 1
        extra = doc.get("extra") or {}
        conn.execute(
            """
            INSERT INTO versions (doc_id, version, checksum, captured_at, title, type,
                                  source_url, source_updated, chars, content_z)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            """,
            (
                doc_id,
                version,
                digest,
                now,
                clean_text(doc.get("title") or ""),
                doc.get("type"),
                doc.get("source_url"),
                extra.get("source_updated"),
                len(canonical),
                _pack(clean_text(content)),
            ),
        )
        if not previous:
            counts["baseline"] += 1
            continue
        old_blob = conn.execute(
            "SELECT content_z FROM versions WHERE doc_id = ? AND version = ?", (doc_id, previous[0])
        ).fetchone()[0]
        diff = diff_sections(_unpack(old_blob), content, doc.get("type") or "yasa")
        conn.executemany(
            """
            INSERT INTO changes (doc_id, from_version, to_version, detected_at, ord, ref, kind,
                                 old_text, new_text, ops_json)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            """,
            [
                (
                    doc_id,
                    previous[0],
                    version,
                    now,
                    ord_,
                    change["ref"],
                    change["kind"],
                    change["old_text"],
                    change["new_text"],
                    json.dumps(change["ops"], ensure_ascii=False),
                )
                for ord_, change in enumerate(diff)
            ],
        )
        counts["changed"] += 1
        log.info("history: %s v%d -> v%d, %d sections changed", doc_id, previous[0], version, len(diff))
    conn.execute(
        "INSERT INTO runs (captured_at, tracked, baseline, changed, skipped) VALUES (?,?,?,?,?)",
        (now, counts["tracked"], counts["baseline"], counts["changed"], counts["skipped"]),
    )
    conn.commit()
    since = conn.execute("SELECT MIN(captured_at) FROM runs").fetchone()[0]
    conn.close()
    summary = {
        "captured_at": now,
        "tracking_since": since,
        "tracked": counts["tracked"],
        "baseline": counts["baseline"],
        "changed": counts["changed"],
        "skipped": counts["skipped"],
    }
    log.info("history: %s", summary)
    return summary


HISTORY_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS doc_versions (
    doc_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    checksum TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    title TEXT,
    source_url TEXT,
    source_updated TEXT,
    chars INTEGER NOT NULL,
    PRIMARY KEY (doc_id, version)
);

CREATE TABLE IF NOT EXISTS changes (
    id INTEGER PRIMARY KEY,
    doc_id TEXT NOT NULL,
    from_version INTEGER NOT NULL,
    to_version INTEGER NOT NULL,
    detected_at TEXT NOT NULL,
    ord INTEGER NOT NULL,
    ref TEXT,
    kind TEXT NOT NULL,
    old_text TEXT,
    new_text TEXT,
    ops_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_changes_doc ON changes(doc_id, to_version, ord);
CREATE INDEX IF NOT EXISTS idx_changes_detected ON changes(detected_at);
"""


def copy_history_into(db_path: Path, history_path: Path) -> dict[str, Any]:
    """Copy version metadata and changes (not full texts) into the search DB."""
    conn = sqlite3.connect(db_path)
    conn.executescript(HISTORY_TABLES_SQL)
    meta: dict[str, Any] = {"tracking_since": None, "versions": 0, "changes": 0}
    if history_path.exists():
        conn.execute("ATTACH DATABASE ? AS h", (str(history_path),))
        conn.execute(
            """
            INSERT INTO doc_versions (doc_id, version, checksum, captured_at, title, source_url, source_updated, chars)
            SELECT doc_id, version, checksum, captured_at, title, source_url, source_updated, chars FROM h.versions
            """
        )
        conn.execute(
            """
            INSERT INTO changes (id, doc_id, from_version, to_version, detected_at, ord, ref, kind,
                                 old_text, new_text, ops_json)
            SELECT id, doc_id, from_version, to_version, detected_at, ord, ref, kind,
                   old_text, new_text, ops_json FROM h.changes
            """
        )
        meta["tracking_since"] = conn.execute("SELECT MIN(captured_at) FROM h.runs").fetchone()[0]
        meta["last_history_run"] = conn.execute("SELECT MAX(captured_at) FROM h.runs").fetchone()[0]
        conn.commit()
        conn.execute("DETACH DATABASE h")
    meta["versions"] = conn.execute("SELECT COUNT(*) FROM doc_versions").fetchone()[0]
    meta["changes"] = conn.execute("SELECT COUNT(*) FROM changes").fetchone()[0]
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('history', ?)", (json.dumps(meta),))
    conn.commit()
    conn.close()
    return meta
