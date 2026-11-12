"""Random articles from statutes the eval sets do not cover (OPUS-GOREVLER-4 item 4).

Prints statute text only (public). Used to write new eval questions from the
statute text itself, before the system sees them.
"""
import json
import random
import subprocess
import sys


def d1(command):
    out = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "kktc-mevzuat", "--remote", "--json", "--command", command],
        cwd="apps/worker", check=True, capture_output=True, text=True,
    ).stdout
    return json.loads(out)[0]["results"]


covered = set()
for path in sys.argv[1:]:
    for c in json.load(open(path, encoding="utf-8"))["cases"]:
        for a in [c, *c.get("alt", [])]:
            if a.get("expect"):
                covered.add(a["expect"])

docs = d1(
    "SELECT id, type, title FROM documents WHERE type IN ('yasa','tuzuk') AND text_status = 'full' "
    "AND source = 'gov' AND title NOT LIKE '%Değişiklik%' AND chunk_count >= 12"
)
random.seed(20261112)
docs = [d for d in docs if d["id"] not in covered]
laws = [d for d in docs if d["type"] == "yasa"]
regs = [d for d in docs if d["type"] == "tuzuk"]
picked = random.sample(laws, min(90, len(laws))) + random.sample(regs, min(30, len(regs)))
print(f"{len(laws)} laws and {len(regs)} regulations not in the eval sets; sampling {len(picked)}")
print("SAMPLE-JSON-BEGIN")
for d in picked:
    rows = d1(
        f"SELECT ref, group_concat(text, ' ') AS text FROM chunks WHERE doc_id = '{d['id']}' AND kind = 'article' "
        "GROUP BY ref ORDER BY MIN(ord)"
    )
    rows = [r for r in rows if len(r["text"] or "") > 200][3:]
    for r in random.sample(rows, min(2, len(rows))):
        print(json.dumps({"doc": d["id"], "type": d["type"], "title": d["title"], "ref": r["ref"], "text": r["text"][:1200]}, ensure_ascii=False))
print("SAMPLE-JSON-END")
