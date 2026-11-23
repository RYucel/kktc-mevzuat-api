"""Hugging Face dataset export: legislation, court decisions and articles as Parquet.

Built from the same ``kktc.db`` that feeds D1, so the dataset, the API and the
semantic index always describe the same texts. Three configs:

- ``mevzuat``  one row per anayasa / yasa / tüzük, with full text (or null when
  only the catalogue entry is known, ``text_status = metadata``)
- ``kararlar`` one row per court decision
- ``maddeler`` one row per article (parts joined) of the statutes the answers
  quote, with the synthetic citizen questions when ``questions.jsonl.gz`` is
  given. Query/passage pairs for embedding training come straight from here.

    python -m kktc hf export --questions ../data/questions.jsonl.gz
    python -m kktc hf push --repo stevevaius/kktc-mevzuat          # HF_TOKEN in env

Needs ``pyarrow`` (and ``huggingface_hub`` for push): requirements-hf.txt.
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import time
from collections import Counter
from pathlib import Path
from typing import Any, Optional

from .vectors import LEGISLATION, _PART, build_units, load_questions, question_key

log = logging.getLogger(__name__)

TYPE_LABELS = {"anayasa": "Anayasa", "yasa": "Yasa", "tuzuk": "Tüzük", "karar": "Mahkeme kararı"}


def _extra(row: sqlite3.Row) -> dict[str, Any]:
    try:
        return json.loads(row["extra_json"]) if row["extra_json"] else {}
    except json.JSONDecodeError:
        return {}


def _texts(conn: sqlite3.Connection) -> dict[str, str]:
    """Full text per document: its non-title chunks in order."""
    out: dict[str, list[str]] = {}
    for row in conn.execute("SELECT doc_id, text FROM chunks WHERE kind != 'title' ORDER BY doc_id, ord"):
        out.setdefault(row[0], []).append(row[1])
    return {doc_id: "\n\n".join(parts) for doc_id, parts in out.items()}


def _decision_no(prefix: str, number: Any, year: Any) -> Optional[str]:
    if number in (None, "") or year in (None, ""):
        return None
    return f"{prefix}{number}/{year}"


def decision_title(court: Optional[str], number: Optional[str], subject: Optional[str]) -> str:
    """The catalogue title without the parties (sources._decision_title puts them in)."""
    title = " - ".join(b for b in (court or "Mahkeme Kararı", number) if b)
    return f"{title} ({subject})" if subject else title


def legislation_rows(conn: sqlite3.Connection, texts: dict[str, str]) -> list[dict[str, Any]]:
    rows = []
    marks = ",".join("?" * len(LEGISLATION))
    for row in conn.execute(f"SELECT * FROM documents WHERE type IN ({marks}) ORDER BY type, year, id", LEGISLATION):
        extra = _extra(row)
        text = texts.get(row["id"]) if row["text_status"] != "metadata" else None
        rows.append(
            {
                "id": row["id"],
                "type": row["type"],
                "subtype": row["subtype"],
                "title": row["title"],
                "display_title": extra.get("display_title"),
                "number": row["number"],
                "year": row["year"],
                "date": row["date"],
                "source": row["source"],
                "source_url": row["source_url"],
                "pdf_url": row["pdf_url"],
                "text_status": row["text_status"],
                "consolidated_through": (extra.get("consolidation") or {}).get("through"),
                "parent_law": extra.get("parent_law"),
                "categories": list(extra.get("categories") or []),
                "duplicate_of": extra.get("duplicate_of"),
                "chars": len(text) if text else 0,
                "text": text,
            }
        )
    return rows


def decision_rows(conn: sqlite3.Connection, texts: dict[str, str]) -> list[dict[str, Any]]:
    rows = []
    for row in conn.execute("SELECT * FROM documents WHERE type = 'karar' ORDER BY date, id"):
        extra = _extra(row)
        text = texts.get(row["id"]) if row["text_status"] != "metadata" else None
        rows.append(
            {
                "id": row["id"],
                "court": row["court"],
                "title": decision_title(row["court"], row["number"], row["subject"]),
                "esas_no": _decision_no("E.", extra.get("enumara"), extra.get("yile")),
                "karar_no": _decision_no("D.", extra.get("dnumara"), extra.get("yild")),
                "date": row["date"],
                "year": row["year"],
                "subject": row["subject"],
                "summary": row["summary"],
                "cited_articles": extra.get("yasa_madde"),
                "source_url": row["source_url"],
                "pdf_url": row["pdf_url"],
                "chars": len(text) if text else 0,
                "text": text,
            }
        )
    return rows


def article_rows(db_path: Path, conn: sqlite3.Connection, questions: dict[str, list[str]]) -> list[dict[str, Any]]:
    """One row per article of the statutes the API quotes (no duplicates or amendment acts).

    The set of documents and the unit boundaries are those of the semantic
    index (vectors.build_units), so ``(doc_id, ord)`` matches the API and the
    question keys match questions.jsonl.gz. Unlike the index units, the text
    here is not cut to 1800 characters.
    """
    units = build_units(db_path, fmt=1)
    keys = {}
    for unit in units:
        if "\n" in unit["text"]:
            keys[(unit["doc_id"], unit["ord"])] = question_key(unit["doc_id"], unit["ref"], unit["text"].split("\n", 1)[1])
    kept = {u["doc_id"] for u in units}
    meta = {
        r["id"]: r
        for r in conn.execute(
            "SELECT id, type, title, source, year, json_extract(extra_json, '$.display_title') AS display FROM documents"
        )
    }

    rows: list[dict[str, Any]] = []
    current: Optional[dict[str, Any]] = None

    def close() -> None:
        nonlocal current
        if current:
            doc = meta[current["doc_id"]]
            key = keys.get((current["doc_id"], current["ord"]))
            rows.append(
                {
                    "doc_id": current["doc_id"],
                    "doc_title": doc["display"] or doc["title"],
                    "type": doc["type"],
                    "source": doc["source"],
                    "year": doc["year"],
                    "ord": current["ord"],
                    "ref": current["ref"],
                    "kind": current["kind"],
                    "text": " ".join(current["parts"]),
                    "questions": list(questions.get(key, [])) if key else [],
                }
            )
        current = None

    # Same grouping as build_units: article parts "12 (1/3)" ... are one row.
    for row in conn.execute("SELECT doc_id, ord, kind, ref, text FROM chunks WHERE kind != 'title' ORDER BY doc_id, ord"):
        if row["doc_id"] not in kept:
            continue
        ref = row["ref"] or None
        key = _PART.sub("", ref) if (row["kind"] == "article" and ref) else ref
        if (
            current
            and current["doc_id"] == row["doc_id"]
            and key
            and current["ref"] == key
            and row["kind"] in ("article", "preamble")
        ):
            current["parts"].append(row["text"])
            continue
        close()
        current = {"doc_id": row["doc_id"], "ord": row["ord"], "ref": key, "kind": row["kind"], "parts": [row["text"]]}
    close()
    return rows


def _write_parquet(rows: list[dict[str, Any]], path: Path, schema: Any) -> None:
    import pyarrow as pa
    import pyarrow.parquet as pq

    table = pa.Table.from_pylist(rows, schema=schema)
    pq.write_table(table, path, compression="zstd")


def _schemas() -> dict[str, Any]:
    import pyarrow as pa

    s, i, lst = pa.string(), pa.int32(), pa.list_(pa.string())
    return {
        "mevzuat": pa.schema(
            [
                ("id", s), ("type", s), ("subtype", s), ("title", s), ("display_title", s), ("number", s),
                ("year", i), ("date", s), ("source", s), ("source_url", s), ("pdf_url", s), ("text_status", s),
                ("consolidated_through", s), ("parent_law", s), ("categories", lst), ("duplicate_of", s),
                ("chars", i), ("text", s),
            ]
        ),
        "kararlar": pa.schema(
            [
                ("id", s), ("court", s), ("title", s), ("esas_no", s), ("karar_no", s), ("date", s), ("year", i),
                ("subject", s), ("summary", s), ("cited_articles", s), ("source_url", s),
                ("pdf_url", s), ("chars", i), ("text", s),
            ]
        ),
        "maddeler": pa.schema(
            [
                ("doc_id", s), ("doc_title", s), ("type", s), ("source", s), ("year", i), ("ord", i), ("ref", s),
                ("kind", s), ("text", s), ("questions", lst),
            ]
        ),
    }


def _int(value: Any) -> Optional[int]:
    try:
        return int(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


def export(db_path: Path, out_dir: Path, questions_path: Optional[Path] = None) -> dict[str, Any]:
    db_path, out_dir = Path(db_path), Path(out_dir)
    if not db_path.exists():
        raise SystemExit(f"Database not found: {db_path}")
    (out_dir / "data").mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    texts = _texts(conn)
    questions = load_questions(questions_path)

    tables = {
        "mevzuat": legislation_rows(conn, texts),
        "kararlar": decision_rows(conn, texts),
        "maddeler": article_rows(db_path, conn, questions),
    }
    raw = next(iter(conn.execute("SELECT value FROM meta WHERE key = 'built_at'")), [None])[0]
    built_at = json.loads(raw) if raw else None
    conn.close()

    for rows in tables.values():
        for row in rows:
            for col in ("year", "chars", "ord"):
                if col in row:
                    row[col] = _int(row[col])
    schemas = _schemas()
    for name, rows in tables.items():
        _write_parquet(rows, out_dir / "data" / f"{name}.parquet", schemas[name])

    stats = summarise(tables)
    stats["built_at"] = built_at or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    (out_dir / "stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "README.md").write_text(dataset_card(stats), encoding="utf-8")
    log.info("hf export: %s", {k: len(v) for k, v in tables.items()})
    return stats


def summarise(tables: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    leg = tables["mevzuat"]
    by_type: dict[str, Counter[str]] = {}
    for row in leg:
        by_type.setdefault(row["type"], Counter())[row["text_status"]] += 1
    courts = Counter(r["court"] or "?" for r in tables["kararlar"])
    years = [r["year"] for r in tables["kararlar"] if r["year"]]
    arts = tables["maddeler"]
    return {
        "mevzuat": {t: dict(c) for t, c in sorted(by_type.items())},
        "mevzuat_total": len(leg),
        "kararlar_total": len(tables["kararlar"]),
        "kararlar_with_text": sum(1 for r in tables["kararlar"] if r["text"]),
        "kararlar_years": [min(years), max(years)] if years else None,
        "kararlar_courts": dict(courts.most_common(12)),
        "maddeler_total": len(arts),
        "maddeler_with_questions": sum(1 for r in arts if r["questions"]),
        "questions_total": sum(len(r["questions"]) for r in arts),
    }


def dataset_card(stats: dict[str, Any]) -> str:
    def n(x: Any) -> str:
        return f"{x:,}".replace(",", ".") if isinstance(x, int) else str(x)

    leg_lines = []
    for t, counts in stats["mevzuat"].items():
        total = sum(counts.values())
        full = counts.get("full", 0) + counts.get("partial", 0)
        leg_lines.append(f"| {TYPE_LABELS.get(t, t)} | {n(total)} | {n(full)} | {n(counts.get('metadata', 0))} |")
    court_lines = [f"| {c} | {n(k)} |" for c, k in stats["kararlar_courts"].items()]
    years = stats["kararlar_years"]
    year_note = f" ({years[0]}–{years[1]})" if years else ""
    total = stats["mevzuat_total"] + stats["kararlar_total"]
    size = "1K<n<10K" if total < 10_000 else "10K<n<100K" if total < 100_000 else "100K<n<1M"

    return f"""---
language:
- tr
license: other
license_name: kamu-belgesi
pretty_name: KKTC Mevzuat ve İçtihat
size_categories:
- {size}
task_categories:
- text-retrieval
- question-answering
- text-generation
tags:
- legal
- turkish
- kktc
- north-cyprus
- mevzuat
- ictihat
configs:
- config_name: mevzuat
  default: true
  data_files: data/mevzuat.parquet
- config_name: kararlar
  data_files: data/kararlar.parquet
- config_name: maddeler
  data_files: data/maddeler.parquet
---

# KKTC Mevzuat ve İçtihat

Kuzey Kıbrıs Türk Cumhuriyeti'nin anayasa, yasa ve tüzük metinleri ile mahkeme kararları;
makine tarafından okunabilir, madde bazlı ve haftalık güncellenen bir veri seti.

Kaynaklar: [mevzuat.gov.ct.tr](https://mevzuat.gov.ct.tr) (Merkezi Mevzuat Dairesi) ve
[mevzuat.mahkemeler.net](https://mevzuat.mahkemeler.net) (Mahkemeler Mevzuat Bilgi Sistemi).
Aynı veri [KKTC Mevzuat API](https://kktc-mevzuat-api.stevevaius.workers.dev) ve MCP sunucusunu besler;
derleme kodu: [github.com/RYucel/kktc-mevzuat-api](https://github.com/RYucel/kktc-mevzuat-api).

Son derleme: `{stats['built_at']}`

> **Hukuki not:** Metinler resmî PDF/DOC dosyalarından otomatik olarak çıkarılmıştır ve hata
> içerebilir. Bağlayıcı metin her zaman kaynak kurumun yayımladığı belgedir (`source_url`).
> Yürürlük ve değişiklikler için Resmî Gazete'yi kontrol edin. Bu veri seti hukuki danışmanlık değildir.

## Kapsam

| Tür | Belge | Tam metin | Yalnız künye |
| --- | ---: | ---: | ---: |
{chr(10).join(leg_lines)}

`text_status = metadata` olan belgelerin yalnızca künyesi ve resmî dosya bağlantısı vardır
(çoğunlukla 2015 öncesi taranmış tüzük PDF'leri); bunlar OCR ile ilerleyen sürümlerde doldurulacaktır.

**Mahkeme kararları:** {n(stats['kararlar_total'])} karar{year_note}, {n(stats['kararlar_with_text'])} tanesi tam metinli.

| Mahkeme | Karar |
| --- | ---: |
{chr(10).join(court_lines)}

**Maddeler:** {n(stats['maddeler_total'])} madde; {n(stats['maddeler_with_questions'])} maddede toplam
{n(stats['questions_total'])} sentetik vatandaş sorusu.

## Kullanım

```python
from datasets import load_dataset

mevzuat  = load_dataset("REPO_ID", "mevzuat", split="train")
kararlar = load_dataset("REPO_ID", "kararlar", split="train")
maddeler = load_dataset("REPO_ID", "maddeler", split="train")

# Embedding eğitimi için (soru, madde) çiftleri
pairs = [(q, r["doc_title"] + " — " + (r["ref"] or "") + "\\n" + r["text"])
         for r in maddeler for q in r["questions"]]
```

## Alanlar

**mevzuat** — `id` (API kimliği, ör. `yasa-1-1998`), `type` (`anayasa`/`yasa`/`tuzuk`), `subtype`, `title`,
`display_title`, `number`, `year`, `date`, `source` (`gov` resmî birleştirilmiş metin, `mahkemeler`),
`source_url`, `pdf_url`, `text_status` (`full`/`partial`/`metadata`), `consolidated_through`
(metnin içerdiği son değişiklik, ör. `25/2026`), `parent_law` (tüzüğün dayanak yasası), `categories`,
`duplicate_of` (aynı metnin başka kimlikteki kopyasıysa asıl kayıt), `chars`, `text`.

**kararlar** — `id`, `court`, `title`, `esas_no`, `karar_no`, `date`, `year`, `subject`, `summary`,
`cited_articles`, `source_url`, `pdf_url`, `chars`, `text`.

**maddeler** — `doc_id` (→ `mevzuat.id`), `doc_title`, `type`, `source`, `year`, `ord` (API'deki pasaj sırası),
`ref` (ör. `12`, `30A`), `kind` (`article`/`preamble`/`annex`/`paragraph`), `text`, `questions`.
Yalnızca API yanıtlarının alıntıladığı belgeler: değişiklik yasaları ve kopyalar hariç.
Sorular yalnızca madde metninden bir LLM ile üretilmiştir; insan tarafından doğrulanmamıştır.

## Lisans ve kaynak gösterme

Yasa, tüzük ve mahkeme kararları kamu belgesidir. Derleme, ayrıştırma ve sentetik sorular için
bu veri setine ve resmî kaynağa (`source_url`) atıf yapın. Kararların taraf bilgisi (`Taraflar`) bu veri
setine alınmamış, başlıklardan da çıkarılmıştır; karar metninin kendisi kaynakta yayımlandığı haliyle aktarılmıştır.
"""


def push(out_dir: Path, repo_id: str, private: bool = False, token: Optional[str] = None) -> str:
    from huggingface_hub import HfApi

    out_dir = Path(out_dir)
    if not (out_dir / "data" / "mevzuat.parquet").exists():
        raise SystemExit("Run `python -m kktc hf export` first.")
    card = (out_dir / "README.md").read_text(encoding="utf-8").replace("REPO_ID", repo_id)
    (out_dir / "README.md").write_text(card, encoding="utf-8")
    stats = json.loads((out_dir / "stats.json").read_text(encoding="utf-8"))
    api = HfApi(token=token)
    api.create_repo(repo_id=repo_id, repo_type="dataset", private=private, exist_ok=True)
    info = api.upload_folder(
        repo_id=repo_id,
        repo_type="dataset",
        folder_path=str(out_dir),
        allow_patterns=["README.md", "stats.json", "data/*.parquet"],
        commit_message=f"Haftalık güncelleme {stats.get('built_at', '')[:10]}".strip(),
    )
    return str(getattr(info, "commit_url", info))
