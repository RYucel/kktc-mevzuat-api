"""The same statute held twice under different ids (OPUS-GOREVLER-5 item 2).

Title matching (``supersededCopies``) misses copies whose titles differ:
"8/2009 SAYILI AV VE AVLA ..." (gov) and "Av ve Avla ..." stored as
yasa-18-2009 (mahkemeler), or "Çocuk Suçluları Yasası" and "Suç İşleyen
Çocuklar Yasası". One of them then gets quoted, and the eval counts the
other one's identical article as wrong. A mahkemeler page can also carry
another statute's text under its own title (yasa-fasil-27 "Tarım Aletleri"
holds the text of yasa-fasil-24 "Tarım Ürünlerine Hile Katma").

Documents are compared by sampled word 5-grams of their text (one in 8
kept, chosen by hash, so the sample is the same for every document).
A pair is a duplicate when the samples overlap at least ``STRICT`` (short
texts) or ``LOOSE`` for two long texts, where boilerplate cannot explain it.
Short ratification laws share their whole frame ("Onay Yasası ...") and
reach 0.6-0.8; they stay below ``STRICT``.
"""
from __future__ import annotations

import re
import zlib
from collections import Counter, defaultdict
from typing import Iterable

SAMPLE = 8
MIN_SAMPLED = 8
STRICT = 0.9
LOOSE = 0.5
LONG = 120  # sampled shingles (~1000 shingles, a few pages of text)
MAX_DF = 12

_FOLD = str.maketrans("çğıöşüâîû", "cgiosuaiu")


def _words(text: str) -> list[str]:
    folded = text.replace("I", "ı").replace("İ", "i").lower().translate(_FOLD)
    return re.findall(r"[a-z0-9]+", folded)


def shingles(text: str) -> set[int]:
    w = _words(text)
    out: set[int] = set()
    for i in range(max(0, len(w) - 4)):
        h = zlib.crc32(" ".join(w[i : i + 5]).encode())
        if h % SAMPLE == 0:
            out.add(h)
    return out


def _title_overlap(title: str, text: str) -> float:
    """How much of the title is in the opening (the short-title article)."""
    words = {w for w in _words(title) if len(w) > 2 and not w.isdigit()} - {"yasasi", "yasa", "tuzugu", "tuzuk", "sayili", "fasil", "bolum", "ve", "ile"}
    if not words:
        return 0.0
    head = set(_words(text[:1500]))
    return len(words & head) / len(words)


def find_duplicates(docs: Iterable[tuple[str, str, str, str, str]]) -> dict[str, tuple[str, float]]:
    """(id, type, title, source, text) -> {duplicate id: (kept id, similarity)}.

    Only documents of the same type are compared. The kept copy is the
    mevzuat.gov.ct.tr one, else the one whose opening names its own title,
    else not a "-doc"/"-pdf" copy, else the longer text, else the smaller id.
    """
    info: dict[str, tuple[str, str, str, str]] = {}
    sets: dict[str, set[int]] = {}
    for doc_id, doc_type, title, source, text in docs:
        s = shingles(text or "")
        if len(s) < MIN_SAMPLED:
            continue
        sets[doc_id] = s
        info[doc_id] = (doc_type, title, source, text)
    index: dict[int, list[str]] = defaultdict(list)
    for doc_id, s in sets.items():
        for h in s:
            index[h].append(doc_id)
    shared: Counter[tuple[str, str]] = Counter()
    for ids in index.values():
        if 2 <= len(ids) <= MAX_DF:
            ids = sorted(ids)
            for i in range(len(ids)):
                for j in range(i + 1, len(ids)):
                    shared[(ids[i], ids[j])] += 1
    pairs = []
    for (a, b), n in shared.items():
        if info[a][0] != info[b][0]:
            continue
        la, lb = len(sets[a]), len(sets[b])
        sim = n / (la + lb - n)
        if sim >= STRICT or (sim >= LOOSE and min(la, lb) >= LONG):
            pairs.append((sim, a, b))

    def rank(doc_id: str) -> tuple:
        _, title, source, text = info[doc_id]
        # "-doc"/"-pdf" ids are second copies of a page (yasa-f-157-doc).
        variant = bool(re.search(r"-(doc|pdf)$|-f-\d", doc_id))
        return (source == "gov", round(_title_overlap(title, text), 1), not variant, len(text), [-ord(c) for c in doc_id])

    out: dict[str, tuple[str, float]] = {}
    for sim, a, b in sorted(pairs, reverse=True):
        keep, drop = (a, b) if rank(a) >= rank(b) else (b, a)
        while keep in out:  # chains: point to the final keeper
            keep = out[keep][0]
        if drop in out or drop == keep:
            continue
        out[drop] = (keep, round(sim, 2))
    return out
