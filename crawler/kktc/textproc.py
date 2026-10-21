"""Turkish text normalisation, PDF cleanup and article-aware chunking.

The search index uses a folded (ASCII-ish) copy of the text. Folding is
character-for-character so offsets in the folded text map 1:1 onto the
original text; the API uses that property to build clean Turkish snippets
without asking SQLite for them.
"""

from __future__ import annotations

import re
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
_TITLE_NUM_RE = re.compile(
    r"(?m)^[ \t]*(?P<title>[A-ZÇĞİÖŞÜ][^\n]{1,80}?)[ \t]+(?P<num>\d{1,4})(?P<suf>[A-Z])?\.[ \t]+(?P<rest>[^\n]*)$"
)
# Heading + number where the body starts on the next (possibly blank) line:
#   "Kısa İsim 1.\n\nBu Yasa ..."
_TITLE_BARE_NUM_RE = re.compile(
    r"(?m)^[ \t]*(?P<title>[A-ZÇĞİÖŞÜ][^\n]{1,80}?)[ \t]+(?P<num>\d{1,4})(?P<suf>[A-Z])?\.[ \t]*(?:\n[ \t]*)+(?=[A-ZÇĞİÖŞÜ(])"
)
# Heading printed with a full stop before the number ("Kısa isim. 1. ...").
_TITLE_PERIOD_NUM_RE = re.compile(
    r"(?m)^[ \t]*(?P<title>[A-ZÇĞİÖŞÜ][^\n.]{1,80}?)\.[ \t]+(?P<num>\d{1,4})(?P<suf>[A-Z])?\.[ \t]+(?P<rest>[A-ZÇĞİÖŞÜ(][^\n]*)$"
)
# PDF extraction may join the heading to the previous sentence:
#   "... aşağıdaki Tüzüğü yapar: Kısa İsim 1. Bu Tüzük ..."
_JOINED_TITLE_NUM_RE = re.compile(
    r"(?m)(?:^|[.:;]\s+)(?P<title>[A-ZÇĞİÖŞÜ][^\n:;]{1,80}?)[ \t]+(?P<num>\d{1,4})(?P<suf>[A-Z])?\.[ \t]+(?P<rest>[A-ZÇĞİÖŞÜ(][^\n]*)$"
)
# Amendment footnotes printed between an article heading and its number, e.g.
# "Hayvanın Tutsak Edilmesi 9(2).17/2025 383. ...".
_TITLE_FOOTNOTE_SUFFIX_RE = re.compile(
    r"[ \t]+(?:\d{1,3}\s*\(\d+\)\.\s*\d{1,4}\s*/\s*\d{4}|\d{1,3}\.\s*\d{1,4}\s*/\s*\d{4})[ \t]*$"
)
_NUM_RE = re.compile(
    r"(?m)^[ \t]*(?P<num>\d{1,4})(?P<suf>[A-Z])?\.[ \t]+(?P<rest>[A-ZÇĞİÖŞÜ(][^\n]*)$"
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


def _looks_like_title(line: str) -> bool:
    """True for short heading lines such as "Kısa İsim" or "TEFSİR"."""
    line = line.strip()
    if not line or len(line) > 90:
        return False
    if line[-1] in ".:;,)" or line[0] in "([":
        return False
    if not line[0].isupper():
        return False
    words = line.split()
    if len(words) > 9:
        return False
    if any(ch.isdigit() for ch in line):
        return False
    return True


def _article_candidates(text: str) -> list[dict]:
    """Collect possible article starts from the three layouts seen in KKTC law PDFs.

    Layouts:
      * ``MADDE 12. ...`` / ``Madde 12. ...``
      * ``Kısa İsim 1. Bu Yasa ...`` (title before the number)
      * ``6. (1) ...`` (bare number, title on the preceding line)
    """
    found: dict[int, dict] = {}

    def add(pos: int, num: int, suf: str, title: str, priority: int) -> None:
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
        if _AMENDMENT_REF_RE.match(rest) or not _looks_like_title(title):
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


def split_articles(text: str) -> list[Chunk]:
    """Split a consolidated law text into article chunks.

    Returns an empty list when the text does not look like an article-based
    law; callers then fall back to paragraph chunking.
    """
    text = _strip_toc_run(_strip_toc(text))
    candidates = _article_candidates(text)
    if len(candidates) < 2:
        return []
    selected = _select_article_sequence(candidates)
    if len(selected) < 2:
        return []

    chunks: list[Chunk] = []
    preface = text[: selected[0]["pos"]].strip()
    if len(preface) > 120:
        for part in split_paragraphs(preface, kind="preamble"):
            part.ref = "Başlangıç"
            chunks.append(part)

    for idx, cand in enumerate(selected):
        start = cand["pos"]
        end = selected[idx + 1]["pos"] if idx + 1 < len(selected) else len(text)
        body = text[start:end].strip()
        if len(body) < 20:
            continue
        ref = f"Madde {cand['num']}{cand['suf']}"
        parts = _split_long(body)
        for part_no, part in enumerate(parts, 1):
            chunks.append(Chunk("article", ref if len(parts) == 1 else f"{ref} ({part_no}/{len(parts)})", part))
    return chunks


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
