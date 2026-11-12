"""Parent law of a regulation (OPUS-GOREVLER-4 item 8).

Regulations open with the law they are made under, in one of these forms:

    ŞİRKETLER YASASI (28/1974, 7/1977, ... Sayılı Yasalar) Bakanlar Kurulu,
    Şirketler Yasası'nın 93, 97 ... maddelerinin verdiği yetkiye dayanarak ...

    Bakanlar Kurulu, 60/2000 sayılı "Atatürk Öğretmen Akademisi Kuruluş
    Yasası'nın 6(2)(A) maddesi uyarınca ...

The law's name is matched against the titles of the laws we hold (the first
number in the header is often an amendment, e.g. Şirketler Yasası is Fasıl
113); a "n/yyyy sayılı" number is used when the name does not match.
"""
from __future__ import annotations

import re
from typing import Iterable, Optional

from .textproc import fold_tr

# "MAL VE HİZMETLER (DÜZENLEME VE DENETİM) YASASI (21/1977, ..." -> name, first number
_HEADER = re.compile(
    r"((?:[A-ZÇĞİÖŞÜÂÎÛ0-9][A-ZÇĞİÖŞÜÂÎÛ0-9'’\-.,]*\s+|\([A-ZÇĞİÖŞÜÂÎÛ ,\-]+\)\s+){1,14})YASASI\s*\(+\s*(?:FASIL\s*(\d+)|(\d{1,3})\s*/\s*((?:19|20)\d{2}))"
)
# "ÇOCUKLAR YASASI (Fasıl 352, ..." / "YABANCILAR VE MUHACERET YASASI Fasıl 105"
_FASIL = re.compile(r"YASASI\s*\(?\s*Fas[ıiIİ]l\s*(\d+)", re.I)
# "AVUKATLAR YASASI 14 A Maddesi Uyarınca": an upper-case law name alone
_NAME_ONLY = re.compile(r"((?:[A-ZÇĞİÖŞÜÂÎÛ][A-ZÇĞİÖŞÜÂÎÛ'’\-.,]*\s+|\([A-ZÇĞİÖŞÜÂÎÛ ,\-]+\)\s+){1,14})YASASI\b")
# "Şirketler Yasası'nın 93 ... maddesinin" / "Yasasının 4' üncü maddesinin"
_PROSE = re.compile(r"([A-ZÇĞİÖŞÜ][\wçğıöşüâîû()\- ,]{3,140}?\s+Yasası)\s*['’]?\s*n[ıi]n\b")
# "60/2000 sayılı"
_NUMBER = re.compile(r"(?<![\d/])(\d{1,3})\s*/\s*((?:19|20)\d{2})\s*s\s*ay[ıi]l[ıi]\b", re.I)


def _key(name: str) -> str:
    text = fold_tr(name)
    text = re.sub(r"\([^)]*\)", " ", text)
    text = re.sub(r"[^a-z\s]", " ", text)
    text = re.sub(r"\b\d+\b", " ", text)
    return re.sub(r"\s+", " ", text).strip()


class LawIndex:
    """Laws (type yasa) by normalized title and by id."""

    def __init__(self, laws: Iterable[tuple[str, str]]):
        self.ids: set[str] = set()
        self.by_key: dict[str, list[str]] = {}
        for doc_id, title in laws:
            self.ids.add(doc_id)
            # Amendment laws ("Şirketler (Değişiklik) Yasası") are never a parent.
            if "degisiklik" in fold_tr(title):
                continue
            key = _key(re.sub(r"^\s*\d{1,3}\s*/\s*\d{4}\s+say[ıi]l[ıi]\s+", "", title, flags=re.I))
            self.by_key.setdefault(key, []).append(doc_id)

    def by_name(self, name: str) -> Optional[str]:
        key = _key(name)
        # Strip leading words that are not part of the name ("Bakanlar Kurulu, ...").
        words = key.split()
        for start in range(len(words)):
            ids = self.by_key.get(" ".join(words[start:]))
            if ids:
                return ids[0] if len(ids) == 1 else sorted(ids, key=len)[0]
        return None

    def by_number(self, number: str, year: str) -> Optional[str]:
        doc_id = f"yasa-{int(number)}-{year}"
        return doc_id if doc_id in self.ids else None


def parent_law(head: str, index: LawIndex) -> Optional[str]:
    """The id of the law a regulation is made under, from its opening text."""
    text = re.sub(r"\s+", " ", head or "")
    # Skip the list of amending instruments ("[(5.2.2009 – R.G. 27 – ...)]").
    text = re.sub(r"\[\((?:[^\[\]]){0,3000}?\]", " ", text)[:1500]
    for match in _HEADER.finditer(text):
        name = match.group(1) + "YASASI"
        found = index.by_name(name)
        if found:
            return found
        if match.group(2):
            fasil = f"yasa-fasil-{match.group(2)}"
            if fasil in index.ids:
                return fasil
        elif match.group(3):
            found = index.by_number(match.group(3), match.group(4))
            if found:
                return found
    for match in _FASIL.finditer(text):
        fasil = f"yasa-fasil-{match.group(1)}"
        if fasil in index.ids:
            return fasil
    for match in _NAME_ONLY.finditer(text):
        found = index.by_name(match.group(1) + "YASASI")
        if found:
            return found
    for match in _PROSE.finditer(text):
        found = index.by_name(match.group(1))
        if found:
            return found
    for match in _NUMBER.finditer(text):
        found = index.by_number(match.group(1), match.group(2))
        if found:
            return found
    return None
