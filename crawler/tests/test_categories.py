import json
from pathlib import Path

from kktc.categories import FALLBACK, assign, load_categories, title_categories

REPO = Path(__file__).resolve().parents[2]


def test_repository_files_are_consistent():
    ids, assigned = load_categories(REPO / "categories")
    assert FALLBACK in ids and 12 <= len(ids) <= 16
    assert len(assigned) > 800
    raw = [json.loads(l) for l in (REPO / "categories" / "statutes.jsonl").read_text(encoding="utf-8").splitlines() if l]
    assert all(set(r["categories"]) <= ids for r in raw), "unknown category id in statutes.jsonl"
    assert assigned["yasa-fasil-154"] == ["ceza"]
    assert assigned["yasa-22-1992"] == ["is-sosyal-guvenlik"]
    assert assigned["yasa-35-2010"] == ["tasinmaz-kira"]
    diger = sum(1 for c in assigned.values() if c == [FALLBACK])
    assert diger / len(assigned) < 0.15


def test_regulation_inherits_parent_law():
    assigned = {"yasa-22-1992": ["is-sosyal-guvenlik"]}
    assert assign("tuzuk-x", "tuzuk", "Bir Tüzük", "yasa-22-1992", assigned) == (["is-sosyal-guvenlik"], "parent")


def test_file_wins_then_title_then_fallback():
    assigned = {"yasa-1": ["aile"]}
    assert assign("yasa-1", "yasa", "Ceza Yasası", None, assigned)[1] == "file"
    assert assign("tuzuk-y", "tuzuk", "Trafik Tüzüğü", None, assigned) == (["trafik-ulasim"], "title")
    assert assign("tuzuk-z", "tuzuk", "Bir Başka Tüzük", None, assigned) == ([FALLBACK], "fallback")


def test_title_keywords_are_word_anchored():
    # "Hususlar" must not match water ("su"), "Yapılması" must not match buildings.
    assert "cevre-tarim-hayvan" not in title_categories("Diğer Hususlar İle İlgili Yasa")
    assert "tasinmaz-kira" not in title_categories("Seçimlerin Yapılmasına İlişkin Yasa")
    assert "is-sosyal-guvenlik" in title_categories("İŞ SAĞLIĞI VE GÜVENLİĞİ TÜZÜĞÜ")
    assert title_categories("Halk Sağlığı Tüzüğü") == ["saglik"]
