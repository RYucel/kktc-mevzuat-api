"""Term dictionary: everyday words -> statute -> article (OPUS-GOREVLER-4 G).

Terms live in data/terms/<statute id>.jsonl, one per line:

    {"term": "mahkeme kararı olmadan gözaltı", "doc": "yasa-fasil-155",
     "ref": "Madde 14", "source": "baslik" | "claude" | "model",
     "status": "claude" | "avukat" | "red"}

source: "baslik" is the article heading itself; "claude" was written by
Claude from the heading and opening text and read a second time against
them; "model" was generated in bulk by a model and is only kept when it
shares a word with the article (an invented term that touches nothing in the
article is more likely wrong than helpful).

They are written from the statute text only (article headings and opening
sentences), never from the eval questions. "claude": checked by a second
pass and the filters below, used to bring candidates; "avukat": approved by
a lawyer, also counts as support for "high"; "red": rejected, never built.

The key matches the question side in packages/core/src/terms.ts: the sorted,
unique first-four-letter stems of the term's content words.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterable

from .textproc import fold_tr

# Same as QUERY_STOPWORDS in packages/core/src/text.ts, plus legal fillers
# that every article has.
STOPWORDS = {
    "nedir", "nelerdir", "nasil", "hangi", "hangisi", "kadar", "ne", "en", "az", "cok", "fazla",
    "mi", "mu", "midir", "mudur", "var", "yok", "icin", "ile", "ve", "veya", "olan", "olarak",
    "gibi", "kim", "kimdir", "nerede", "zaman", "ise", "bir", "bu", "su", "da", "de", "ki",
}
STEM = 4
MAX_DOCS_PER_KEY = 3


def stems(text: str) -> list[str]:
    words = re.split(r"[^a-z0-9]+", fold_tr(text or ""))
    out: list[str] = []
    for word in words:
        if len(word) < 3 or word in STOPWORDS or word.isdigit():
            continue
        stem = word[:STEM]
        if stem not in out:
            out.append(stem)
    return out


def term_key(term: str) -> str:
    return " ".join(sorted(stems(term)))


def load_terms(directory: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in sorted(directory.glob("*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rows.append(json.loads(line))
    return rows


def accepted(rows: Iterable[dict[str, Any]], texts: dict[tuple[str, str], str]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Terms that pass the filters, with the reasons others were dropped.

    - rejected ("red") terms and terms without content words are dropped;
    - a model-generated term must share at least one stem with its article
      (heading or text). Written and reviewed terms are exempt: bridging the
      words people use to the statute's own ("önceden planlayarak öldürme" ->
      "taammüden katil") is their whole point;
    - single-stem terms must be at least 6 letters long (\"ceza\" says nothing);
    - a key used for more than MAX_DOCS_PER_KEY statutes is not distinctive.
    """
    dropped = {"red": 0, "empty": 0, "no_overlap": 0, "short": 0, "not_distinctive": 0, "unknown_article": 0}
    kept: list[dict[str, Any]] = []
    for row in rows:
        if row.get("status") == "red":
            dropped["red"] += 1
            continue
        key = term_key(row["term"])
        if not key:
            dropped["empty"] += 1
            continue
        text = texts.get((row["doc"], row["ref"]))
        if text is None:
            dropped["unknown_article"] += 1
            continue
        if row.get("source") == "model" and row.get("status") != "avukat":
            article = set(stems(text))
            if not set(key.split()) & article:
                dropped["no_overlap"] += 1
                continue
        if " " not in key and len(re.sub(r"[^a-z]", "", fold_tr(row["term"]))) < 6:
            dropped["short"] += 1
            continue
        kept.append({**row, "key": key})
    docs_by_key: dict[str, set[str]] = {}
    for row in kept:
        docs_by_key.setdefault(row["key"], set()).add(row["doc"])
    final = []
    for row in kept:
        # Headings shared by several statutes ("Suç ve Cezalar", "Yetkili
        # Makam", "Geçici Madde") say nothing about the subject.
        limit = 1 if row.get("source") == "baslik" else MAX_DOCS_PER_KEY
        if len(docs_by_key[row["key"]]) > limit:
            dropped["not_distinctive"] += 1
            continue
        final.append(row)
    # One row per (key, doc, ref).
    seen: set[tuple[str, str, str]] = set()
    unique = []
    for row in final:
        k = (row["key"], row["doc"], row["ref"])
        if k in seen:
            continue
        seen.add(k)
        unique.append(row)
    return unique, dropped
