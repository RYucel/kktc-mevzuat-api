"""Which columns differ between the fresh build and what D1 holds?

The incremental export rewrote 10,390 of 10,595 documents on 2026-11-09 with
no real change in the texts. This compares the local build with D1 column by
column (and chunk counts/lengths/ids per document) and prints how many
documents differ in each, with a few examples.

  python scripts/d1_diff.py LOCAL_DB D1_DOCS_JSON D1_CHUNKS_JSON
"""

import json
import sqlite3
import sys
from collections import Counter

VOLATILE = {"fetched_at", "updated_at"}


def wrangler_rows(path):
    data = json.load(open(path, encoding="utf-8"))
    if isinstance(data, list):
        rows = []
        for part in data:
            rows.extend(part.get("results") or [])
        return rows
    return data.get("results") or []


def main(local_db, docs_json, chunks_json):
    conn = sqlite3.connect(local_db)
    conn.row_factory = sqlite3.Row
    local = {row["id"]: dict(row) for row in conn.execute("SELECT * FROM documents")}
    remote = {row["id"]: row for row in wrangler_rows(docs_json)}
    local_chunks = {
        row[0]: (row[1], row[2], row[3])
        for row in conn.execute("SELECT doc_id, COUNT(*), SUM(LENGTH(text)), SUM(id % 1000003) FROM chunks GROUP BY doc_id")
    }
    remote_chunks = {row["doc_id"]: (row["n"], row["chars"], row["idsum"]) for row in wrangler_rows(chunks_json)}

    counts, examples = Counter(), {}
    any_diff = 0
    for doc_id, row in local.items():
        other = remote.get(doc_id)
        if other is None:
            counts["(D1'de yok)"] += 1
            any_diff += 1
            continue
        differs = False
        for col, value in row.items():
            if col in VOLATILE or col not in other:
                continue
            if (value if value is not None else None) != other[col]:
                counts[col] += 1
                differs = True
                examples.setdefault(col, []).append((doc_id, str(other[col])[:160], str(value)[:160]))
        lc, rc = local_chunks.get(doc_id), remote_chunks.get(doc_id)
        if lc != (tuple(rc) if rc else None):
            for name, i in (("chunks:sayı", 0), ("chunks:uzunluk", 1), ("chunks:id", 2)):
                if (lc or (None,) * 3)[i] != (rc or (None,) * 3)[i]:
                    counts[name] += 1
                    differs = True
                    examples.setdefault(name, []).append((doc_id, str((rc or (None,) * 3)[i]), str((lc or (None,) * 3)[i])))
        any_diff += differs
    print(f"belgeler: yerel {len(local)}, D1 {len(remote)}; en az bir farkı olan: {any_diff}")
    for col, n in counts.most_common():
        print(f"  {col}: {n}")
        for doc_id, old, new in examples.get(col, [])[:3]:
            print(f"      {doc_id}\n        D1:    {old}\n        yerel: {new}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
