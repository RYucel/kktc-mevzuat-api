from __future__ import annotations

import re

from kktc.textproc import split_articles


def _articles(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for chunk in split_articles(text):
        if chunk.kind == "article":
            out.setdefault(re.sub(r" \(\d+/\d+\)$", "", chunk.ref), chunk.text)
    return out


# 16/2019 Araştırma, Geliştirme ve Tasarım Faaliyetlerinin Desteklenmesi Yasası
# as stored on 2026-11-09: article 9 sat inside article 8.
ARGE = """Kısa İsim 1. Bu Yasa, Araştırma Yasası olarak isimlendirilir.

Amaç 2. Bu Yasanın amacı araştırmayı desteklemektir.

Komisyon Toplantılarına İlişkin Kurallar

8. (1) Komisyon en az altı üyenin katılımı ile toplanır.
(2) Komisyon üyeleri başvuru yapamazlar.

ÜÇÜNCÜ KISIM

İndirim, İstisna, Destek ve Teşvikler

İndirim, İstisna, Destek ve Teşvikler 24/1982 11/1985 67/1987 16/1989 9.

(1) Teknoloji Geliştirme Bölgelerinde yapılacak indirimler uygulanır.

Ar-Ge Merkezleri 10. (1) Ar-Ge Merkezleri kurulur.
"""

# 17/2016 Trafik Dairesi Yasası: article 2 (Tefsir) sat inside article 1.
TRAFIK = """Kısa İsim 1. Bu Yasa, Trafik Dairesi Yasası olarak isimlendirilir.

BİRİNCİ KISIM
Genel Kurallar

Tefsir

.... 2. Bu Yasada metin başka türlü gerektirmedikçe; [50/2000; 9/2001]
“Araç”, karayolunda kullanılabilen taşıtları anlatır.

Amaç 3. Bu Yasanın amacı trafik hizmetlerini düzenlemektir.
"""


def test_article_behind_margin_notes_is_split() -> None:
    articles = _articles(ARGE)
    assert "Madde 9" in articles
    assert "Teknoloji Geliştirme" in articles["Madde 9"]
    assert "Teknoloji Geliştirme" not in articles["Madde 8"]
    assert "Madde 10" in articles


def test_article_behind_dots_is_split() -> None:
    articles = _articles(TRAFIK)
    assert "Madde 2" in articles
    assert "metin başka türlü" in articles["Madde 2"]
    assert "metin başka türlü" not in articles["Madde 1"]
    assert "Madde 3" in articles


def test_law_reference_inside_a_sentence_is_not_an_article() -> None:
    text = """Kısa İsim 1. Bu Yasa, Örnek Yasa olarak isimlendirilir.

Tefsir 2. Bu Yasada; “Yasa”, 24/1982 sayılı Gelir Vergisi Yasasını anlatır.
Bu kural, 11/1985 3. maddesi saklı kalmak koşuluyla uygulanır.

Amaç 3. Bu Yasanın amacı örnektir.
"""
    articles = _articles(text)
    assert articles["Madde 2"].count("11/1985") == 1
    assert articles["Madde 3"].startswith("Amaç 3.")
