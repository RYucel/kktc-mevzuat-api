from __future__ import annotations

from kktc.build import _chunks_for, _valid_date


def test_valid_date_keeps_plausible_dates() -> None:
    assert _valid_date({"date": "2024-02-22"}) == "2024-02-22"
    assert _valid_date({"date": "1978-12-05"}) == "1978-12-05"
    assert _valid_date({"date": "2026-11-03T00:00:00"}) == "2026-11-03"


def test_valid_date_drops_source_typos() -> None:
    # mevzuat.mahkemeler.net has these impossible values in its catalogue.
    assert _valid_date({"date": "2202-12-29"}) is None
    assert _valid_date({"date": "0198-04-12"}) is None
    assert _valid_date({"date": "1878-12-05"}) is None


def test_valid_date_rejects_missing_or_malformed_values() -> None:
    assert _valid_date({"date": None}) is None
    assert _valid_date({}) is None
    assert _valid_date({"date": "2024-13-01"}) is None
    assert _valid_date({"date": "22.02.2024"}) is None


def test_title_chunk_includes_number_for_metadata_only_documents() -> None:
    chunks = _chunks_for(
        {
            "title": "Gümrük Vergileri Oranları Tüzüğü",
            "number": "1122-2024",
            "content": "",
            "type": "tuzuk",
        }
    )
    assert chunks[0].text == "Gümrük Vergileri Oranları Tüzüğü 1122-2024"

    already = _chunks_for({"title": "24/1982 SAYILI GELİR VERGİSİ YASASI", "number": "24/1982"})
    assert already[0].text == "24/1982 SAYILI GELİR VERGİSİ YASASI"


def test_canonical_id_drops_leading_zeros():
    from kktc.textproc import canonical_id, make_doc_id

    assert make_doc_id("yasa", "09/1976", "") == "yasa-9-1976"
    assert make_doc_id("yasa", "9/1976", "") == "yasa-9-1976"
    assert canonical_id("yasa-10-2000") == "yasa-10-2000"
    assert canonical_id("tuzuk-0-2020") == "tuzuk-0-2020"


def test_duplicates_found_by_text_not_title():
    from kktc.duplicates import find_duplicates

    body = " ".join(f"madde {i} bu yasa uyarınca av ruhsatı alan kişi yirmi bir yaşını doldurmuş olmalıdır ve sınavı geçmelidir {i}" for i in range(80))
    other = " ".join(f"madde {i} sözleşme yapma ehliyeti on sekiz yaşını dolduran kişilere aittir {i * 7}" for i in range(80))
    docs = [
        ("yasa-8-2009", "yasa", "8/2009 SAYILI AV VE AVLA İLGİLİ YABAN HAYATINI DÜZENLEME YASASI", "gov", body),
        ("yasa-18-2009", "yasa", "Av ve Avla İlgili Yaban Hayatını Düzenleme Yasası", "mahkemeler", body + " ek"),
        ("yasa-fasil-149", "yasa", "Sözleşmeler Yasası", "gov", other),
        ("tuzuk-av", "tuzuk", "Av Tüzüğü", "gov", body),
    ]
    found = find_duplicates(docs)
    assert set(found) == {"yasa-18-2009"}
    kept, sim = found["yasa-18-2009"]
    assert kept == "yasa-8-2009" and sim >= 0.9
