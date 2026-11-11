"""Article-structure consistency report for the built database.

    python scripts/article_report.py data/kktc.db

Counts statutes whose article split looks wrong, so a parser change that
breaks or fixes citations shows up between data runs:
  - form_field: an "article" that is mostly a form (dotted fill-in lines)
  - number_missing: the article's number does not appear near its start
  - out_of_order: article numbers go down within a statute
  - annex: statutes with an annex chunk (forms/tables cut off the last article)
Prints totals and a few examples of each; never fails the job.
"""

from __future__ import annotations

import re
import sqlite3
import sys
from collections import defaultdict

FORM = re.compile(r"\.{6,}|(?:\.\s?){8,}")


def main(db_path: str) -> None:
    conn = sqlite3.connect(db_path)
    rows = conn.execute(
        "SELECT c.doc_id, c.ord, c.kind, c.ref, c.text FROM chunks c JOIN documents d ON d.id = c.doc_id "
        "WHERE d.type IN ('yasa', 'tuzuk', 'anayasa') AND c.kind IN ('article', 'annex') ORDER BY c.doc_id, c.ord"
    )
    issues: dict[str, set[str]] = defaultdict(set)
    examples: dict[str, list[str]] = defaultdict(list)
    last: dict[str, int] = {}

    def note(kind: str, doc: str, ref: str) -> None:
        issues[kind].add(doc)
        if len(examples[kind]) < 5:
            examples[kind].append(f"{doc} {ref}")

    for doc, _ord, kind, ref, text in rows:
        if kind == "annex":
            note("annex", doc, ref or "")
            continue
        m = re.match(r"Madde (\d+)([A-Z]?)", ref or "")
        if not m or "(" in (ref or "") and not (ref or "").endswith("(1/2)") and "(1/" not in (ref or ""):
            continue
        num = int(m.group(1))
        head = text[:260]
        if not re.search(rf"(?<![\d/.]){num}{m.group(2)}\s*[.\-(]|MADDE\s+{num}\b", head, re.I):
            note("number_missing", doc, ref)
        if len(FORM.findall(text)) >= 2 and len(text) < 600:
            note("form_field", doc, ref)
        if num < last.get(doc, 0):
            note("out_of_order", doc, ref)
        last[doc] = max(last.get(doc, 0), num)

    print("Madde yapısı raporu (yasa/tüzük/anayasa)")
    for kind in ("form_field", "number_missing", "out_of_order", "annex"):
        print(f"  {kind}: {len(issues[kind])} belge  örnek: {', '.join(examples[kind]) or '-'}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data/kktc.db")
