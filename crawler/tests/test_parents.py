from kktc.parents import LawIndex, parent_law

LAWS = LawIndex(
    [
        ("yasa-fasil-113", "Şirketler Yasası"),
        ("yasa-28-1974", "Şirketler (Değişiklik) Yasası"),
        ("yasa-60-2000", "60/2000 SAYILI ATATÜRK ÖĞRETMEN AKADEMİSİ KURULUŞ YASASI"),
        ("yasa-fasil-352", "BÖLÜM 352 ÇOCUKLAR YASASI"),
        ("yasa-fasil-2", "Avukatlar Yasası"),
        ("yasa-47-1992", "Katma Değer Vergisi Yasası"),
    ]
)


def test_header_name_wins_over_first_number():
    head = "Sayı : 154 ŞİRKETLER YASASI (28/1974, 7/1977 Sayılı Yasalar) Bakanlar Kurulu, Şirketler Yasası'nın 93 maddesinin"
    assert parent_law(head, LAWS) == "yasa-fasil-113"


def test_number_in_prose():
    head = "Bakanlar Kurulu, 60/2000 s ayılı “Atatürk Öğretmen Akademisi Kuruluş Yasası’nın 6(2)(A) maddesi uyarınca"
    assert parent_law(head, LAWS) == "yasa-60-2000"


def test_fasil_and_consolidation_list_skipped():
    head = (
        "KORUYUCU AİLE TÜZÜĞÜ [(5.1.2007 – RG.2 – EK III- AE. 4 Sayılı Tüzüğün), (11.09.2019)] "
        "ÇOCUKLAR YASASI (Fasıl 352, 22/1959 Sayılı Yasalar) Madde 14 Altında Yapılan Tüzük"
    )
    assert parent_law(head, LAWS) == "yasa-fasil-352"


def test_name_only_header():
    head = "AVUKAT VE STAJYERLERİN KIYAFET TÜZÜĞÜ (15.6.2015 Sayılı Tüzük) AVUKATLAR YASASI 14 A Maddesi Uyarınca Yapılan Tüzük"
    assert parent_law(head, LAWS) == "yasa-fasil-2"


def test_unknown_parent():
    assert parent_law("Sayı : 850", LAWS) is None
