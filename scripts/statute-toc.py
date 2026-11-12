"""Article headings and opening text of given statutes (d1-maintenance task "toc").

Statute text only (public). Input for the term dictionary (OPUS-GOREVLER-4
item 15): terms are written from the statute itself, never from eval questions.
"""
import json
import re
import subprocess
import sys


def d1(command):
    out = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "kktc-mevzuat", "--remote", "--json", "--command", command],
        cwd="apps/worker", check=True, capture_output=True, text=True,
    ).stdout
    return json.loads(out)[0]["results"]


ids = [i for i in re.split(r"[\s,]+", sys.argv[1]) if re.fullmatch(r"[a-z0-9][a-z0-9-]{1,120}", i)]
print("TOC-JSON-BEGIN")
for doc_id in ids:
    rows = d1(
        f"SELECT ref, MIN(ord) AS ord, substr(group_concat(text, ' '), 1, 320) AS head FROM chunks "
        f"WHERE doc_id = '{doc_id}' AND kind = 'article' AND ref IS NOT NULL GROUP BY ref ORDER BY MIN(ord)"
    )
    for r in rows:
        print(json.dumps({"doc": doc_id, "ref": r["ref"], "head": r["head"]}, ensure_ascii=False))
print("TOC-JSON-END")
