from __future__ import annotations

from kktc.textproc import (
    Chunk,
    clean_text,
    extract_number,
    extract_year,
    fold_tr,
    split_articles,
    split_paragraphs,
)

LAW = """Kuzey Kıbrıs Türk Cumhuriyeti Cumhuriyet Meclisi

İÇDÜZENİ

Kısa İsim 1. Bu Yasa, 2024 Yılı ...
Tefsir 2. Bu Yasa'da ...
Kapsam 3. ...
Yürütme 4. ...
Yürürlük 5. ...

Kuzey Kıbrıs Türk Cumhuriyeti Cumhuriyet Meclisi aşağıdaki Yasayı yapar:

Kısa İsim 1. Bu Yasa, 2024 Yılı Mali Yasa'sı olarak adlandırılır.

Tefsir 2. Bu Yasa'da "Bakanlık", Maliye Bakanlığını ifade eder.

Kapsam 3. Bu Yasa, kamu kurumlarının bütçelerini kapsar.

Yürütme 4. Bu Yasa'nın yürütülmesi Bakanlar Kuruluna aittir.

Yürürlük 5. Bu Yasa Resmî Gazete'de yayımlandığı tarihte yürürlüğe girer.
"""


def test_fold_preserves_length() -> None:
    text = clean_text(
        "Iıİi ŞşĞğÜüÖöÇç ÂâÎîÛû “tırnak” – tire — çizgi 12/2024"
    )
    folded = fold_tr(text)
    assert len(folded) == len(text)
    assert folded == "iiii ssgguuoocc aaiiuu \"tirnak\" - tire - cizgi 12/2024"


def test_clean_text_normalises_layout() -> None:
    raw = "\ufeff  Madde\u00a01.\r\n\r\n\r\n metin\u200b  "
    assert clean_text(raw) == "Madde 1.\n\nmetin"


def test_extract_number_and_year() -> None:
    assert extract_number("Aile (Değişiklik) Yasası 34/2015") == "34/2015"
    assert extract_number("Fasıl 57 Evlilik Yasası") == "Fasıl 57"
    assert extract_number("Anayasa") is None
    assert extract_year("Aile Yasası", "34/2015") == 2015
    assert extract_year("1962 tarihli karar", None) == 1962
    assert extract_year("Yargıtay Hukuk", "E.35/19085") is None
    assert extract_year("Telekomünikasyon Yasası", "20/81988") is None


def test_split_articles_removes_toc_and_keeps_body() -> None:
    chunks = split_articles(LAW)

    assert [c.ref for c in chunks] == [
        "Başlangıç",
        "Madde 1",
        "Madde 2",
        "Madde 3",
        "Madde 4",
        "Madde 5",
    ]
    articles = chunks[1:]
    assert all(c.kind == "article" for c in articles)
    assert articles[0].text.startswith("Kısa İsim 1. Bu Yasa, 2024 Yılı Mali")
    assert "İÇDÜZENİ" not in "".join(c.text for c in chunks)
    assert "Resmî Gazete" in articles[-1].text


def test_split_articles_does_not_attach_previous_article_body() -> None:
    chunks = split_articles(LAW)
    # TOC entry text must not leak into the following article.
    assert "Bu Yasa'da ..." not in "".join(c.text for c in chunks)


def test_split_articles_reads_madde_layout_and_suffix() -> None:
    text = """
MADDE 1. Amaç
Bu Yasa'nın amacı düzenlemektir.

MADDE 2. Kapsam
Bu Yasa tüm kurumları kapsar.

MADDE 2A. Ek madde
Ek hükümler uygulanır.

MADDE 3. Yürürlük
Bu Yasa yayımıyla yürürlüğe girer.
"""
    chunks = split_articles(clean_text(text))
    assert [c.ref for c in chunks] == ["Madde 1", "Madde 2", "Madde 2A", "Madde 3"]


def test_split_articles_strips_madde_dizini_index() -> None:
    text = """BÖLÜM 154 CEZA YASASI

MADDE DİZİNİ

1. KISIM GENEL KURALLAR
Birinci Bölüm Başlangıç
Madde 1 Kısa İsim
Madde 2 Korumalar
Madde 3 Yorum
Madde 4 Uygulama
Madde 5 Yürürlük

BÖLÜM 154 CEZA YASASI
1. KISIM GENEL KURALLAR

Kısa İsim 1. Bu Yasa Ceza Yasası olarak adlandırılır.

Korumalar 2. Bu Yasa aşağıdaki hususları etkilemez.

Yorum 3. Bu Yasa yasal yorum ilkeleri uyarınca yorumlanır.

Uygulama 4. Bu Yasa ülke içinde uygulanır.

Yürürlük 5. Bu Yasa yayımıyla yürürlüğe girer.
"""
    chunks = split_articles(text)
    assert [c.ref for c in chunks] == [
        "Madde 1",
        "Madde 2",
        "Madde 3",
        "Madde 4",
        "Madde 5",
    ]
    body = "".join(c.text for c in chunks)
    assert "MADDE DİZİNİ" not in body
    assert "Madde 1 Kısa İsim" not in body
    assert "Kısa İsim 1. Bu Yasa Ceza Yasası" in chunks[0].text


def test_split_articles_handles_bare_num_and_footnote_layouts() -> None:
    text = """Kısa İsim 1. Bu Yasa Ceza Yasası olarak adlandırılır.

Hayvanı Terk Etmek
9(2).17/2025 2. (1) Her kim bir hayvanı terk ederse suç işler.

Hayvanın Tutsak Edilmesi 9(2).17/2025 3. Yürürlükteki kurallar saklıdır.
"""
    chunks = split_articles(clean_text(text))
    assert [c.ref for c in chunks] == ["Madde 1", "Madde 2", "Madde 3"]
    assert chunks[1].text.startswith("Hayvanı Terk Etmek\n9(2).17/2025 2.")
    assert chunks[2].text.startswith("Hayvanın Tutsak Edilmesi 9(2).17/2025 3.")


def test_split_articles_handles_number_alone_on_its_line() -> None:
    text = """Birinci Madde
1.
Birinci maddenin metni.

İkinci Madde 2. İkinci maddenin metni.
"""
    chunks = split_articles(clean_text(text))
    assert [c.ref for c in chunks] == ["Madde 1", "Madde 2"]
    assert chunks[0].text.startswith("Birinci Madde\n1.")
    assert "İkinci maddenin metni" not in chunks[0].text


def test_split_articles_returns_empty_for_plain_prose() -> None:
    assert split_articles("Bu bir karar metnidir. Maddeler yoktur.") == []


def test_split_paragraphs_respects_limit() -> None:
    text = "\n\n".join("Paragraf " + "x" * 200 for _ in range(20))
    chunks = split_paragraphs(text, limit=500)
    assert len(chunks) > 1
    assert all(len(c.text) <= 500 for c in chunks)
    assert all(isinstance(c, Chunk) for c in chunks)


def test_split_paragraphs_keeps_articles_together() -> None:
    text = (
        "Birinci paragraf. " * 60
        + "\n\n"
        + "İkinci paragraf. " * 60
    )
    chunks = split_paragraphs(text, limit=1500)
    assert len(chunks) == 2
    assert chunks[0].text.startswith("Birinci")
    assert chunks[1].text.startswith("İkinci")
