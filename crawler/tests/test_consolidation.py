from __future__ import annotations

from kktc.textproc import parse_consolidation

# Header of mevzuat.mahkemeler.net's Gelir Vergisi Yasası (24/1982), November 2026.
GELIR_VERGISI = """R.G. Sayı: 58 8 Temmuz 1982

Kıbrıs Türk Federe Meclisinin 28 Haziran 1982 tarihli birleşiminde kabul olunan "Gelir Vergisi Yasası", Anayasanın 74'üncü maddesi gereğince, Kıbrıs Türk Federe Devleti Başkanı tarafından Resmi Gazete'de yayımlanmak suretiyle ilan olunur.

24/1982

GELİR VERGİSİ YASASI

(11/1985; 67/1987; 16/1989; 20/1990; 22/1991; 14/1992; 20/1992; 69/1993; 21/1995; 1/1997; 4/1998; 16/1998; 3/1999; 14/2001, 41/2002, 58/2003, 73/2003; 13/2005; 34/2005; 56/2006 15/2007; 53/2007; 67/2007; 3/2010; 39/2010; 45/2010; 33/2011; 53/2011, 50/2014 , 14/2019,
34/2024 , 31/2025 ve 25/2026 sayılı Değişiklik Yasaları ile değiştirilmiş ve birleştirilmiş şekliyle)

MADDE DİZİNİ:

Madde 1. Kısa isim.
"""


def test_parses_amendment_list() -> None:
    info = parse_consolidation(GELIR_VERGISI)
    assert info is not None
    assert info["through"] == "25/2026"
    assert info["amendments"][0] == "11/1985"
    assert "56/2006" in info["amendments"] and "15/2007" in info["amendments"]
    # The law's own number (24/1982) is outside the parentheses.
    assert "24/1982" not in info["amendments"]
    assert info["count"] == 33


def test_unamended_text_has_no_consolidation() -> None:
    assert parse_consolidation("ATEŞLİ SİLAHLAR YASASI\n\nMadde 1. Kısa isim.") is None


def test_ascii_folded_header() -> None:
    text = "(12/2020 ve 3/2023 sayili Degisiklik Yasalari ile degistirilmis ve birlestirilmis sekliyle)"
    assert parse_consolidation(text)["through"] == "3/2023"


def test_other_header_wordings() -> None:
    avukatlar = "(42/1961, 20/1963, 9/1973 ve 60/2023 sayılı Yasalarla Değiştirilmiş ve Birleştirilmiş Şekli)"
    assert parse_consolidation(avukatlar)["through"] == "60/2023"
    bilgi = "Sayı: 12/2006 BİLGİ EDİNME HAKKI YASASI (27/2014 Sayılı Yasa ile Değiştirilmiş ve Birleştirilmiş Şekli.)"
    info = parse_consolidation(bilgi)
    assert info["amendments"] == ["27/2014"]
    koruma = "(31/1982 ve 14/1991 sayılı Yasalar İle Değiştirilmiş ve Birleştirilmiş Şekli)"
    assert parse_consolidation(koruma)["amendments"] == ["31/1982", "14/1991"]


def test_birlestirilmis_without_degistirilmis_and_regulation_dates() -> None:
    cevre = "ÇEVRE YASASI (30/2014, 34/2020 ve 8/2025 Sayılı Değişiklik Yasaları İle Birleştirilmiş Şekli)"
    assert parse_consolidation(cevre)["through"] == "8/2025"
    tuzuk = (
        "ADLİ ECZACILIK TÜZÜĞÜ [(22.04.1982 – R.G.30 – EK III – A.E. 161), "
        "(18.11.1987 – R.G.125 – EK III – A.E. 638) ve (30.09.1992 – R.G.96 – EK III – A.E.436) "
        "Sayılı Tüzükler ile Birleştirilmiş Şekli]"
    )
    info = parse_consolidation(tuzuk)
    assert info["through"] == "1992-09-30" and info["count"] == 3


def test_nested_parentheses_and_body_text_is_ignored() -> None:
    nested = (
        "ATATÜRK ÖĞRETMEN AKADEMİSİ ÖĞRETİM VE SINAV TÜZÜĞÜ (15.2.2002 – R.G. 17 – EK III – A.E. 85 "
        "Sayılı Tüzüğün, 22.7.2011 – R.G. 124 – EK III – A.E. 390) Sayılı Tüzükle Birleştirilmiş Şekli)"
    )
    assert parse_consolidation(nested)["through"] == "2011-07-22"
    body = "10. Puanlar (bu sayılı kurala göre) ortalama notlarla birleştirilerek sıralanır."
    assert parse_consolidation(body) is None


def test_every_amendment_before_the_anchor_is_counted() -> None:
    adli = (
        "[(4.04.1963 – R.G.241 – EK III – A.E.168 Sayılı Tüzük), (22.04.1982 – R.G.30 – EK III – A.E. 161), "
        "(18.11.1987 – R.G.125 – EK III – A.E. 638) ve (30.09.1992 – R.G.96 – EK III – A.E.436) "
        "Sayılı Tüzükler ile Birleştirilmiş Şekli] Fasıl 254"
    )
    info = parse_consolidation(adli)
    assert info["count"] == 4 and info["through"] == "1992-09-30"
