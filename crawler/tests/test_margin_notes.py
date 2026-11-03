from __future__ import annotations

import re
from pathlib import Path

from kktc.textproc import normalize_margin_notes, split_articles

# Gelir Vergisi Yasası (24/1982), consolidated through 25/2026, as served by the
# API on 2026-11-03 (text of mevzuat.mahkemeler.net's Word file).
GELIR_VERGISI = (Path(__file__).parent / "fixtures" / "gelir_vergisi_24_1982.txt").read_text(encoding="utf-8")


def _articles(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for chunk in split_articles(text):
        if chunk.kind == "article":
            out.setdefault(re.sub(r" \(\d+/\d+\)$", "", chunk.ref), chunk.text)
    return out


def test_gelir_vergisi_articles_are_split_despite_margin_notes() -> None:
    articles = _articles(GELIR_VERGISI)
    missing = [n for n in range(1, 67) if f"Madde {n}" not in articles]
    # Madde 14 sits behind a court-annulment note ("A.M. 4,5,6,7/2010 sayılı
    # kararla iptal edilmiştir. 14. (1) ..."); everything else must be found.
    assert missing == [14]
    assert articles["Madde 1"].startswith("Kısa İsim 1. Bu Yasa, Gelir Vergisi Yasası")
    # Not the "Geçici Madde 2." line left over from the index.
    assert articles["Madde 2"].startswith("Verginin konusu\n2. (1)")
    assert articles["Madde 6"].startswith("İstisnalar ve muaflıklar 6.")
    assert articles["Madde 8"].startswith("İndirilebilecek diğer giderler\n8. (1)")
    assert articles["Madde 33"].startswith("Vergi kesintisinde yükümlülük\n33. (1)")


def test_margin_notes_are_kept_behind_the_article() -> None:
    text = "İndirilebilecek diğer giderler\n5. 11/1985\n6(1), 41/2002\n3.(1) 13/2005 8. (1) (A) Eğitim giderleri."
    assert normalize_margin_notes(text) == (
        "İndirilebilecek diğer giderler\n8. (1) (A) Eğitim giderleri. [5. 11/1985; 6(1), 41/2002; 3.(1) 13/2005]"
    )
    effective = "Zararlar\n50/2014\nYürürlük tarihi: 1Ocak 2014 11. (1) Bu Yasanın kuralları."
    assert normalize_margin_notes(effective) == (
        "Zararlar\n11. (1) Bu Yasanın kuralları. [50/2014; Yürürlük tarihi: 1Ocak 2014]"
    )


def test_prose_citing_a_law_is_untouched() -> None:
    text = "11/1985 sayılı Yasa ile değiştirilen kurallar saklıdır."
    assert normalize_margin_notes(text) == text


def test_long_reference_lists_are_linear() -> None:
    # Catastrophic backtracking showed up on lists like this (gov texts).
    line = " ".join(f"{n}/19{80 + n % 20}" for n in range(1, 60)) + " 3 /1982"
    assert normalize_margin_notes(line + "\nMetin.") == "Metin. [" + re.sub(r"\s+", " ", line) + "]"
