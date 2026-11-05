"""Old chapters from mevzuat.mahkemeler.net: a bare numbered index, then
articles written without a space after the number ("1.Bu Yasa", "2.(1)")."""

from kktc.textproc import chunk_document

INDEX = "\n".join(
    f"{n}. Başlık numarası {n} ile ilgili kural" if n % 3 else f"{n}.\n\nBaşlık {n}" for n in range(1, 16)
)
BODY = (
    "Kısa isim. 1.Bu Yasa Örnek Sözleşmeler Yasası olarak isimlendirilir.\n\n"
    "Yorum 2.(1)Bu Yasada metin başka türlü gerektirmedikçe sözcükler olağan anlamlarını taşır ve "
    "yorum İngiliz hukukunun genel ilkelerine göre yapılır.\n(2) Bu kural sınırlı değildir.\n\n"
    + "\n\n".join(
        f"Kural {n}\n{n}.(1) Bu madde {n} numaralı kuralı düzenler ve taraflar arasında uygulanır; "
        "ayrıntıları burada uzun bir cümleyle anlatılır ki madde gövdesi gerçek bir madde gibi uzun olsun."
        for n in range(3, 16)
    )
    + "\n\n“Zorlama”nın tanımlanması\nBölüm 154. 16.(1) \"Zorlama\" herhangi bir kişinin bir anlaşma yapmasını sağlamak "
    "niyetiyle Ceza Yasası ile yasaklanmış bir fiilde bulunmayı anlatır."
)
LAW = "Örnek Sözleşmeler Yasası\n\nBAŞLANGIÇ KURALLARI\n\n" + INDEX + "\n\nI. KISIM\n\n" + BODY


def _articles(text: str) -> dict[str, str]:
    return {c.ref: c.text for c in chunk_document(text, "yasa") if c.kind == "article"}


def test_numbered_index_is_dropped_and_articles_found() -> None:
    arts = _articles(LAW)
    assert list(arts)[:3] == ["Madde 1", "Madde 2", "Madde 3"]
    assert arts["Madde 1"].startswith("Kısa isim. 1.Bu Yasa")
    assert "olağan anlamlarını" in arts["Madde 2"]
    # The index entries are gone, not glued to the articles.
    assert "Başlık numarası" not in " ".join(arts.values())
    # No article swallowed the rest of the law.
    assert max(len(t) for t in arts.values()) < 600


def test_article_after_margin_chapter_reference() -> None:
    arts = _articles(LAW)
    assert "Madde 16" in arts and arts["Madde 16"].lstrip().startswith(("“Zorlama”", "Bölüm 154. 16.", "16."))
    assert "Madde 154" not in arts


def test_abbreviation_after_number_is_not_an_article() -> None:
    text = (
        "Kısa İsim 1. Bu Tüzük Örnek Tüzük olarak isimlendirilir ve yürürlükteki kurallara göre uygulanır.\n\n"
        "Tefsir 2. Bu Tüzükte metin başka türlü gerektirmedikçe sözcükler olağan anlamlarındadır ve öyle yorumlanır.\n\n"
        "4.A.E. 541/24\n\nDönüş Şartları 3. Kat irtifakından kat mülkiyetine geçilirken ortak yerler tamamlanmış olmalıdır.\n"
    )
    arts = _articles(text)
    assert list(arts) == ["Madde 1", "Madde 2", "Madde 3"]
