"""Review sheets for the term dictionary (OPUS-GOREVLER-4 item 16).

    python3 scripts/terms-review.py export [--doc yasa-22-1992] > inceleme.csv
    python3 scripts/terms-review.py import inceleme.csv

The CSV has one row per term: statute, article, term, status, and an empty
"karar" column. A reviewer writes "onay" (approved: status avukat) or "red"
(rejected: never built again) and leaves the rest empty. Import writes the
decisions back into terms/<statute>.jsonl; rows without a decision keep their
status. Opens in Excel and Google Sheets (UTF-8 with BOM).
"""
import csv
import json
import sys
from pathlib import Path

TERMS = Path(__file__).resolve().parents[1] / "terms"
FIELDS = ["belge", "madde", "terim", "durum", "karar"]


def load(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def export(doc=None):
    out = csv.DictWriter(sys.stdout, fieldnames=FIELDS)
    sys.stdout.write("﻿")
    out.writeheader()
    for path in sorted(TERMS.glob("*.jsonl")):
        if doc and path.stem != doc:
            continue
        for row in load(path):
            out.writerow({"belge": row["doc"], "madde": row["ref"], "terim": row["term"], "durum": row.get("status", "claude"), "karar": ""})


def import_(csv_path):
    decisions = {}
    with open(csv_path, encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle):
            verdict = (row.get("karar") or "").strip().lower()
            if verdict in ("onay", "onaylandı", "evet", "ok"):
                decisions[(row["belge"], row["madde"], row["terim"])] = "avukat"
            elif verdict in ("red", "hayır", "hayir", "yanlış", "yanlis"):
                decisions[(row["belge"], row["madde"], row["terim"])] = "red"
    changed = 0
    for path in sorted(TERMS.glob("*.jsonl")):
        rows = load(path)
        for row in rows:
            status = decisions.get((row["doc"], row["ref"], row["term"]))
            if status and row.get("status") != status:
                row["status"] = status
                changed += 1
        path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    print(f"{changed} terim güncellendi ({len(decisions)} karar okundu).")


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "export":
        export(sys.argv[3] if len(sys.argv) >= 4 and sys.argv[2] == "--doc" else None)
    elif len(sys.argv) == 3 and sys.argv[1] == "import":
        import_(sys.argv[2])
    else:
        print(__doc__)
        sys.exit(2)
