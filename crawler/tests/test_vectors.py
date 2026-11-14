from __future__ import annotations

import gzip
import json
from pathlib import Path

import pytest

from kktc import vectors
from kktc.build import build_database

from tests.test_textproc import LAW


def _db(tmp_path: Path, content: str = LAW) -> Path:
    docs = [
        {"_id": "yasa-1-2024", "type": "yasa", "title": "2024 Yılı Mali Yasası", "source": "gov",
         "source_url": "https://x", "content": content, "extra": {}},
        {"_id": "karar-1", "type": "karar", "title": "Bir karar", "source": "mahkemeler",
         "source_url": "https://y", "content": "Karar metni " * 100, "extra": {}},
    ]
    path = tmp_path / "kktc.db"
    build_database(docs, path)
    return path


def test_units_are_articles_with_d1_ordinals(tmp_path: Path) -> None:
    db = _db(tmp_path)
    units = vectors.build_units(db)
    refs = [u["ref"] for u in units]
    assert refs == ["Başlangıç", "Madde 1", "Madde 2", "Madde 3", "Madde 4", "Madde 5"]
    assert all(u["type"] == "yasa" for u in units), "court decisions are not embedded"
    import sqlite3

    conn = sqlite3.connect(db)
    for unit in units:
        ref = conn.execute("SELECT ref FROM chunks WHERE doc_id = ? AND ord = ?", (unit["doc_id"], unit["ord"])).fetchone()[0]
        assert ref == unit["ref"]
    assert units[1]["text"].startswith("2024 Yılı Mali Yasası — Madde 1\n")
    assert len({u["id"] for u in units}) == len(units)


def test_long_articles_are_joined_and_capped(tmp_path: Path) -> None:
    long_law = LAW.replace(
        "Kapsam 3. Bu Yasa, kamu kurumlarının bütçelerini kapsar.",
        "Kapsam 3. " + "Bu Yasa kamu kurumlarının bütçelerini kapsar. " * 200,
    )
    units = vectors.build_units(_db(tmp_path, long_law))
    madde3 = [u for u in units if u["ref"] == "Madde 3"]
    assert len(madde3) == 1
    assert len(madde3[0]["text"]) <= vectors.MAX_UNIT_CHARS


def test_prioritise_keeps_laws_over_regulations() -> None:
    units = [
        {"id": str(i), "type": t, "source": "mahkemeler", "doc_id": f"d{i}", "ord": 1, "text": "x"}
        for i, t in enumerate(["tuzuk", "yasa", "anayasa", "tuzuk"])
    ]
    kept = vectors.prioritise(units, limit=2)
    assert [u["type"] for u in kept] == ["anayasa", "yasa"]


def test_export_roundtrip(tmp_path: Path) -> None:
    out = tmp_path / "units.jsonl.gz"
    stats = vectors.export_units(_db(tmp_path), out)
    assert stats["units"] == 6
    assert len(vectors.load_units(out)) == 6
    with gzip.open(out, "rt", encoding="utf-8") as handle:
        assert set(json.loads(handle.readline())) >= {"id", "text", "doc_id", "ord", "ref", "type"}


class FakeWorker:
    def __init__(self, fail_after: int | None = None):
        self.vectors: dict[str, dict] = {}
        self.calls = 0
        self.fail_after = fail_after

    def __call__(self, path: str, payload: dict) -> dict:
        self.calls += 1
        if path == "/admin/vectors/upsert":
            if self.fail_after is not None and len(self.vectors) >= self.fail_after:
                raise vectors.BudgetExhausted("HTTP 429: daily neuron allocation exceeded")
            for unit in payload["units"]:
                self.vectors[unit["id"]] = unit
            return {"upserted": len(payload["units"])}
        if path == "/admin/vectors/delete":
            for vector_id in payload["ids"]:
                self.vectors.pop(vector_id, None)
            return {"deleted": len(payload["ids"])}
        raise AssertionError(path)


def _units(n: int, text: str = "metin") -> list[dict]:
    return [
        {"id": f"id{i}", "text": f"{text} {i}", "doc_id": "yasa-1", "ord": i, "ref": f"Madde {i}", "type": "yasa"}
        for i in range(n)
    ]


def test_sync_adds_then_only_changes() -> None:
    worker = FakeWorker()
    manifest = vectors.load_manifest(Path("/nonexistent/vectors.json"))
    first = vectors.sync(_units(70), manifest, worker, budget_tokens=10**9, batch_size=32)
    assert first["upserted"] == 70 and first["remaining"] == 0 and len(worker.vectors) == 70

    changed = _units(70)[:60] + [dict(u, id=f"new{u['ord']}") for u in _units(70)[60:]]
    calls = worker.calls
    second = vectors.sync(changed, manifest, worker, budget_tokens=10**9, batch_size=32)
    assert second == {**second, "upserted": 10, "deleted": 10, "remaining": 0}
    assert set(worker.vectors) == {u["id"] for u in changed}
    assert worker.calls - calls == 2  # one delete batch, one upsert batch


def test_sync_respects_budget_and_resumes() -> None:
    worker = FakeWorker()
    manifest = vectors.load_manifest(Path("/nonexistent/vectors.json"))
    units = _units(100, text="x" * 300)  # ~100 tokens each
    budget = sum(vectors.estimate_tokens(u["text"]) for u in units[:30])
    first = vectors.sync(units, manifest, worker, budget_tokens=budget, batch_size=10)
    assert first["upserted"] == 30 and first["stopped"] == "budget" and first["remaining"] == 70
    second = vectors.sync(units, manifest, worker, budget_tokens=10**9, batch_size=10)
    assert second["upserted"] == 70 and second["remaining"] == 0


def test_sync_stops_cleanly_when_workers_ai_quota_is_hit() -> None:
    worker = FakeWorker(fail_after=40)
    manifest = vectors.load_manifest(Path("/nonexistent/vectors.json"))
    result = vectors.sync(_units(100), manifest, worker, budget_tokens=10**9, batch_size=20)
    assert result["upserted"] == 40 and result["stopped"].startswith("workers-ai")
    assert set(manifest["ids"]) == set(worker.vectors)


def test_model_change_resets_manifest(tmp_path: Path) -> None:
    path = tmp_path / "vectors.json"
    path.write_text(json.dumps({"model": "old", "dims": 64, "ids": {"a": ["d", 1]}}))
    manifest = vectors.load_manifest(path)
    assert manifest["ids"] == {} and manifest["stale_model_ids"] == ["a"]
    worker = FakeWorker()
    worker.vectors["a"] = {}
    vectors.sync(_units(2), manifest, worker, budget_tokens=10**9)
    assert "a" not in worker.vectors


@pytest.mark.parametrize("token", ["abc", "x" * 40])
def test_admin_token_is_stable_and_not_the_api_token(token: str) -> None:
    assert vectors.admin_token(token) == vectors.admin_token(token)
    assert token not in vectors.admin_token(token)


def test_unquotable_documents_take_no_vector_space(tmp_path: Path) -> None:
    base = {"source_url": "https://x", "content": LAW, "extra": {}}
    docs = [
        {**base, "_id": "tuzuk-gov", "type": "tuzuk", "title": "MAL VE HİZMETLER TÜZÜĞÜ", "source": "gov"},
        {**base, "_id": "tuzuk-869", "type": "tuzuk", "title": "Mal ve Hizmetler Tüzüğü", "source": "mahkemeler"},
        {**base, "_id": "tuzuk-954", "type": "tuzuk", "title": "Mal ve Hizmetler (Değişiklik) Tüzüğü", "source": "mahkemeler"},
        {**base, "_id": "tuzuk-other", "type": "tuzuk", "title": "Başka Tüzük", "source": "mahkemeler"},
    ]
    path = tmp_path / "kktc.db"
    build_database(docs, path)
    assert sorted({u["doc_id"] for u in vectors.build_units(path)}) == ["tuzuk-gov", "tuzuk-other"]


def test_prioritise_prefers_newer_regulations() -> None:
    units = [
        {"id": str(i), "type": "tuzuk", "source": "mahkemeler", "year": y, "doc_id": f"d{i}", "ord": 1, "text": "x"}
        for i, y in enumerate([1980, 2024, None, 2015])
    ]
    assert [u["year"] for u in vectors.prioritise(units, limit=2)] == [2024, 2015]


def test_format_2_carries_the_statute_context(tmp_path: Path) -> None:
    db = _db(tmp_path)
    old = {u["ref"]: u for u in vectors.build_units(db)}
    new = {u["ref"]: u for u in vectors.build_units(db, fmt=2)}
    assert old.keys() == new.keys()
    first, second = old["Madde 2"]["text"], new["Madde 2"]["text"]
    assert second.splitlines()[0].endswith("— Madde 2")
    # Same article text at the end; a context line is added when the build has a card.
    assert second.endswith(first.split("\n", 1)[1][-50:])
    assert old["Madde 2"]["id"] != new["Madde 2"]["id"] or first == second


def test_max_vectors_by_dimensions() -> None:
    assert vectors.max_vectors(192) == 24739
    assert vectors.max_vectors(128) == 37109


def test_sync_splits_a_batch_that_is_too_big() -> None:
    units = [{"id": f"u{i}", "text": "x" * 900, "doc_id": "d", "ord": i, "ref": f"Madde {i}", "type": "yasa"} for i in range(6)]
    calls = []

    def post(path, payload):
        n = len(payload.get("units", []))
        calls.append(n)
        if n > 2:
            raise RuntimeError("/admin/vectors/upsert failed: HTTP 502: 3030: input too big")
        return {"upserted": n}

    summary = vectors.sync(units, {"ids": {}}, post, budget_tokens=10**6)
    assert summary["upserted"] == 6 and summary["remaining"] == 0
    assert max(n for n in calls if n <= 2) <= 2
