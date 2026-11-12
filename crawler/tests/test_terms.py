from kktc.terms import accepted, term_key


def test_term_key_is_order_and_suffix_free():
    assert term_key("mahkeme kararı olmadan gözaltı") == term_key("gözaltı mahkeme kararları olmadan")
    assert term_key("ve ile için") == ""


def test_filters():
    texts = {("yasa-x", "Madde 1"): "Taammüden Katil 203. Kim ki önceden tasarlayarak ölümüne neden olursa"}
    rows = [
        {"term": "önceden planlayarak öldürme", "doc": "yasa-x", "ref": "Madde 1", "source": "claude", "status": "claude"},
        {"term": "hırsızlık kapkaç", "doc": "yasa-x", "ref": "Madde 1", "source": "model", "status": "claude"},
        {"term": "kasıt", "doc": "yasa-x", "ref": "Madde 1", "status": "avukat"},
        {"term": "taammüden katil", "doc": "yasa-x", "ref": "Madde 9", "status": "claude"},
        {"term": "katil", "doc": "yasa-x", "ref": "Madde 1", "status": "red"},
    ]
    kept, dropped = accepted(rows, texts)
    assert [r["term"] for r in kept] == ["önceden planlayarak öldürme"]
    assert dropped["no_overlap"] == 1 and dropped["short"] == 1 and dropped["unknown_article"] == 1 and dropped["red"] == 1
