"""Statute cards: a readable name and a short subject summary per statute.

Built without a model from the statute's own text, for choosing the statute
before the article (OPUS-GOREVLER-3): the purpose/scope article, then the
article headings in order ("Deneme Süresi · Hizmet Akdinin Feshinde Bildirim
· Ücret Kesintisi ..."), which say what a statute regulates far better than
its title does.
"""

from __future__ import annotations

import re
from typing import Iterable, Optional

from .textproc import Chunk, fold_tr

# Stored long enough for big statutes (İş Yasası's working-time and leave
# headings come after its 40th article); the statute-choice step trims it.
CARD_CHARS = 1000
PURPOSE_CHARS = 160
# Headings every statute has; they say nothing about its subject.
_SKIP = re.compile(
    r"^(kisa isim|kisa ad|tefsir|yorum|amac|kapsam|amac ve kapsam|yurutme|yurutme yetkisi|yururluge giris|"
    r"yururlukten kaldirma|ozel kurallar|genel kurallar|baslangic)\b"
)
_HEADING = re.compile(r"^\s*(?P<h>[A-ZÇĞİÖŞÜ][^\n.:;]{2,80}?)\s+\d{1,4}[A-Z]?\s*[.(]")
_NUMBER_PREFIX = re.compile(r"^\s*(?:\d{1,4}\s*/\s*\d{4}\s+SAYILI|BÖLÜM\s+\d+|FASIL\s+\d+)\s+", re.I)


def display_title(title: str, number: Optional[str]) -> str:
    """'47/1992 SAYILI KATMA DEĞER VERGİSİ YASASI' -> 'Katma Değer Vergisi Yasası (47/1992)'."""
    name = _NUMBER_PREFIX.sub("", (title or "").strip())
    if name.isupper():
        words = []
        for i, word in enumerate(_tr_lower(name).split()):
            words.append(word if (i and word in {"ve", "ile", "veya"}) else _tr_upper(word[:1]) + word[1:])
        name = " ".join(words)
    number = (number or "").strip()
    if number and number not in name:
        label = number if "/" in number or number.lower().startswith("fasıl") else number
        return f"{name} ({label})"
    return name


def _tr_lower(text: str) -> str:
    return text.replace("I", "ı").replace("İ", "i").lower()


def _tr_upper(text: str) -> str:
    return text.replace("i", "İ").replace("ı", "I").upper()


def _heading(text: str) -> Optional[str]:
    match = _HEADING.match(text)
    if not match:
        return None
    heading = re.sub(r"\s+", " ", match.group("h")).strip(" -–")
    # Line-break hyphens: "Sorumlu-luğu", "Cumhu-riyetinde".
    heading = re.sub(r"(?<=[a-zçğıöşü])-\s*(?=[a-zçğıöşü])", "", heading)
    return heading if len(heading.split()) <= 10 else None


def statute_card(chunks: Iterable[Chunk]) -> str:
    """Purpose/scope text and the article headings, at most CARD_CHARS."""
    purpose = ""
    headings: list[str] = []
    seen: set[str] = set()
    first_sentences: list[str] = []
    for chunk in chunks:
        if chunk.kind != "article" or "(" in chunk.ref and not chunk.ref.endswith("(1/2)") and "(1/" not in chunk.ref:
            continue
        heading = _heading(chunk.text)
        folded = fold_tr(heading) if heading else ""
        if heading and re.match(r"^(amac|kapsam|amac ve kapsam)\b", folded) and not purpose:
            body = re.sub(r"^\s*" + re.escape(heading) + r"\s+\d{1,4}[A-Z]?\s*\.\s*", "", chunk.text)
            purpose = re.sub(r"\s+", " ", body).strip()[:PURPOSE_CHARS]
            continue
        if heading and not _SKIP.match(folded):
            if folded not in seen:
                seen.add(folded)
                headings.append(heading)
        elif not heading and len(first_sentences) < 6:
            sentence = re.sub(r"\s+", " ", chunk.text).strip()
            sentence = re.sub(r"^\d{1,4}[A-Z]?\s*\.\s*(\(\d+\)\s*)?", "", sentence)
            first_sentences.append(sentence.split(". ")[0][:80])
    parts: list[str] = []
    if purpose:
        parts.append(purpose.rstrip(".") + ".")
    if headings:
        parts.append(" · ".join(headings))
    elif first_sentences:
        parts.append(" · ".join(first_sentences))
    card = " ".join(parts)
    if len(card) > CARD_CHARS:
        cut = card.rfind(" · ", 0, CARD_CHARS)
        card = card[: cut if cut > CARD_CHARS // 2 else CARD_CHARS].rstrip() + " …"
    return card
