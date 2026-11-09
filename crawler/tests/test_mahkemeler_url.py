from kktc.sources import _mahkemeler_abs


def test_random_cache_buster_is_dropped() -> None:
    a = _mahkemeler_abs("/altmahkeme/157-2012.docx?rnd=69996")
    b = _mahkemeler_abs("/altmahkeme/157-2012.docx?rnd=58739")
    assert a == b == "https://mevzuat.mahkemeler.net/altmahkeme/157-2012.docx"


def test_other_query_parameters_stay() -> None:
    assert _mahkemeler_abs("Dosya/Indir?id=5&rnd=1") == "https://mevzuat.mahkemeler.net/Dosya/Indir?id=5"
    assert _mahkemeler_abs("") == ""
    assert _mahkemeler_abs("/a/b.pdf") == "https://mevzuat.mahkemeler.net/a/b.pdf"
