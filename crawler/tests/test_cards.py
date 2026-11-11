from __future__ import annotations

from kktc.cards import display_title, statute_card
from kktc.textproc import split_articles

LAW = """Kısa İsim 1. Bu Yasa, İş Yasası olarak isimlendirilir.

Tefsir 2. Bu Yasada metin başka türlü gerektirmedikçe; "işçi" ... anlatır.

Amaç 3. Bu Yasanın amacı, işverenler ile işçiler arasındaki çalışma ilişkilerini düzenlemektir.

Deneme Süresi 11. Hizmet akitlerinde, deneme süresi en çok üç aydır.

Hizmet Akdinin Feshinde Bildirim 12. Belirsiz süreli hizmet akdinin feshinden önce durumun diğer tarafa bildirilmesi gerekir.

Ücret Kesintisi 13. İşveren, işçiye ceza olarak ücret kesintisi yapamaz.

Yürürlüğe Giriş 14. Bu Yasa, Resmi Gazete'de yayımlandığı tarihten başlayarak yürürlüğe girer.
"""


def test_card_has_purpose_and_headings_but_no_boilerplate() -> None:
    card = statute_card(split_articles(LAW))
    assert card.startswith("Bu Yasanın amacı, işverenler ile işçiler")
    assert "Deneme Süresi · Hizmet Akdinin Feshinde Bildirim · Ücret Kesintisi" in card
    assert "Kısa İsim" not in card and "Tefsir" not in card and "Yürürlüğe" not in card


def test_card_is_capped() -> None:
    many = "\n\n".join(f"Başlık Numara {i} {i}. Metin {i}." for i in range(1, 120))
    card = statute_card(split_articles("Kısa İsim 1. Bu Yasa, X Yasası olarak isimlendirilir.\n\n" + many.replace("Başlık Numara 1 1.", "Konu Bir 2.")))
    assert len(card) <= 1002


def test_display_title() -> None:
    assert display_title("47/1992 SAYILI KATMA DEĞER VERGİSİ YASASI", "47/1992") == "Katma Değer Vergisi Yasası (47/1992)"
    assert display_title("İş Yasası", "22/1992") == "İş Yasası (22/1992)"
    assert display_title("BÖLÜM 154 CEZA YASASI", "Fasıl 154") == "Ceza Yasası (Fasıl 154)"


def test_line_break_hyphens_are_joined() -> None:
    card = statute_card(split_articles("Kısa İsim 1. Bu Yasa, X Yasası olarak isimlendirilir.\n\nİşçinin Sorumlu-luğu 2. İşçi sorumludur.\n\nBelirli Tür veya Kategorilerde-ki Hayvanlar 3. Metin."))
    assert "İşçinin Sorumluluğu" in card and "Kategorilerdeki" in card
