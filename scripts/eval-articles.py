"""Print the expected articles of the eval sets (d1-maintenance task "articles").

Statute text is public; only eval questions are read, never user data. Used to
write each question's `must` phrases from the statute text itself
(OPUS-GOREVLER-4 item 3). Also lists ids that exist both with and without
leading zeros (item 2).
"""
import json
import re
import subprocess
import sys


def cases(path):
    data = json.load(open(path, encoding="utf-8"))
    return data if isinstance(data, list) else data["cases"]


def answers(c):
    return [c, *c.get("alt", [])]


def sql(text):
    return "'" + text.replace("'", "''") + "'"


def d1(command):
    out = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "kktc-mevzuat", "--remote", "--json", "--command", command],
        cwd="apps/worker", check=True, capture_output=True, text=True,
    ).stdout
    return json.loads(out)[0]["results"]


pairs = set()
for path in sys.argv[1:]:
    for c in cases(path):
        for a in answers(c):
            if not a.get("expect"):
                continue
            for ref in a.get("refs") or ([a["ref"]] if a.get("ref") else []):
                pairs.add((a["expect"], ref))

rows = []
pairs = sorted(pairs)
for i in range(0, len(pairs), 40):
    part = pairs[i : i + 40]
    where = " OR ".join(f"(doc_id = {sql(d)} AND (ref = {sql(r)} OR ref LIKE {sql(r + ' (%')}))" for d, r in part)
    rows += d1(f"SELECT doc_id, ref, ord, text FROM chunks WHERE kind = 'article' AND ({where}) ORDER BY doc_id, ord")

print("ARTICLES-JSON-BEGIN")
for d, r in pairs:
    text = "\n".join(x["text"] for x in rows if x["doc_id"] == d and (x["ref"] == r or x["ref"].startswith(r + " (")))
    print(json.dumps({"doc": d, "ref": r, "text": text[:3000]}, ensure_ascii=False))
print("ARTICLES-JSON-END")

ids = [x["id"] for x in d1("SELECT id FROM documents WHERE type != 'karar'")]
known = set(ids)
padded = [i for i in ids if re.sub(r"(?<![0-9])0+(?=[0-9])", "", i) != i]
print(f"zero-padded ids: {len(padded)}; with a canonical twin: {sum(re.sub(r'(?<![0-9])0+(?=[0-9])', '', i) in known for i in padded)}")
for i in padded[:60]:
    print("  ", i, "->", re.sub(r"(?<![0-9])0+(?=[0-9])", "", i), "(twin)" if re.sub(r"(?<![0-9])0+(?=[0-9])", "", i) in known else "")
