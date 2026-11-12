from kktc.amendments import amended_articles, amendment_key, later_amendments


def test_amendment_key_matches_base():
    assert amendment_key("Burs (Değişiklik No.2) Tüzüğü") == amendment_key("BURS TÜZÜĞÜ")
    assert amendment_key("2008 Fazla Mesai Ücretleri (Değişiklik) Tüzüğü") == amendment_key("2008 FAZLA MESAİ ÜCRETLERİ TÜZÜĞÜ")


def test_amended_articles_from_text():
    text = "Esas Tüzüğün 17'nci maddesi kaldırılır ve yerine ... Esas Tüzüğün 5 inci maddesinin (2)'nci fıkrası"
    assert amended_articles(text) == ["17", "5"]


def test_only_amendments_after_the_text():
    base = {"title": "Burs Tüzüğü", "content": "x", "extra": {"consolidation": {"through": "2024-10-28"}}}
    old = {"title": "Burs (Değişiklik) Tüzüğü", "content": "Esas Tüzüğün 3'üncü maddesi değiştirilir"}
    new = {"title": "Burs (Değişiklik No.2) Tüzüğü", "content": "Esas Tüzüğün 5'inci maddesi değiştirilir"}
    out = later_amendments([("tuzuk-burs", base, "2023-11-10"), ("tuzuk-1", old, "2024-02-29"), ("tuzuk-2", new, "2025-08-23")])
    assert out == {"tuzuk-burs": [{"id": "tuzuk-2", "date": "2025-08-23", "articles": ["5"]}]}
