"""The incremental D1 export must leave D1 identical to a full import."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from kktc.build import D1_STATE_FILE, build_database, export_d1, load_d1_state

from tests.test_textproc import LAW


def _docs(variant: str = "a") -> list[dict]:
    docs = [
        {"_id": "yasa-1-2024", "type": "yasa", "title": "2024 Yılı Mali Yasası", "source": "gov",
         "source_url": "https://x/1", "content": LAW, "extra": {}},
        {"_id": "yasa-2-2024", "type": "yasa", "title": "Sabit Yasa", "source": "gov",
         "source_url": "https://x/2", "content": LAW.replace("Mali", "Sabit"), "extra": {}},
        {"_id": "karar-1", "type": "karar", "title": "Bir karar", "source": "mahkemeler",
         "source_url": "https://y", "content": "Karar metni " * 50, "extra": {}},
    ]
    if variant == "b":
        docs[0]["content"] = LAW.replace("bütçelerini kapsar", "bütçelerini ve fonlarını kapsar")
        docs = [d for d in docs if d["_id"] != "karar-1"]
        docs.append({"_id": "yasa-3-2025", "type": "yasa", "title": "Yeni Yasa", "source": "gov",
                     "source_url": "https://x/3", "content": LAW.replace("Mali", "Yeni"), "extra": {}})
    return docs


def _apply(out_dir: Path, target: Path) -> None:
    conn = sqlite3.connect(target)
    order = [l for l in (out_dir / "import-order.txt").read_text().splitlines() if l and not l.startswith("#")]
    for name in order:
        conn.executescript((out_dir / name).read_text(encoding="utf-8"))
    # data.yml merges the index after every import (contentless FTS keeps
    # deleted rows' statistics until then).
    conn.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')")
    conn.commit()
    conn.close()


def _snapshot(path: Path) -> dict:
    conn = sqlite3.connect(path)
    snap = {
        # fetched_at/updated_at are build times; D1 keeps the last real change.
        "documents": [
            tuple(v for k, v in zip(cols, row) if k not in ("fetched_at", "updated_at"))
            for cols in [[c[1] for c in conn.execute("PRAGMA table_info(documents)")]]
            for row in conn.execute("SELECT * FROM documents ORDER BY id")
        ],
        "chunks": conn.execute("SELECT * FROM chunks ORDER BY id").fetchall(),
        # D1's FTS table is contentless, so compare what the index answers:
        # every chunk is found by its own scope and the queries below agree.
        "fts": [
            conn.execute(
                "SELECT rowid, rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rowid", (match,)
            ).fetchall()
            for match in ("fonlarini OR sabit", "yasa OR kapsar OR karar", "scope:xqgmevzuat", "scope:xqgictihat")
        ],
    }
    conn.close()
    return snap


def test_incremental_export_matches_full_import(tmp_path: Path) -> None:
    d1 = tmp_path / "d1.sqlite"

    db_a = tmp_path / "a.db"
    build_database(_docs("a"), db_a)
    out_a = tmp_path / "out-a"
    export_d1(db_a, out_a)
    assert (out_a / "002-reset.sql").exists()
    _apply(out_a, d1)
    assert _snapshot(d1) == _snapshot(db_a)

    db_b = tmp_path / "b.db"
    build_database(_docs("b"), db_b)
    out_b = tmp_path / "out-b"
    export_d1(db_b, out_b, load_d1_state(out_a / D1_STATE_FILE))
    summary = json.loads((out_b / "summary.json").read_text())
    assert summary["mode"] == "incremental"
    assert summary["written"] == 2  # changed yasa-1 and new yasa-3; yasa-2 untouched
    assert summary["removed"] == 1
    assert not (out_b / "002-reset.sql").exists()
    _apply(out_b, d1)
    got, want = _snapshot(d1), _snapshot(db_b)
    # Same rows and the same matches. bm25 values may drift a little after
    # deletes in a contentless table (FTS5 keeps the deleted rows' length
    # statistics); the next full import resets them.
    assert {k: v for k, v in got.items() if k != "fts"} == {k: v for k, v in want.items() if k != "fts"}
    assert [[r for r, _ in q] for q in got["fts"]] == [[r for r, _ in q] for q in want["fts"]]


def test_unchanged_build_writes_no_documents(tmp_path: Path) -> None:
    db = tmp_path / "a.db"
    build_database(_docs("a"), db)
    out1, out2 = tmp_path / "o1", tmp_path / "o2"
    export_d1(db, out1)
    db2 = tmp_path / "a2.db"
    build_database(_docs("a"), db2)
    # A later build stamps a new build time on every row.
    conn = sqlite3.connect(db2)
    conn.execute("UPDATE documents SET fetched_at = '2099-01-01T00:00:00Z', updated_at = '2099-01-01T00:00:00Z'")
    conn.commit()
    conn.close()
    export_d1(db2, out2, load_d1_state(out1 / D1_STATE_FILE))
    names = {p.name for p in out2.glob("*.sql")}
    assert names <= {"001-schema.sql", "040-history-001.sql", "090-meta-001.sql"}, names
    assert json.loads((out2 / "summary.json").read_text())["written"] == 0


def test_chunk_ids_are_stable_across_unrelated_changes(tmp_path: Path) -> None:
    def ids(path: Path, doc_id: str) -> list[int]:
        conn = sqlite3.connect(path)
        try:
            return [r[0] for r in conn.execute("SELECT id FROM chunks WHERE doc_id = ? ORDER BY ord", (doc_id,))]
        finally:
            conn.close()

    a, b = tmp_path / "a.db", tmp_path / "b.db"
    build_database(_docs("a"), a)
    build_database(_docs("b"), b)
    assert ids(a, "yasa-2-2024") == ids(b, "yasa-2-2024")
    assert all(0 < i < 2**53 for i in ids(b, "yasa-3-2025"))


def test_old_or_missing_state_means_full_import(tmp_path: Path) -> None:
    assert load_d1_state(tmp_path / "missing.json") is None
    old = tmp_path / "old.json"
    old.write_text(json.dumps({"version": 1, "docs": {}}))
    assert load_d1_state(old) is None


def test_fts_scope_column_filters_by_type_and_group(tmp_path: Path) -> None:
    db = tmp_path / "a.db"
    build_database(_docs("a"), db)
    conn = sqlite3.connect(db)
    try:
        def docs(match: str) -> set[str]:
            return {
                r[0]
                for r in conn.execute(
                    "SELECT c.doc_id FROM chunks_fts f JOIN chunks c ON c.id = f.rowid WHERE chunks_fts MATCH ?", (match,)
                )
            }

        everything = docs("metni OR yasa*")
        assert docs("(metni OR yasa*) AND scope:xqgictihat") == {"karar-1"}
        assert "karar-1" not in docs("(metni OR yasa*) AND scope:xqgmevzuat")
        assert docs("(metni OR yasa*) AND scope:xqtyasa") == everything - {"karar-1"}
        assert docs("(metni OR yasa*) NOT scope:xqgmevzuat") == {"karar-1"}
        # Scope tokens never match ordinary words.
        assert not docs("xqt*") - everything
    finally:
        conn.close()


def test_history_statements_fit_d1(tmp_path):
    from kktc.build import _D1_STATEMENT_BYTES, _insert, _HISTORY_TEXT_CHARS

    record = {"id": 1, "doc_id": "yasa-x", "old_text": "a" * 150_000, "new_text": "b" * 150_000, "ops_json": "[]"}
    assert len(_insert("changes", record)) > _D1_STATEMENT_BYTES
    short = {**record, "old_text": record["old_text"][:_HISTORY_TEXT_CHARS], "new_text": record["new_text"][:_HISTORY_TEXT_CHARS], "ops_json": None}
    assert len(_insert("changes", short).encode()) < _D1_STATEMENT_BYTES
