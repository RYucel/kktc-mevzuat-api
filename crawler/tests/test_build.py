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
