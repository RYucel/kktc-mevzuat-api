"""Amendments a regulation's text does not include yet (OPUS-GOREVLER-4 item 11).

mahkemeler.net holds the amendment regulations ("Burs (Değişiklik) Tüzüğü")
as separate documents. A regulation's own text is consolidated up to a date
(its header) or, for a first-published copy, is the text of its own date. An
amendment dated after that may have changed the quoted article: the answer
says so, and names the articles the amendment touches when its text says
("Esas Tüzüğün 17'nci maddesi ... değiştirilir").

Laws are not covered: their amendment laws are not in the corpus.
"""
from __future__ import annotations

import re
from typing import Any, Iterable, Optional

from .textproc import fold_tr

# "Esas Tüzüğün 17'nci maddesi" (matched on the folded text: "esas tuzugun 17'nci maddesi")
_AMENDS_ARTICLE = re.compile(r"esas\s+tuzu[gk]un\s+(\d{1,3})\s*[a-z]?\s*['’]?\s*[a-z]{0,6}\s+madde")
_DATE_IN_TEXT = re.compile(r"\b(\d{1,2})\.(\d{1,2})\.((?:19|20)\d{2})\b")


def amendment_key(title: str) -> str:
    """'Burs (Değişiklik No.2) Tüzüğü' and 'Burs Tüzüğü' -> 'burs tuzugu'."""
    text = fold_tr(title or "")
    text = re.sub(r"\([^)]*degisiklik[^)]*\)", " ", text)
    text = re.sub(r"\bdegisiklik\b", " ", text)
    text = re.sub(r"\bno\s*[:.]?\s*\d+\b", " ", text)
    text = re.sub(r"\b(19|20)\d{2}\b", " ", text)
    text = re.sub(r"[^a-z\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def is_amendment(title: str) -> bool:
    return "degisiklik" in fold_tr(title or "")


def amended_articles(text: str) -> list[str]:
    """Article numbers of the base regulation an amendment changes, from its text."""
    found: list[str] = []
    for match in _AMENDS_ARTICLE.finditer(fold_tr(text or "")):
        if match.group(1) not in found:
            found.append(match.group(1))
    return found


def _cutoff(doc: dict[str, Any], date: Optional[str]) -> Optional[str]:
    """The date up to which a regulation's text is current (ISO), if known."""
    through = ((doc.get("extra") or {}).get("consolidation") or {}).get("through")
    if isinstance(through, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", through):
        return through
    return date


def later_amendments(
    docs: Iterable[tuple[str, dict[str, Any], Optional[str]]],
) -> dict[str, list[dict[str, Any]]]:
    """{regulation id: [{id, date, articles}]} for amendments dated after its text.

    `docs` are (id, document, ISO date or None) for every regulation.
    """
    items = list(docs)
    bases: dict[str, list[tuple[str, Optional[str]]]] = {}
    for doc_id, doc, date in items:
        if is_amendment(doc.get("title") or "") or not doc.get("content"):
            continue
        bases.setdefault(amendment_key(doc.get("title") or ""), []).append((doc_id, _cutoff(doc, date)))
    out: dict[str, list[dict[str, Any]]] = {}
    for doc_id, doc, date in items:
        if not is_amendment(doc.get("title") or "") or not date:
            continue
        for base_id, cutoff in bases.get(amendment_key(doc.get("title") or ""), []):
            if cutoff and date > cutoff:
                out.setdefault(base_id, []).append(
                    {"id": doc_id, "date": date, "articles": amended_articles(doc.get("content") or "")}
                )
    for base_id in out:
        out[base_id].sort(key=lambda a: a["date"])
    return out
