from __future__ import annotations

import gzip
import json

import pytest

pq = pytest.importorskip("pyarrow.parquet")

from kktc.build import build_database
from kktc.hf_export import export
from kktc.vectors import build_units, question_key

LAW = (
    "DENEME YASASI\n\n"
    "Kısa İsim 1. Bu Yasa, Deneme Yasası olarak isimlendirilir ve yürürlükteki tüm denemeleri kapsar.\n\n"
    "Tefsir 2. Bu Yasada metin başka türlü gerektirmedikçe, Bakanlık deneme işlerinden sorumlu bakanlığı "
    "anlatır ve kapsamı geniş olarak yorumlanır; Daire ise ilgili daireyi anlatır.\n\n"
    "Amaç 3. Bu Yasanın amacı denemedir ve uygulamada herkese eşit davranılır. " * 3
)


def _docs():
    return [
        {
            "_id": "yasa-5-2020", "type": "yasa", "title": "5/2020 SAYILI DENEME YASASI", "number": "5/2020",
            "year": 2020, "date": "2020-03-01", "source": "gov", "source_url": "https://mevzuat.gov.ct.tr/x",
            "content": LAW, "extra": {"consolidation": {"through": "12/2024"}},
        },
        {
            "_id": "tuzuk-3-1990", "type": "tuzuk", "title": "Eski Deneme Tüzüğü", "number": "3/1990",
            "year": 1990, "source": "mahkemeler", "source_url": "https://mevzuat.mahkemeler.net/t", "content": "",
        },
        {
            "_id": "karar-1", "type": "karar", "title": "Yargıtay/Hukuk - E.4/2022 - A - B (Kira)", "number": "E.4/2022",
            "year": 2023, "date": "2023-05-02", "source": "mahkemeler", "source_url": "https://mevzuat.mahkemeler.net/k",
            "court": "Yargıtay/Hukuk", "parties": "A - B", "subject": "Kira", "summary": "Kira artışı.",
            "content": "Davacı kira artışının yasaya aykırı olduğunu ileri sürmüştür. " * 20,
            "extra": {"enumara": 4, "yile": 2022, "dnumara": 10, "yild": 2023, "yasa_madde": "5/2020 m.3"},
        },
    ]


def test_export_writes_three_configs_with_questions(tmp_path):
    db = tmp_path / "kktc.db"
    build_database(_docs(), db)

    unit = next(u for u in build_units(db) if u["ref"] == "Madde 2")
    key = question_key(unit["doc_id"], unit["ref"], unit["text"].split("\n", 1)[1])
    qpath = tmp_path / "questions.jsonl.gz"
    with gzip.open(qpath, "wt", encoding="utf-8") as fh:
        fh.write(json.dumps({"key": key, "questions": ["Bakanlık ne demek?"]}, ensure_ascii=False) + "\n")

    out = tmp_path / "hf"
    stats = export(db, out, qpath)

    mevzuat = pq.read_table(out / "data/mevzuat.parquet").to_pylist()
    by_id = {r["id"]: r for r in mevzuat}
    assert by_id["yasa-5-2020"]["consolidated_through"] == "12/2024"
    assert "Kısa İsim 1." in by_id["yasa-5-2020"]["text"]
    assert by_id["tuzuk-3-1990"]["text_status"] == "metadata" and by_id["tuzuk-3-1990"]["text"] is None

    karar = pq.read_table(out / "data/kararlar.parquet").to_pylist()[0]
    assert (karar["esas_no"], karar["karar_no"], karar["cited_articles"]) == ("E.4/2022", "D.10/2023", "5/2020 m.3")
    assert "parties" not in karar and "A - B" not in karar["title"]
    assert karar["title"] == "Yargıtay/Hukuk - E.4/2022 (Kira)"

    maddeler = pq.read_table(out / "data/maddeler.parquet").to_pylist()
    assert [r["ref"] for r in maddeler] == ["Madde 1", "Madde 2", "Madde 3"]
    assert {r["doc_id"] for r in maddeler} == {"yasa-5-2020"}
    assert next(r for r in maddeler if r["ref"] == "Madde 2")["questions"] == ["Bakanlık ne demek?"]

    assert stats["maddeler_with_questions"] == 1 and stats["kararlar_total"] == 1
    card = (out / "README.md").read_text(encoding="utf-8")
    assert "config_name: maddeler" in card and "| Tüzük | 1 | 0 | 1 |" in card
