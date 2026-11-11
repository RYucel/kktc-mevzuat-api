from __future__ import annotations

from kktc.textproc import split_articles

# Daimi İkamet İzni Tüzüğü as stored on 9 Nov 2026: the application form after
# the last article became "Madde 15" ... "Madde 25".
DAIMI = """Kısa İsim 1. Bu Tüzük, Daimi İkamet İzni Tüzüğü olarak isimlendirilir.

Amaç 2. Bu Tüzüğün amacı izin başvurularında izlenecek usulü belirlemektir.

12. (1) Daire, iznin iptalini gerektiren koşulu ilgili kişiye tebliğ eder ve itiraz için bir ay süre verir.

Yürütme Yetkisi 13. Bu Tüzük, İçişleri ile görevli Bakanlık tarafından yürütülür.

Yürürlüğe Giriş 14. Bu Tüzük, Resmi Gazete’de yayımlandığı tarihten başlayarak yürürlüğe girer.

Ek – 1 (Madde 4) Çalışma İzni veya İş Kurma İzninden Dolayı Daimi İkamet İzni Başvuru Formu

15. İşverenin adı, soyadı: ........................................

16. İş Yerinin adı ve adresi: ........................................

17. Eşinin adı ve soyadı: ..............................................
"""

NO_HEADING_FORM = """Kısa İsim 1. Bu Tüzük, Örnek Tüzüğü olarak isimlendirilir.

Amaç 2. Bu Tüzüğün amacı örnektir.

Yürürlüğe Giriş 3. Bu Tüzük, Resmi Gazete’de yayımlandığı tarihten başlayarak yürürlüğe girer.

4. Başvuranın adı: ..............................................

5. Adresi: ..............................................
"""

LAW_WITH_LATER_ARTICLES = """Kısa İsim 1. Bu Yasa, Örnek Yasası olarak isimlendirilir.

Yürürlüğe Giriş 2. Bu Yasanın 5'inci maddesi 1 Ocak 2027 tarihinde yürürlüğe girer.

Kapsam 3. Bu Yasa, tüm kurumları kapsar ve kurumların bütçelerini düzenler.

Yetki 4. Bakanlık bu Yasa kurallarını uygular ve gerekli düzenlemeleri yapar.
"""


def _refs(text: str) -> list[str]:
    return [c.ref for c in split_articles(text)]


def test_annex_form_is_not_an_article() -> None:
    chunks = split_articles(DAIMI)
    refs = [c.ref for c in chunks]
    assert "Madde 14" in refs
    assert not any(r in refs for r in ("Madde 15", "Madde 16", "Madde 17"))
    annex = [c for c in chunks if c.kind == "annex"]
    assert annex and annex[0].ref == "Ek" and "İşverenin adı" in annex[0].text
    assert "İşverenin adı" not in next(c.text for c in chunks if c.ref == "Madde 14")


def test_form_fields_without_annex_heading() -> None:
    refs = _refs(NO_HEADING_FORM)
    assert "Madde 3" in refs and "Madde 4" not in refs and "Ek" in refs


def test_articles_after_an_entry_into_force_clause_are_kept() -> None:
    assert _refs(LAW_WITH_LATER_ARTICLES) == ["Madde 1", "Madde 2", "Madde 3", "Madde 4"]
