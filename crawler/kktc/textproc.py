"""Turkish text normalisation, PDF cleanup and article-aware chunking.

The search index uses a folded (ASCII-ish) copy of the text. Folding is
character-for-character so offsets in the folded text map 1:1 onto the
original text; the API uses that property to build clean Turkish snippets
without asking SQLite for them.
"""

from __future__ import annotations

import re
import statistics
import unicodedata
from dataclasses import dataclass, field
from typing import Iterable, Optional

# Single-character mappings only: length must be preserved.
_FOLD = str.maketrans(
    {
        "ı": "i",
        "İ": "i",
        "I": "i",
        "ş": "s",
        "Ş": "s",
        "ğ": "g",
        "Ğ": "g",
        "ü": "u",
        "Ü": "u",
        "ö": "o",
        "Ö": "o",
        "ç": "c",
        "Ç": "c",
        "â": "a",
        "Â": "a",
        "î": "i",
        "Î": "i",
        "û": "u",
        "Û": "u",
        "’": "'",
        "‘": "'",
        "“": '"',
        "”": '"',
        "–": "-",
        "—": "-",
        "\u00a0": " ",
        "\u2007": " ",
        "\u202f": " ",
    }
)

_WS_RE = re.compile(r"[ \t\f\v]+")
_MULTI_NEWLINE_RE = re.compile(r"\n{3,}")
_PAGE_NUMBER_RE = re.compile(r"^\s*(?:[-–—]\s*)?\d{1,4}(?:\s*[-–—])?\s*$")
_ARTICLE_RE = re.compile(
    r"(?m)^[ \t]*(?:MADDE|Madde)\s*[:.\-]?\s*(?P<num>\d{1,4})(?P<suf>[A-Z])?\s*[.\-–—:]?\s*(?P<rest>[^\n]*)$"
)
_TITLE_AFTER_ARTICLE_RE = re.compile(
    r"^[ \t]*(?:MADDE|Madde)\s+\d{1,4}[A-Z]?\s*[.\-:]?\s+\S"
)
_TOC_MARKER_RE = re.compile(
    r"(?mi)^[ \t]*(?:İÇDÜZENİ|İÇİNDEKİLER|İÇERİK|CONTENTS|MADDE[ \t]*D[İI]Z[İI]N[İI][ \t]*:?)[ \t]*$"
)
_TOC_ENTRY_RE = re.compile(r"(?m)^[ \t]*(?:MADDE|Madde)[ \t]+\d{1,4}[A-Z]?\b[^\n]*$")
# Word files of the old chapters omit the space after the article number
# ("Kısa isim. 1.Bu Yasa", "2.(1)Bu Yasa"); the patterns below accept that,
# but not abbreviations such as "4.A.E. 541/24" (margin note: article 4 of
# A.E. 541/2024).
_TITLE_NUM_RE = re.compile(
    r"(?m)^[ \t]*(?P<title>[“\"]?[A-ZÇĞİÖŞÜ][^\n]{1,80}?)[ \t]+(?P<num>\d{1,4})(?P<suf>[A-Z])?\.(?:[ \t]+|(?=[A-ZÇĞİÖŞÜ(])(?![A-ZÇĞİÖŞÜ]\.))(?P<rest>[^\n]*)$"
)
# Heading + number where the body starts on the next (possibly blank) line:
#   "Kısa İsim 1.\n\nBu Yasa ..."
_TITLE_BARE_NUM_RE = re.compile(
    r"(?m)^[ \t]*(?P<title>[A-ZÇĞİÖŞÜ][^\n]{1,80}?)[ \t]+(?P<num>\d{1,4})(?P<suf>[A-Z])?\.[ \t]*(?:\n[ \t]*)+(?=[A-ZÇĞİÖŞÜ(])"
)
# Heading printed with a full stop before the number ("Kısa isim. 1. ...").
_TITLE_PERIOD_NUM_RE = re.compile(
    r"(?m)^[ \t]*(?P<title>[“\"]?[A-ZÇĞİÖŞÜ][^\n.]{1,110}?)\.[ \t]+(?P<num>\d{1,4})(?P<suf>[A-Z])?\.(?:[ \t]+|(?![A-ZÇĞİÖŞÜ]\.))(?P<rest>[A-ZÇĞİÖŞÜ(][^\n]*)$"
)
# PDF extraction may join the heading to the previous sentence:
#   "... aşağıdaki Tüzüğü yapar: Kısa İsim 1. Bu Tüzük ..."
_JOINED_TITLE_NUM_RE = re.compile(
    r"(?m)(?:^|[.:;]\s+)(?P<title>[A-ZÇĞİÖŞÜ][^\n:;]{1,80}?)[ \t]+(?P<num>\d{1,4})(?P<suf>[A-Z])?\.(?:[ \t]+|(?![A-ZÇĞİÖŞÜ]\.))(?P<rest>[A-ZÇĞİÖŞÜ(][^\n]*)$"
)
# Amendment footnotes printed between an article heading and its number, e.g.
# "Hayvanın Tutsak Edilmesi 9(2).17/2025 383. ...".
_TITLE_FOOTNOTE_SUFFIX_RE = re.compile(
    r"[ \t]+(?:\d{1,3}\s*\(\d+\)\.\s*\d{1,4}\s*/\s*\d{4}|\d{1,3}\.\s*\d{1,4}\s*/\s*\d{4})[ \t]*$"
)
_NUM_RE = re.compile(
    r"(?m)^[ \t]*(?P<num>\d{1,4})(?P<suf>[A-Z])?\.(?:[ \t]+|(?![A-ZÇĞİÖŞÜ]\.))(?P<rest>[A-ZÇĞİÖŞÜ(][^\n]*)$"
)
# A footnote may sit on its own line between the heading and the number:
#   "Hayvanı Terk Etmek\n9(2).17/2025 385. (1) ..."
_FOOTNOTE_NUM_RE = re.compile(
    r"(?m)^[ \t]*\d{1,3}(?:\(\d+\))?\.\s*\d{1,4}\s*/\s*\d{4}[ \t]+"
    r"(?P<num>\d{1,4})(?P<suf>[A-Z])?\.[ \t]+(?P<rest>[A-ZÇĞİÖŞÜ(][^\n]*)$"
)
# Some PDFs put the number alone on its line, with the heading above and the
# body text below: "Yasaları Bilmemek\n7.\nYasaları bilmeme, ...".
_BARE_NUM_RE = re.compile(
    r"(?m)^[ \t]*(?P<num>\d{1,4})(?P<suf>[A-Z])?\.[ \t]*(?:\n[ \t]*)+(?=[A-ZÇĞİÖŞÜ(])"
)
# Margin notes (the laws an article cites or was amended by) printed on the
# article's own line, before its number; with or without a heading:
#   "İndirim, İstisna ... Teşvikler 24/1982 11/1985 ... 21/1995 9.\n\n(1) ..."
#   ".... 2. Bu Yasada metin başka türlü gerektirmedikçe; ..."
# These articles were merged into the previous one (16/2019 m.9 under m.8,
# 17/2016 m.2 under m.1), so their text was quoted with the wrong number.
_MARGIN_NUM_RE = re.compile(
    r"(?m)^[ \t]*(?P<title>[A-ZÇĞİÖŞÜ][^\n]{1,80}?[ \t]+)?"
    r"(?P<margin>(?:(?:\d{1,3}\s*/\s*\d{4}|Fasıl[ \t]+\d{1,3}|\.{2,})[;,]?[ \t]+)+)"
    r"(?P<num>\d{1,4})(?P<suf>[A-Z])?\."
    r"(?:[ \t]+(?P<rest>[A-ZÇĞİÖŞÜ(“\"][^\n]*)|[ \t]*(?:\n[ \t]*)+(?=[A-ZÇĞİÖŞÜ(“\"]))"
)
_AMENDMENT_REF_RE = re.compile(r"^\s*\d{1,3}\s*/\s*\d{4}\b")
_LAW_PREAMBLE_RE = re.compile(r"Kuzey Kıbrıs Türk Cumhuriyeti Cumhuriyet Meclisi", re.I)
_TITLE_SUFFIX_RE = re.compile(
    r"(?:^|[.:;]\s+)(?P<title>[A-ZÇĞİÖŞÜ][^.:;\n]{2,80})$"
)
_TITLE_FOOTNOTE_RE = re.compile(
    r"^(?P<title>[A-ZÇĞİÖŞÜ][^.\n]{2,80}?)[ \t]+\d{1,3}\.\s*\d{1,4}\s*/\s*\d{4}[ \t]*$"
)
_NOT_A_TITLE = {
    "Bu",
    "Ancak",
    "Ayrıca",
    "Her",
    "Böyle",
    "Buna",
    "Bunun",
    "Diğer",
    "Aynı",
    "İşbu",
    "Yukarıdaki",
    "Aşağıdaki",
    "Yukarıda",
    "Aşağıda",
}
_SECTION_RE = re.compile(
    r"(?m)^[ \t]*(?:(?:BİRİNCİ|İKİNCİ|ÜÇÜNCÜ|DÖRDÜNCÜ|BEŞİNCİ|ALTINCI|YEDİNCİ|SEKİZİNCİ|DOKUZUNCU|ONUNCU|ONBİRİNCİ|ONİKİNCİ|SON)\s+)?"
    r"(?:KISIM|BÖLÜM|FASIL|AYIRIM)\b[^\n]{0,120}$"
)
_LIST_RE = re.compile(r"^[ \t]*(?:[a-zçğıöşü]\)|\d+[\.\)]|[•\-–—])\s+")
_LIGATURES = {
    "\ufb00": "ff",
    "\ufb01": "fi",
    "\ufb02": "fl",
    "\ufb03": "ffi",
    "\ufb04": "ffl",
    "\ufb05": "st",
    "\ufb06": "st",
}


def fold_tr(text: str) -> str:
    """Fold Turkish text for case/diacritic-insensitive FTS matching.

    The returned string has exactly the same length as the input *after*
    :func:`clean_text`, which is what the snippet mapper relies on.
    """
    return text.translate(_FOLD).lower()


# Fractions such as "2/3" are split by the FTS5 tokenizer, so a query for
# "2/3" would otherwise become "2 AND 3" and match article numbers like 23.
# Index and query both use a single token (f2of3). The denominator whitelist
# keeps law numbers ("24/1982") and dates ("13/10/2026") untouched.
_FRACTION_RE = re.compile(r"(?<![\d/])(\d{1,2})\s*/\s*(\d{1,2})(?![\d/])")
_FRACTION_DENOMINATORS = {2, 3, 4, 5, 6, 8, 10, 12, 16, 20}


def fraction_token(match: re.Match[str]) -> str:
    numerator, denominator = int(match.group(1)), int(match.group(2))
    if 0 < numerator < denominator and denominator in _FRACTION_DENOMINATORS:
        return f"f{numerator}of{denominator}"
    return match.group(0)


def index_text(text: str) -> str:
    """Folded text for the FTS index, with searchable fraction tokens.

    The replacement is not length-preserving, so this is only for
    ``chunks_fts.text_norm``; the original ``chunks.text`` is kept for display
    and snippet offsets.
    """
    return _FRACTION_RE.sub(fraction_token, fold_tr(text))


def clean_text(text: str) -> str:
    """Normalise a plain-text document without destroying its layout."""
    if not text:
        return ""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    for lig, repl in _LIGATURES.items():
        text = text.replace(lig, repl)
    text = unicodedata.normalize("NFKC", text)
    text = text.replace("\ufeff", "").replace("\u200b", "").replace("\u200c", "").replace("\u200d", "")
    lines = []
    for line in text.split("\n"):
        line = _WS_RE.sub(" ", line).strip()
        lines.append(line)
    text = "\n".join(lines)
    text = _MULTI_NEWLINE_RE.sub("\n\n", text)
    return text.strip()


def _looks_like_heading(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    if _ARTICLE_RE.match(stripped) or _SECTION_RE.match(stripped):
        return True
    if _LIST_RE.match(stripped):
        return True
    # Short all-caps lines are almost always headings in KKTC legislation.
    letters = [ch for ch in stripped if ch.isalpha()]
    if 2 <= len(letters) <= 90 and stripped.upper() == stripped and len(stripped) < 110:
        return True
    return False


def _join_lines(lines: Iterable[str]) -> str:
    """Join hard-wrapped PDF lines into paragraphs."""
    paragraphs: list[list[str]] = []
    current: list[str] = []

    def flush() -> None:
        if current:
            paragraphs.append(current[:])
            current.clear()

    for raw in lines:
        line = raw.strip()
        if not line:
            flush()
            continue
        if _PAGE_NUMBER_RE.match(line):
            continue
        if _looks_like_heading(line):
            flush()
            paragraphs.append([line])
            continue
        if current:
            prev = current[-1]
            # De-hyphenate line breaks: "nafaka-\nlar" -> "nafakalar"
            if prev.endswith("-") and len(prev) > 1 and line[:1].islower():
                current[-1] = prev[:-1] + line
                continue
            # A sentence ending on the previous line usually ends a paragraph.
            if prev.endswith((".", ":", ";")) and len(prev) > 55 and line[:1].isupper():
                flush()
        current.append(line)
    flush()

    out = []
    for parts in paragraphs:
        if not parts:
            continue
        if len(parts) == 1:
            out.append(parts[0])
        else:
            first = parts[0]
            rest = " ".join(parts[1:])
            if first.endswith("-") and rest[:1].islower():
                out.append(first[:-1] + rest)
            else:
                out.append(f"{first} {rest}")
    return "\n\n".join(out)


def clean_pdf_pages(pages: list[str]) -> str:
    """Turn raw per-page PDF text into clean, reflowed paragraphs."""
    page_lines: list[list[str]] = []
    for page in pages:
        for lig, repl in _LIGATURES.items():
            page = page.replace(lig, repl)
        page = unicodedata.normalize("NFKC", page)
        page_lines.append([line.rstrip() for line in page.replace("\r", "").split("\n")])

    repeated: set[str] = set()
    if len(page_lines) >= 4:
        counts: dict[str, int] = {}
        for lines in page_lines:
            margin = [ln for ln in (lines[:2] + lines[-2:]) if ln.strip()]
            seen = {re.sub(r"\d+", "#", ln.strip().lower()) for ln in margin}
            for key in seen:
                if len(key) > 4:
                    counts[key] = counts.get(key, 0) + 1
        threshold = max(3, int(len(page_lines) * 0.35))
        repeated = {key for key, count in counts.items() if count >= threshold}

    cleaned: list[str] = []
    for lines in page_lines:
        for line in lines:
            key = re.sub(r"\d+", "#", line.strip().lower())
            if key in repeated and len(line.strip()) < 120:
                continue
            cleaned.append(line)
        cleaned.append("")

    return clean_text(_join_lines(cleaned))


@dataclass
class Chunk:
    kind: str
    ref: str
    text: str


def _split_long(text: str, limit: int = 2400) -> list[str]:
    if len(text) <= limit:
        return [text]
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    parts: list[str] = []
    buf: list[str] = []
    size = 0
    for para in paragraphs:
        if size + len(para) + 2 > limit and buf:
            parts.append("\n\n".join(buf))
            buf, size = [], 0
        if len(para) > limit:
            # Hard split on sentence boundaries, then on spaces.
            sentences = re.split(r"(?<=[.!?])\s+", para)
            for sentence in sentences:
                while len(sentence) > limit:
                    cut = sentence.rfind(" ", 0, limit)
                    cut = cut if cut > limit // 2 else limit
                    if buf:
                        parts.append("\n\n".join(buf))
                        buf, size = [], 0
                    parts.append(sentence[:cut].strip())
                    sentence = sentence[cut:].strip()
                if sentence:
                    if size + len(sentence) + 1 > limit and buf:
                        parts.append("\n\n".join(buf))
                        buf, size = [], 0
                    buf.append(sentence)
                    size += len(sentence) + 1
            continue
        buf.append(para)
        size += len(para) + 2
    if buf:
        parts.append("\n\n".join(buf))
    return [p for p in parts if p.strip()]


def _suffix_rank(suffix: str) -> int:
    return (ord(suffix) - 64) if suffix else 0


_OPENING_QUOTES = "“\"'‘«"


def _looks_like_title(line: str, max_words: int = 9) -> bool:
    """True for short heading lines such as "Kısa İsim" or "TEFSİR".

    Headings of the old chapters may open with a quoted term
    ("“Zorlama”nın tanımlanması").
    """
    line = line.strip()
    if not line or len(line) > 90:
        return False
    if line[-1] in ".:;,)" or line[0] in "([":
        return False
    first = line.lstrip(_OPENING_QUOTES)
    if not first or not first[0].isupper():
        return False
    if first != line:
        # A quoted heading names and defines a term ("“Zorlama”nın
        # tanımlanması"); a bare quoted term ("“Meclis”") is a definition-list
        # entry, not a heading.
        close = max(line.rfind("”"), line.rfind('"'), line.rfind("’"))
        if close <= 0 or not re.search(r"[A-Za-zÇĞİÖŞÜçğıöşü]{3,}", line[close + 1 :]):
            return False
    words = line.split()
    if len(words) > max_words:
        return False
    if any(ch.isdigit() for ch in line):
        return False
    return True


# Consolidated Word files from mevzuat.mahkemeler.net print margin notes
# (which law amended the article) into the text flow:
#   "41/2002 2. (1) Kuzey Kıbrıs ..."      law number before the article number
#   "5. 11/1985\n6(1), 41/2002\n3.(1) 13/2005 8. (1) ..."   "article N of law X"
#   "41/1976\n24/1977\n62/1977"          lists of earlier laws
# They look like article numbers to the splitter. normalize_margin_notes()
# moves them into brackets at the end of the line, keeping the information:
#   "8. (1) ... [5. 11/1985; 6(1), 41/2002; 3.(1) 13/2005]"
# One margin reference: "41/2002", "2. 20/1992", "6(1), 41/2002", "3.(1) 13/2005",
# "2.3/1999", "9(2).17/2025". The optional "article" prefix must end in "." or
# "," so a run of references can be read only one way; references are consumed
# one at a time (no backtracking blow-up on long lists such as
# "7/1979 3 /1982 12/1982 ...").
_MARGIN_REF_RE = re.compile(
    r"[ \t]*(?:\d{1,3}(?:\s*\(\d{1,2}\))?\s*[.,]\s*(?:\(\d{1,2}\)\s*)?)?\d{1,3}\s*/\s*(?:19|20)\d{2}(?!\d)[ \t]*[,;]?"
)
_CITING_PROSE_RE = re.compile(r"(?:sayılı|sayili|Sayılı|SAYILI|ve|ile|tarihli|nolu|numaralı)\b")


def _leading_margin_refs(line: str) -> int:
    """Length of the run of margin references at the start of ``line``."""
    pos = 0
    while True:
        match = _MARGIN_REF_RE.match(line, pos)
        if not match or match.end() == pos:
            return pos
        pos = match.end()


# Old chapters print other chapters and two-digit-year laws as margin notes
# before the article number: "Bölüm 154. 15.(1) ...", "2, 7/56 11. (1) ...".
_OLD_MARGIN_PREFIX_RE = re.compile(
    r"^[ \t]*(?P<note>Bölüm[ \t]+\d{1,3}\.|(?:\d{1,3}[ \t]*[.,][ \t]*)?\d{1,3}[ \t]*/[ \t]*\d{2}(?!\d))[ \t]+(?=\d{1,4}[A-Z]?\.)"
)
_OLD_MARGIN_LINE_RE = re.compile(r"^[ \t]*Bölüm[ \t]+\d{1,3}\.[ \t]*$")
_EFFECTIVE_LINE_RE = re.compile(r"^[ \t]*Yürürlük\s+tarihi\s*:[^\n]{1,40}$")
_EFFECTIVE_NOTE_RE = re.compile(r"^(?P<note>Yürürlük\s+tarihi\s*:[^\n]{1,40}?)[ \t]+(?=\d{1,4}[A-Z]?\.[ \t])")
_LEADING_ARTICLE_NUM_RE = re.compile(r"^(?P<num>\d{1,4}[A-Z]?\.)[ \t]+(?P<rest>\S.*)$")
# A heading wrapped onto two lines: "İstisnalar ve\nmuaflıklar 6. Aşağıda ...",
# or with a full stop after the heading: "Onaylanmış\nliman. 3. Bakanlar ...".
_WRAPPED_TITLE_TAIL_RE = re.compile(r"^[a-zçğıöşü][^\n]{0,70}?\.?[ \t]+\d{1,4}[A-Z]?\.(?:[ \t]+|(?=[A-ZÇĞİÖŞÜ(]))\S")
_TRANSITIONAL_RE = re.compile(r"[ \t]*(?:Geçici|GEÇİCİ|Gecici|GECICI|Ek|EK)\s+(?:Madde|MADDE)\b")


def normalize_margin_notes(text: str) -> str:
    """Move inlined amendment margin notes out of the article-number position."""
    out: list[str] = []
    pending: list[str] = []

    def flush() -> None:
        if pending:
            out.append("[" + "; ".join(pending) + "]")
            pending.clear()

    for line in text.split("\n"):
        if _OLD_MARGIN_LINE_RE.match(line):
            pending.append(line.strip())
            continue
        old = _OLD_MARGIN_PREFIX_RE.match(line)
        if old:
            pending.append(old.group("note"))
            line = line[old.end():]
        run = _leading_margin_refs(line)
        if run and not line[run:].strip():
            pending.append(re.sub(r"\s+", " ", line.strip().rstrip(",;")))
            continue
        if pending and _EFFECTIVE_LINE_RE.match(line):
            pending.append(line.strip())
            continue
        if not line.strip():
            # Keep collecting: notes often sit between a heading and its
            # article with a blank line in between; flushing them here put a
            # "[...]" line between the two and the heading was lost.
            out.append(line)
            continue
        notes = list(pending)
        pending.clear()
        indent = ""
        body = line
        if run and line[run - 1 : run] in (" ", "\t", ",", ";") and not _CITING_PROSE_RE.match(line[run:].lstrip()):
            indent = line[: len(line) - len(line.lstrip())]
            notes.append(re.sub(r"\s+", " ", line[:run].strip().rstrip(",;")))
            body = line[run:].lstrip()
        effective = _EFFECTIVE_NOTE_RE.match(body)
        if effective:
            notes.append(effective.group("note").strip())
            body = body[effective.end():]
        if notes:
            article = _LEADING_ARTICLE_NUM_RE.match(body)
            joined = "; ".join(notes)
            # Notes go to the end of the line: the splitter expects the text
            # after "N." to start like a sentence or "(1)".
            line = (
                f"{indent}{article.group('num')} {article.group('rest')} [{joined}]"
                if article
                else f"{indent}{body} [{joined}]"
            )
        if (
            out
            and _WRAPPED_TITLE_TAIL_RE.match(line)
            and out[-1].strip().lstrip(_OPENING_QUOTES)
            and len(out[-1].strip()) <= 50
            and out[-1].strip().lstrip(_OPENING_QUOTES)[0].isupper()
            and out[-1].rstrip()[-1] not in ".:;,)"
        ):
            out[-1] = out[-1].rstrip() + " " + line.lstrip()
            continue
        out.append(line)
    flush()
    return "\n".join(out)


def _article_candidates(text: str) -> list[dict]:
    """Collect possible article starts from the three layouts seen in KKTC law PDFs.

    Layouts:
      * ``MADDE 12. ...`` / ``Madde 12. ...``
      * ``Kısa İsim 1. Bu Yasa ...`` (title before the number)
      * ``6. (1) ...`` (bare number, title on the preceding line)
    """
    found: dict[int, dict] = {}

    def add(pos: int, num: int, suf: str, title: str, priority: int) -> None:
        # "Geçici Madde 2." / "Ek Madde 1." have their own numbering; taking
        # them as main articles derails the sequence (and the TOC detection).
        if _TRANSITIONAL_RE.match(text, pos) or _TRANSITIONAL_RE.match(title):
            return
        current = found.get(pos)
        if current is None or priority < current["priority"]:
            found[pos] = {"pos": pos, "num": num, "suf": suf, "title": title, "priority": priority}

    for m in _ARTICLE_RE.finditer(text):
        rest = (m.group("rest") or "").strip()
        if _AMENDMENT_REF_RE.match(rest):
            continue
        # TOC entries are followed by another short entry; body lines carry text.
        add(m.start(), int(m.group("num")), m.group("suf") or "", "", 0)

    for m in _TITLE_NUM_RE.finditer(text):
        rest = (m.group("rest") or "").strip()
        title = _TITLE_FOOTNOTE_SUFFIX_RE.sub("", m.group("title").strip()).strip()
        if _AMENDMENT_REF_RE.match(rest):
            continue
        if not _looks_like_title(title):
            continue
        add(m.start(), int(m.group("num")), m.group("suf") or "", title, 1)

    for m in _TITLE_BARE_NUM_RE.finditer(text):
        title = _TITLE_FOOTNOTE_SUFFIX_RE.sub("", m.group("title").strip()).strip()
        if not _looks_like_title(title):
            continue
        add(m.start(), int(m.group("num")), m.group("suf") or "", title, 1)

    for m in _TITLE_PERIOD_NUM_RE.finditer(text):
        rest = (m.group("rest") or "").strip()
        title = m.group("title").strip()
        # "Title. N." headings of the old chapters run longer ("İvazları ve
        # amaçları kısmen yasa dışı olan anlaşmaların geçersiz olması. 24.").
        if _AMENDMENT_REF_RE.match(rest) or not _looks_like_title(title, max_words=14):
            continue
        add(m.start(), int(m.group("num")), m.group("suf") or "", title, 1)

    for m in _JOINED_TITLE_NUM_RE.finditer(text):
        rest = (m.group("rest") or "").strip()
        title = m.group("title").strip()
        if _AMENDMENT_REF_RE.match(rest) or not _looks_like_title(title):
            continue
        add(m.start("title"), int(m.group("num")), m.group("suf") or "", title, 1)

    for m in _NUM_RE.finditer(text):
        rest = (m.group("rest") or "").strip()
        if _AMENDMENT_REF_RE.match(rest):
            continue
        line_start = m.start()
        title = ""
        # A heading printed on its own line right before the number belongs to
        # this article, not to the end of the previous one.
        before = text[:line_start].rstrip("\n")
        prev_start = before.rfind("\n") + 1
        prev_line = before[prev_start:]
        if _looks_like_title(prev_line) and len(prev_line.split()) <= 7:
            title = prev_line
            line_start = prev_start + before[prev_start:].find(prev_line)
        elif _TITLE_FOOTNOTE_RE.match(prev_line):
            title = _TITLE_FOOTNOTE_RE.match(prev_line).group("title").strip()
            line_start = prev_start + before[prev_start:].find(title)
        else:
            # PDF extraction sometimes joins the heading to the previous
            # paragraph: "... geçerli olmaz. Evlenme Sözünü Tutmamak".
            suffix = _TITLE_SUFFIX_RE.search(prev_line)
            if suffix:
                candidate = suffix.group("title").strip()
                if (
                    _looks_like_title(candidate)
                    and len(candidate.split()) <= 7
                    and candidate.split()[0] not in _NOT_A_TITLE
                ):
                    title = candidate
                    line_start = prev_start + prev_line.find(candidate)
        add(line_start, int(m.group("num")), m.group("suf") or "", title, 2)

    for m in _FOOTNOTE_NUM_RE.finditer(text):
        rest = (m.group("rest") or "").strip()
        if _AMENDMENT_REF_RE.match(rest):
            continue
        line_start = m.start()
        title = ""
        before = text[:line_start].rstrip("\n")
        prev_start = before.rfind("\n") + 1
        prev_line = before[prev_start:]
        if _looks_like_title(prev_line) and len(prev_line.split()) <= 7:
            title = prev_line
            line_start = prev_start
        add(line_start, int(m.group("num")), m.group("suf") or "", title, 2)

    for m in _MARGIN_NUM_RE.finditer(text):
        title = (m.group("title") or "").strip()
        if title and not _looks_like_title(title):
            title = ""
        add(m.start() if title else m.start("margin"), int(m.group("num")), m.group("suf") or "", title, 2)

    for m in _BARE_NUM_RE.finditer(text):
        line_start = m.start()
        title = ""
        before = text[:line_start].rstrip("\n")
        prev_start = before.rfind("\n") + 1
        prev_line = before[prev_start:]
        if _looks_like_title(prev_line) and len(prev_line.split()) <= 7:
            title = prev_line
            line_start = prev_start
        add(line_start, int(m.group("num")), m.group("suf") or "", title, 2)

    return sorted(found.values(), key=lambda c: c["pos"])


def _select_article_sequence(candidates: list[dict]) -> list[dict]:
    """Keep the monotonically increasing article starts and drop TOC noise."""
    accepted: list[dict] = []
    last_num = 0
    last_suffix = 0
    for cand in candidates:
        num, suffix = cand["num"], _suffix_rank(cand["suf"])
        if not accepted:
            if 1 <= num <= 3:
                accepted.append(cand)
                last_num, last_suffix = num, suffix
            continue
        if num == last_num:
            if suffix > last_suffix:
                accepted.append(cand)
                last_suffix = suffix
            continue
        # Consolidated laws skip numbers for repealed articles, so allow small
        # gaps (observed up to six in the consolidated Criminal Code).
        if last_num < num <= last_num + 10:
            accepted.append(cand)
            last_num, last_suffix = num, suffix
    return accepted


def _find_restart(text: str) -> Optional[int]:
    """Return the offset where the article numbering restarts (end of the TOC)."""
    candidates = _article_candidates(text)
    peak = 0
    for idx, cand in enumerate(candidates):
        if cand["num"] == 1 and peak >= 3:
            # TOC entries ("Geçici Madde 1. ...") sit right next to each other;
            # a real first article is followed by a substantial body.
            nxt = candidates[idx + 1]["pos"] if idx + 1 < len(candidates) else len(text)
            if nxt - cand["pos"] >= 200:
                return cand["pos"]
        peak = max(peak, cand["num"])
    return None


def _toc_entry_end(text: str, start: int) -> Optional[int]:
    """End of a dense ``Madde N Başlık`` index block, if there is one.

    Consolidated laws often start with a "MADDE DİZİNİ" whose entries use a
    different layout from the body ("Madde 1 Kısa İsim" vs "Kısa İsim 1.").
    The index is a dense run of lines, so the last entry of the largest run
    marks where the body begins.
    """
    entries = [
        m
        for m in _TOC_ENTRY_RE.finditer(text, start)
        if m.end() - m.start() <= 180
    ]
    if len(entries) < 5:
        return None

    clusters: list[list[re.Match[str]]] = []
    current = [entries[0]]
    for match in entries[1:]:
        prev = current[-1]
        prev_num = int(re.search(r"\d{1,4}", prev.group(0)).group(0))
        num = int(re.search(r"\d{1,4}", match.group(0)).group(0))
        restarts = num + 2 < prev_num and prev_num > 10
        if not restarts and match.start() - prev.end() <= 300:
            current.append(match)
        else:
            clusters.append(current)
            current = [match]
    clusters.append(current)

    best = max(clusters, key=len)
    if len(best) < 5 or best[0].start() > len(text) * 0.35:
        return None
    return best[-1].end()


def _strip_toc(text: str) -> str:
    """Remove the "İÇDÜZENİ" table of contents that precedes consolidated laws."""
    marker = _TOC_MARKER_RE.search(text)
    if not marker:
        return text
    region_start = marker.end()

    body_start = _toc_entry_end(text, region_start)
    if body_start is None:
        # Consolidated PDFs put the enactment formula ("Kuzey Kıbrıs Türk
        # Cumhuriyeti Cumhuriyet Meclisi ...") after the table of contents.
        preamble = _LAW_PREAMBLE_RE.search(text, region_start)
        if preamble is not None:
            for cand in _article_candidates(text[preamble.end():]):
                body_start = cand["pos"] + preamble.end()
                break
    if body_start is None:
        restart = _find_restart(text[region_start:])
        if restart is not None:
            body_start = restart + region_start
    if body_start is None:
        # TOC uses "Madde N. Title" while the body may use another layout
        # ("Kısa İsim 1. ...", "6. (1) ...").
        for cand in _article_candidates(text[region_start:]):
            if cand["priority"] >= 1:
                body_start = cand["pos"] + region_start
                break
        if body_start is None:
            for cand in _article_candidates(text[region_start:]):
                body_start = cand["pos"] + region_start
                break
        if body_start is None:
            return text

    removed = text[region_start:body_start]
    preamble = _LAW_PREAMBLE_RE.search(removed)
    if preamble is not None:
        line_start = removed.rfind("\n", 0, preamble.start()) + 1
        return text[:marker.start()] + "\n" + removed[line_start:].strip() + "\n\n" + text[body_start:]
    return text[:marker.start()] + "\n" + text[body_start:]


def _strip_toc_run(text: str) -> str:
    """Remove a table of contents that has no "İÇDÜZENİ" heading.

    TOC entries are ``Madde 12. Kısa Başlık`` lines packed closely together.
    Body articles are separated by paragraphs, so a run of at least five
    consecutive article headings within 400 characters is a TOC.
    """
    entries: list[tuple[int, int, int]] = []
    for match in _ARTICLE_RE.finditer(text):
        line_end = text.find("\n", match.start())
        if line_end < 0:
            line_end = len(text)
        line = text[match.start():line_end]
        if len(line) > 180 or not _TITLE_AFTER_ARTICLE_RE.match(line):
            continue
        entries.append((match.start(), line_end, int(match.group("num"))))

    best: list[tuple[int, int, int]] = []
    run: list[tuple[int, int, int]] = []
    for entry in entries:
        if run and entry[2] == run[-1][2] + 1 and entry[0] - run[-1][1] < 400:
            run.append(entry)
        else:
            if len(run) > len(best):
                best = run
            run = [entry]
    if len(run) > len(best):
        best = run
    if len(best) < 5 or best[0][0] > len(text) * 0.25:
        return text

    removed_start = best[0][0]
    # A TOC often starts with a bare-number entry ("1. Kısa İsim") before the
    # first "Madde 2." line; include it so it does not become article 1.
    window_start = max(0, removed_start - 300)
    window = text[window_start:removed_start]
    prior = list(
        re.finditer(r"(?m)^[ \t]*\d{1,4}\.\s+[A-ZÇĞİÖŞÜ][^\n]{0,80}$", window)
    )
    if prior:
        removed_start = window_start + prior[-1].start()
    tail_start = best[-1][1]
    candidates = _article_candidates(text[tail_start:])
    if not candidates:
        return text
    body_start = candidates[0]["pos"] + tail_start
    removed = text[removed_start:body_start]
    preamble = _LAW_PREAMBLE_RE.search(removed)
    if preamble is not None:
        line_start = removed.rfind("\n", 0, preamble.start()) + 1
        return text[:removed_start] + removed[line_start:].strip() + "\n\n" + text[body_start:]
    return text[:removed_start] + "\n" + text[body_start:]


def _strip_numbered_toc(text: str) -> str:
    """Remove a table of contents written as bare numbered headings.

    mevzuat.mahkemeler.net Word files of the old Cyprus chapters (Sözleşmeler,
    Şirketler, Hukuk Muhakemeleri Usulü, Haksız Fiiller, ...) open with an
    index such as "1.\n\nKısa isim\n2. Yasanın genel yorum kuralı" with no
    "İÇDÜZENİ" heading and no "Madde" keyword, so neither _strip_toc nor
    _strip_toc_run sees it. Taken as articles, the index swallowed the real
    articles: the whole body ended up under the last index entry (audit of
    2026-11-05: 38 of 626 laws, among them Fasıl 113, 149, 6 and 148).

    The index is recognised by its shape: a run of at least ten numbered
    entries packed closely together (median gap < 150 characters), after
    which the numbering restarts at 1 or 2 and the entries are spaced like
    article bodies.
    """
    # Laws whose articles say "MADDE N" (with bodies after them) have their
    # index handled by _strip_toc / _strip_toc_run; numbered paragraphs inside
    # those articles would look like an index here (1960 Anayasası).
    keyword_starts = [m.start() for m in _ARTICLE_RE.finditer(text)] + [len(text)]
    if sum(1 for a, b in zip(keyword_starts, keyword_starts[1:]) if b - a >= 200) >= 10:
        return text
    candidates = _article_candidates(text)
    if len(candidates) < 20:
        return text
    peak = 0
    for idx, cand in enumerate(candidates):
        if cand["num"] <= 2 and peak >= 10 and idx >= 10:
            run = candidates[:idx]
            gaps = [b["pos"] - a["pos"] for a, b in zip(run, run[1:])]
            following = candidates[idx : idx + 8]
            body_gaps = [b["pos"] - a["pos"] for a, b in zip(following, following[1:])]
            increasing = sum(1 for a, b in zip(run, run[1:]) if b["num"] > a["num"]) / max(1, len(run) - 1)
            body_peak = max((c["num"] for c in candidates[idx:]), default=0)
            if (
                gaps
                # An index sits at the top of the document ...
                and run[0]["pos"] < 0.2 * len(text)
                and cand["pos"] < 0.5 * len(text)
                # ... is a dense, mostly increasing list ...
                and statistics.median(gaps) < 150
                and increasing >= 0.8
                # ... and the body after it is spaced like articles and
                # numbered up to roughly where the index ended. A numbered
                # list inside an article (items 1..12, then "1." again) fails
                # these tests.
                and body_gaps
                and statistics.median(body_gaps) >= 2 * statistics.median(gaps)
                and body_peak >= 0.6 * peak
            ):
                return text[: run[0]["pos"]] + text[cand["pos"] :]
        peak = max(peak, cand["num"])
    return text


def split_articles(text: str) -> list[Chunk]:
    """Split a consolidated law text into article chunks.

    Returns an empty list when the text does not look like an article-based
    law; callers then fall back to paragraph chunking.
    """
    text = _strip_numbered_toc(_strip_toc_run(_strip_toc(normalize_margin_notes(text))))
    candidates = _article_candidates(text)
    if len(candidates) < 2:
        return []
    selected = _select_article_sequence(candidates)
    if len(selected) < 2:
        return []

    selected, annex_start = _cut_annexes(text, selected)

    chunks: list[Chunk] = []
    preface = text[: selected[0]["pos"]].strip()
    if len(preface) > 120:
        for part in split_paragraphs(preface, kind="preamble"):
            part.ref = "Başlangıç"
            chunks.append(part)

    for idx, cand in enumerate(selected):
        start = cand["pos"]
        end = selected[idx + 1]["pos"] if idx + 1 < len(selected) else (annex_start if annex_start is not None else len(text))
        body = text[start:end].strip()
        if len(body) < 20:
            continue
        ref = f"Madde {cand['num']}{cand['suf']}"
        parts = _split_long(body)
        for part_no, part in enumerate(parts, 1):
            chunks.append(Chunk("article", ref if len(parts) == 1 else f"{ref} ({part_no}/{len(parts)})", part))
    if annex_start is not None:
        for part in split_paragraphs(text[annex_start:], kind="annex"):
            part.ref = "Ek"
            chunks.append(part)
    return chunks


# Annexes after the last article: "EK", "Ek – 1", "EK I", "CETVEL", forms.
_ANNEX_RE = re.compile(r"(?:(?<=\n)|(?<=\s{2}))(?:E[Kk](?:[ \t]*[–\-—][ \t]*\d+|[ \t]+[IVX\d]+|[ \t]*\n)|EKLER\b|CETVEL\b|[IVX]+\.?[ \t]*CETVEL\b)")
_IN_FORCE_RE = re.compile(r"yürürlüğe\s+gir", re.I)
_FORM_FIELD_RE = re.compile(r"\.{6,}|(?:\.\s?){8,}")


def _cut_annexes(text: str, selected: list[dict]) -> tuple[list[dict], Optional[int]]:
    """Stop the article sequence at the annexes that follow the last article.

    Forms printed after "Yürürlüğe Giriş" ("15. İşverenin adı, soyadı: ....")
    were taken as articles 15-25 of the Daimi İkamet İzni Tüzüğü (11 Nov
    2026), so their text could be cited as "Madde 15". Returns the articles up
    to the entry-into-force article, and where the annex text starts.
    """
    in_force = None
    for idx, cand in enumerate(selected):
        head = text[cand["pos"] : cand["pos"] + 260]
        if "Yürürlüğe Giriş" in head or "YÜRÜRLÜĞE GİRİŞ" in head or _IN_FORCE_RE.search(head):
            in_force = idx
    if in_force is None or in_force == len(selected) - 1:
        return selected, None
    start = selected[in_force]["pos"]
    sentence = _IN_FORCE_RE.search(text, start)
    search_from = text.find(".", sentence.end()) + 1 if sentence else start + 20
    marker = _ANNEX_RE.search(text, search_from)
    following = selected[in_force + 1 :]
    if marker and marker.start() <= following[0]["pos"] + 40:
        return selected[: in_force + 1], marker.start()
    # No annex heading: later "articles" that are form fields are the annex.
    def body(i: int) -> str:
        cand = selected[i]
        end = selected[i + 1]["pos"] if i + 1 < len(selected) else len(text)
        return text[cand["pos"] : end]
    forms = [i for i in range(in_force + 1, len(selected)) if _FORM_FIELD_RE.search(body(i))]
    if forms and len(forms) * 2 >= len(following):
        return selected[: in_force + 1], selected[in_force + 1]["pos"]
    return selected, None


def split_paragraphs(text: str, *, limit: int = 1500, kind: str = "paragraph") -> list[Chunk]:
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[Chunk] = []
    buf: list[str] = []
    size = 0
    for para in paragraphs:
        if len(para) > limit:
            if buf:
                chunks.append(Chunk(kind, "", "\n\n".join(buf)))
                buf, size = [], 0
            for part in _split_long(para, limit):
                chunks.append(Chunk(kind, "", part))
            continue
        if size + len(para) + 2 > limit and buf:
            chunks.append(Chunk(kind, "", "\n\n".join(buf)))
            buf, size = [], 0
        buf.append(para)
        size += len(para) + 2
    if buf:
        chunks.append(Chunk(kind, "", "\n\n".join(buf)))
    return chunks


def chunk_document(text: str, doc_type: str) -> list[Chunk]:
    text = clean_text(text)
    if not text:
        return []
    if doc_type != "karar":
        articles = split_articles(text)
        if articles:
            return articles
    return split_paragraphs(text)


_NUMBER_PATTERNS = (
    re.compile(r"\b(\d{1,4})\s*/\s*(\d{4})\b"),
    re.compile(r"\b(?:FASIL|BÖLÜM|BOLUM|CAP)\s*(\d{1,4})\b", re.I),
)
_TR_MAP = str.maketrans({"ı": "i", "İ": "i", "ş": "s", "ğ": "g", "ü": "u", "ö": "o", "ç": "c"})


def extract_number(title: str) -> Optional[str]:
    if not title:
        return None
    match = _NUMBER_PATTERNS[0].search(title)
    if match:
        return f"{int(match.group(1))}/{match.group(2)}"
    match = _NUMBER_PATTERNS[1].search(title)
    if match:
        return f"Fasıl {int(match.group(1))}"
    return None


def extract_year(title: str, number: Optional[str]) -> Optional[int]:
    if number and "/" in number:
        year_part = number.rsplit("/", 1)[1].strip()
        # Case numbers such as "E.35/19085" or typos like "20/81988" are not
        # years; only accept a four-digit 19xx/20xx suffix.
        if re.fullmatch(r"(?:19|20)\d{2}", year_part):
            return int(year_part)
    match = re.search(r"\b(19|20)\d{2}\b", title or "")
    return int(match.group(0)) if match else None


def slugify(value: str, *, max_len: int = 70) -> str:
    value = (value or "").translate(_TR_MAP)
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    value = re.sub(r"[^a-zA-Z0-9]+", "-", value).strip("-").lower()
    return value[:max_len].strip("-") or "belge"


def make_doc_id(prefix: str, number: Optional[str], title: str, fallback: str = "") -> str:
    if number:
        return f"{prefix}-{slugify(number, max_len=24)}"
    if fallback:
        return f"{prefix}-{slugify(fallback, max_len=24)}"
    return f"{prefix}-{slugify(title, max_len=60)}"


def normalize_title(title: str) -> str:
    return fold_tr(clean_text(title)).strip()


def truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    cut = text.rfind(" ", 0, limit)
    return text[: cut if cut > limit * 0.6 else limit].rstrip() + "…"


# Consolidated texts open with the list of amending laws. The wording varies:
#   "(11/1985; ... ve 25/2026 sayılı Değişiklik Yasaları ile değiştirilmiş ve
#    birleştirilmiş şekliyle)"
#   "(31/1982 ve 14/1991 sayılı Yasalar İle Değiştirilmiş ve Birleştirilmiş Şekli)"
#   "(30/2014, 34/2020 ve 8/2025 Sayılı Değişiklik Yasaları İle Birleştirilmiş Şekli)"
#   "[(22.04.1982 – R.G.30 – EK III – A.E. 161) ve (...) Sayılı Tüzükler ile
#    Birleştirilmiş Şekli]"  (regulations: amendments cited by date)
# Matching runs on the Turkish-folded text (same length as the original), so
# İ/ı/Ş casing does not matter.
_CONSOLIDATION = (
    re.compile(r"\(([^()]{0,4000}?)\bsayili\b[^()]{0,160}?birlestirilmis\s+sekl"),
    re.compile(r"\[([^\[\]]{0,4000}?)\bsayili\b[^\[\]]{0,160}?birlestirilmis\s+sekl"),
)
# Fallback for headers with nested parentheses, e.g. "(15.2.2002 – R.G. 17 – EK
# III – A.E. 85 Sayılı Tüzüğün, 22.7.2011 – ... ) Sayılı Tüzükle Birleştirilmiş
# Şekli)": take the paragraph that ends at the anchor.
_ANCHOR = re.compile(r"\bsayili\b[^\n]{0,160}?birlestirilmis\s+sekl")
_LAW_NUMBER = re.compile(r"(?<![\d/.])(\d{1,3})\s*/\s*((?:19|20)\d{2})(?!\d)")
_DATE = re.compile(r"(?<!\d)(\d{1,2})\.(\d{1,2})\.((?:19|20)\d{2})(?!\d)")


def parse_consolidation(text: str) -> Optional[dict]:
    """Amendments named in a consolidated text's header, oldest first.

    Returns ``{"through": "25/2026", "amendments": [...], "count": n}``; for
    regulations whose amendments are cited by date, ``through`` is the latest
    date (YYYY-MM-DD). None when the text carries no such header (not
    consolidated, or never amended).
    """
    head = clean_text(text or "")[:8000]
    folded = fold_tr(head).lower()
    match = None
    for pattern in _CONSOLIDATION:
        candidate = pattern.search(folded)
        if candidate and (match is None or candidate.start() < match.start()):
            match = candidate
    if match:
        span = head[match.start(1) : match.end()]
    else:
        anchor = _ANCHOR.search(folded)
        if not anchor:
            return None
        start = max(folded.rfind("\n\n", 0, anchor.start()) + 1, anchor.start() - 2500)
        span = head[start : anchor.end()]
    numbers: list[tuple[int, int]] = []
    for number, year in _LAW_NUMBER.findall(span):
        key = (int(year), int(number))
        if key not in numbers:
            numbers.append(key)
    if numbers:
        amendments = [f"{n}/{y}" for y, n in sorted(numbers)]
    else:
        dates = sorted({f"{y}-{int(m):02d}-{int(d):02d}" for d, m, y in _DATE.findall(span)})
        if not dates:
            return None
        amendments = dates
    return {"through": amendments[-1], "amendments": amendments, "count": len(amendments)}
