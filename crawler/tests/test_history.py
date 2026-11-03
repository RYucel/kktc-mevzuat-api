from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from kktc.history import copy_history_into, diff_sections, normalise, record_versions, word_ops

from tests.test_textproc import LAW

AMENDED = (
    LAW.replace("Maliye Bakanlığını", "Maliye ve Ekonomi Bakanlığını")
    .replace(
        "Yürütme 4. Bu Yasa'nın yürütülmesi Bakanlar Kuruluna aittir.\n\n",
        "",
    )
    .replace(
        "Yürürlük 5.",
        "Geçici Hüküm 4A. Mevcut bütçeler yıl sonuna kadar geçerlidir.\n\nYürürlük 5.",
    )
)


def _doc(content: str, **over) -> dict:
    doc = {
        "_id": "yasa-1-2024",
        "type": "yasa",
        "title": "2024 Yılı Mali Yasası",
        "source": "gov",
        "source_url": "https://mevzuat.gov.ct.tr/x.pdf",
        "content": content,
        "extra": {},
    }
    doc.update(over)
    return doc


def test_normalise_ignores_layout() -> None:
    assert normalise("Bu  Yasa\n\nbakan-\nlık") == normalise("Bu Yasa bakanlık")


def test_word_ops_marks_only_changed_words() -> None:
    ops = word_ops("Maliye Bakanlığını ifade eder.", "Maliye ve Ekonomi Bakanlığını ifade eder.")
    assert ["+", "ve Ekonomi "] in ops or any(op == "+" and "Ekonomi" in text for op, text in ops)
    assert "".join(t for op, t in ops if op != "+") == "Maliye Bakanlığını ifade eder."
    assert "".join(t for op, t in ops if op != "-") == "Maliye ve Ekonomi Bakanlığını ifade eder."


def test_diff_sections_by_article() -> None:
    changes = {c["ref"]: c["kind"] for c in diff_sections(LAW, AMENDED, "yasa")}
    assert changes == {"Madde 2": "modified", "Madde 4A": "added", "Madde 4": "removed"}


def test_record_versions_baseline_then_change(tmp_path: Path) -> None:
    history = tmp_path / "history.db"
    first = record_versions([_doc(LAW)], history, now="2026-11-02T00:00:00Z")
    assert first["baseline"] == 1 and first["changed"] == 0

    same = record_versions([_doc(LAW + "\n\n")], history, now="2026-11-09T00:00:00Z")
    assert same["changed"] == 0 and same["baseline"] == 0

    second = record_versions([_doc(AMENDED)], history, now="2026-11-16T00:00:00Z")
    assert second["changed"] == 1

    conn = sqlite3.connect(history)
    rows = conn.execute("SELECT ref, kind, from_version, to_version FROM changes ORDER BY ord").fetchall()
    assert ("Madde 2", "modified", 1, 2) in rows
    assert len(rows) == 3
    conn.close()


def test_absent_or_truncated_documents_are_not_changes(tmp_path: Path) -> None:
    history = tmp_path / "history.db"
    long_law = LAW + "\n\nEk Cetvel\n\n" + "bütçe kalemi " * 300
    record_versions([_doc(long_law)], history, now="2026-11-02T00:00:00Z")
    # Missing from the run: nothing happens.
    assert record_versions([], history, now="2026-11-09T00:00:00Z")["changed"] == 0
    # A failed extraction leaves a fragment: skipped, not stored.
    result = record_versions([_doc(long_law[:900])], history, now="2026-11-16T00:00:00Z")
    assert result["skipped"] == 1 and result["changed"] == 0
    # Court decisions are not tracked; mahkemeler laws are.
    result = record_versions(
        [_doc(long_law, _id="karar-1", type="karar"), _doc(long_law, _id="yasa-x", source="mahkemeler")],
        history,
        now="2026-11-23T00:00:00Z",
    )
    assert result["tracked"] == 1 and result["baseline"] == 1


def test_copy_history_into_search_db(tmp_path: Path) -> None:
    history = tmp_path / "history.db"
    record_versions([_doc(LAW)], history, now="2026-11-02T00:00:00Z")
    record_versions([_doc(AMENDED)], history, now="2026-11-09T00:00:00Z")
    db = tmp_path / "kktc.db"
    sqlite3.connect(db).execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)").connection.commit()
    meta = copy_history_into(db, history)
    assert meta["tracking_since"] == "2026-11-02T00:00:00Z"
    assert meta["versions"] == 2 and meta["changes"] == 3
    conn = sqlite3.connect(db)
    ops = json.loads(conn.execute("SELECT ops_json FROM changes WHERE ref = 'Madde 2'").fetchone()[0])
    assert any(op == "+" for op, _ in ops)
    conn.close()
