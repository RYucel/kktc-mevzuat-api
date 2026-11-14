"""Vector index sync for semantic search over legislation articles.

Units are built from the search database right after ``build`` (so chunk
ordinals match D1 exactly) and exported as ``vector-units.jsonl.gz``. The
vectors workflow then sends new units to the Worker's authenticated
``/admin/vectors/upsert`` endpoint, which embeds them with Workers AI and
writes them to Vectorize, and deletes units that no longer exist.

What has been sent is tracked in a manifest (``vectors.json``), kept next to
``history.db`` as a release asset. A unit's id is a hash of its text, so a
changed article gets a new vector and the old one is deleted.

Free-tier limits shape the design: Vectorize stores 5M dimensions (192-dim
vectors -> ~26k articles) and Workers AI gives 10,000 neurons a day (~9M input
tokens for Qwen3-Embedding). Each run therefore has a token budget and simply
continues on the next run.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import re
import sqlite3
import time
from pathlib import Path
from typing import Any, Callable, Optional

from .textproc import fold_tr

log = logging.getLogger(__name__)

MODEL = "@cf/qwen/qwen3-embedding-0.6b"
DIMS = 192
# Vectorize free tier: 5,000,000 stored dimensions. Keep 5% headroom.
MAX_VECTORS = int(5_000_000 / DIMS * 0.95)
MAX_UNIT_CHARS = 1800
LEGISLATION = ("anayasa", "yasa", "tuzuk")
_PART = re.compile(r"\s*\(\d+/\d+\)$")


def _unit_id(doc_id: str, ord_: int, text: str) -> str:
    return hashlib.sha1(f"{MODEL}|{DIMS}|{doc_id}|{ord_}|{text}".encode("utf-8")).hexdigest()


def estimate_tokens(text: str) -> int:
    # Qwen's tokenizer averages roughly 3 characters per token on Turkish.
    return max(1, len(text) // 3)


def title_key(title: str) -> str:
    """Same as titleKey() in packages/core/src/titles.ts."""
    folded = fold_tr(title or "")
    folded = re.sub(r"\([^)]*\)", " ", folded)
    folded = re.sub(r"[^\w\s]|\d|_", " ", folded)
    return " ".join(folded.split())


def is_amendment(title: str) -> bool:
    return "degisiklik" in fold_tr(title or "")


# Unit text formats. 1: "<title> — <ref>\n<article>". 2 (OPUS-GOREVLER-5
# item 5): the statute's readable name, a line of document context (what the
# statute regulates, from its card; a regulation's parent law), then the
# article. Neighbouring statutes (KDV / KDV İadesi, İş / Basın İş) share
# vocabulary; the context keeps an article tied to its statute.
CONTEXT_CHARS = 200
NEXT_DIMS = 128


def max_vectors(dims: int) -> int:
    return int(5_000_000 / dims * 0.95)


def build_units(db_path: Path, fmt: int = 1) -> list[dict[str, Any]]:
    """One unit per article (parts joined), preamble, or loose paragraph.

    ``ord`` is the D1 ordinal of the unit's first chunk; the Worker uses
    (doc_id, ord) to show the matching passage.
    """
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows_ = list(
        conn.execute(
            f"SELECT id, type, title, source, year, json_extract(extra_json, '$.duplicate_of') AS duplicate_of, "
            "json_extract(extra_json, '$.display_title') AS display, json_extract(extra_json, '$.card') AS card, "
            "json_extract(extra_json, '$.parent_law') AS parent "
            f"FROM documents WHERE type IN ({','.join('?' * len(LEGISLATION))}) "
            "AND text_status IN ('full', 'partial')",
            LEGISLATION,
        )
    )
    # Documents the answers never quote (packages/core/src/titles.ts) take no
    # vector space: amendment instruments and mahkemeler copies of statutes
    # we also hold consolidated from mevzuat.gov.ct.tr, and copies of the same
    # statute under another id (extra_json.duplicate_of, crawler/kktc/duplicates.py).
    official = {(r["type"], title_key(r["title"])) for r in rows_ if r["source"] == "gov"}
    docs = {
        row["id"]: row
        for row in rows_
        if not is_amendment(row["title"])
        and not row["duplicate_of"]
        and not (row["source"] != "gov" and (row["type"], title_key(row["title"])) in official)
    }
    names = {r["id"]: (r["display"] or r["title"]) for r in rows_}

    def context(doc: Any) -> str:
        parts = []
        card = re.sub(r"\s+", " ", doc["card"] or "").strip()
        if card:
            parts.append(card[:CONTEXT_CHARS].rsplit(" ", 1)[0] if len(card) > CONTEXT_CHARS else card)
        if doc["type"] == "tuzuk" and doc["parent"] and doc["parent"] in names:
            parts.append(f"Dayanak yasa: {names[doc['parent']]}")
        return " | ".join(parts)

    units: list[dict[str, Any]] = []
    current: Optional[dict[str, Any]] = None

    def close() -> None:
        nonlocal current
        if current:
            doc = docs[current["doc_id"]]
            if fmt == 2:
                name = doc["display"] or doc["title"]
                label = f"{name} — {current['ref']}" if current["ref"] else name
                ctx = context(doc)
                head = f"{label}\n{ctx}" if ctx else label
            else:
                head = f"{doc['title']} — {current['ref']}" if current["ref"] else doc["title"]
            text = f"{head}\n{' '.join(current['parts'])}"[:MAX_UNIT_CHARS].strip()
            units.append(
                {
                    "id": _unit_id(current["doc_id"], current["ord"], text),
                    "doc_id": current["doc_id"],
                    "ord": current["ord"],
                    "ref": current["ref"],
                    "type": doc["type"],
                    "source": doc["source"],
                    "year": doc["year"],
                    "text": text,
                }
            )
        current = None

    rows = conn.execute("SELECT doc_id, ord, kind, ref, text FROM chunks WHERE kind != 'title' ORDER BY doc_id, ord")
    for row in rows:
        if row["doc_id"] not in docs:
            continue
        ref = row["ref"] or None
        key = _PART.sub("", ref) if (row["kind"] == "article" and ref) else ref
        same = (
            current
            and current["doc_id"] == row["doc_id"]
            and key
            and current["ref"] == key
            and row["kind"] in ("article", "preamble")
        )
        if same:
            current["parts"].append(row["text"])
            continue
        close()
        current = {"doc_id": row["doc_id"], "ord": row["ord"], "ref": key, "parts": [row["text"]]}
    close()
    conn.close()
    return units


def prioritise(units: list[dict[str, Any]], limit: int = MAX_VECTORS) -> list[dict[str, Any]]:
    """Keep the index under the free-tier size: constitution, laws, then regulations."""
    if len(units) <= limit:
        return units
    rank = {"anayasa": 0, "yasa": 1, "tuzuk": 2}
    # Within a type: consolidated texts first, then the newest statutes (old
    # regulations are the most often replaced), then document order.
    ordered = sorted(
        units,
        key=lambda u: (rank.get(u["type"], 9), u["source"] != "gov", -(u.get("year") or 0), u["doc_id"], u["ord"]),
    )
    log.warning("vectors: %d units exceed the %d-vector budget; %d left out", len(units), limit, len(units) - limit)
    return ordered[:limit]


def export_units(db_path: Path, out_path: Path, fmt: int = 1, dims: int = DIMS) -> dict[str, Any]:
    units = prioritise(build_units(db_path, fmt), max_vectors(dims))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(out_path, "wt", encoding="utf-8") as handle:
        for unit in units:
            handle.write(json.dumps(unit, ensure_ascii=False) + "\n")
    stats = {
        "units": len(units),
        "chars": sum(len(u["text"]) for u in units),
        "est_tokens": sum(estimate_tokens(u["text"]) for u in units),
        "by_type": {t: sum(1 for u in units if u["type"] == t) for t in LEGISLATION},
        "format": fmt,
        "dims": dims,
    }
    log.info("vectors: exported %s", stats)
    return stats


def load_units(path: Path) -> list[dict[str, Any]]:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def load_manifest(path: Path, dims: int = DIMS) -> dict[str, Any]:
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("model") == MODEL and data.get("dims") == dims:
            return data
        log.warning("vectors: manifest is for %s/%s; starting over", data.get("model"), data.get("dims"))
        return {"model": MODEL, "dims": dims, "ids": {}, "stale_model_ids": list(data.get("ids", {}))}
    return {"model": MODEL, "dims": dims, "ids": {}}


def save_manifest(path: Path, manifest: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


# Estimated tokens per upsert request (Workers AI rejects large inputs).
BATCH_TOKENS = 8000


class BudgetExhausted(RuntimeError):
    pass


Post = Callable[[str, dict[str, Any]], dict[str, Any]]


def http_poster(base: str, token: str, timeout: float = 120.0) -> Post:
    import requests

    session = requests.Session()
    session.headers.update({"Authorization": f"Bearer {token}", "Content-Type": "application/json"})

    def post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
        last: Optional[str] = None
        for attempt in range(4):
            response = session.post(base.rstrip("/") + path, json=payload, timeout=timeout)
            if response.ok:
                return response.json()
            body = response.text[:500]
            # Workers AI daily allocation (free tier) or rate limit: stop for today.
            if response.status_code == 429 or re.search(r"neuron|quota|limit", body, re.I):
                raise BudgetExhausted(f"HTTP {response.status_code}: {body}")
            if response.status_code in (401, 403, 404, 501) or "too big" in body:
                raise RuntimeError(f"HTTP {response.status_code} on {path}: {body}")
            last = f"HTTP {response.status_code}: {body}"
            time.sleep(2 ** attempt)
        raise RuntimeError(f"{path} failed: {last}")

    return post


def sync(
    units: list[dict[str, Any]],
    manifest: dict[str, Any],
    post: Post,
    *,
    budget_tokens: int,
    batch_size: int = 32,
    save: Callable[[dict[str, Any]], None] = lambda manifest: None,
    index: str = "",
) -> dict[str, Any]:
    """Delete vectors that are gone, then embed new units within the budget."""
    # index="next": the second index (128 dimensions, format 2) under trial.
    query = f"?index={index}" if index else ""
    wanted = {u["id"]: u for u in units}
    have: dict[str, Any] = manifest.setdefault("ids", {})
    stale = [i for i in have if i not in wanted] + list(manifest.pop("stale_model_ids", []))
    deleted = 0
    for start in range(0, len(stale), 100):
        batch = stale[start : start + 100]
        post(f"/admin/vectors/delete{query}", {"ids": batch})
        for vector_id in batch:
            have.pop(vector_id, None)
        deleted += len(batch)
        save(manifest)

    todo = [u for u in units if u["id"] not in have]
    spent = 0
    upserted = 0
    stopped: Optional[str] = None
    payload = lambda batch: {"units": [{k: u[k] for k in ("id", "text", "doc_id", "ord", "ref", "type")} for u in batch]}

    def send(batch: list[dict[str, Any]]) -> None:
        # Workers AI rejects a request whose total input is too large
        # ("3030: input too big", 14 Nov 2026, after long articles changed);
        # split the batch and send the halves.
        try:
            post(f"/admin/vectors/upsert{query}", payload(batch))
        except RuntimeError as exc:
            if "too big" not in str(exc) or isinstance(exc, BudgetExhausted):
                raise
            if len(batch) == 1:
                log.warning("vectors: %s %s too big for one request; skipped", batch[0]["doc_id"], batch[0]["ref"])
                return
            half = len(batch) // 2
            send(batch[:half])
            send(batch[half:])

    # Batches of at most batch_size units and BATCH_TOKENS estimated tokens.
    batches: list[list[dict[str, Any]]] = []
    for unit in todo:
        cost = estimate_tokens(unit["text"])
        if not batches or len(batches[-1]) >= batch_size or sum(estimate_tokens(u["text"]) for u in batches[-1]) + cost > BATCH_TOKENS:
            batches.append([])
        batches[-1].append(unit)
    for n, batch in enumerate(batches):
        cost = sum(estimate_tokens(u["text"]) for u in batch)
        if spent + cost > budget_tokens:
            stopped = "budget"
            break
        try:
            send(batch)
        except BudgetExhausted as exc:
            stopped = f"workers-ai: {exc}"
            break
        spent += cost
        upserted += len(batch)
        for unit in batch:
            have[unit["id"]] = [unit["doc_id"], unit["ord"]]
        if n % 20 == 0:
            save(manifest)
    save(manifest)
    remaining = len([u for u in units if u["id"] not in have])
    summary = {
        "wanted": len(wanted),
        "indexed": len(have),
        "upserted": upserted,
        "deleted": deleted,
        "remaining": remaining,
        "est_tokens": spent,
        "stopped": stopped,
    }
    log.info("vectors: %s", summary)
    return summary


def admin_token(api_token: str) -> str:
    """Admin token for /admin/vectors/*, derived from the Cloudflare API token.

    Both workflows can compute it without an extra secret; it changes when the
    Cloudflare token is rotated, and the workflow re-sets it on the Worker.
    """
    return hashlib.sha256(f"{api_token}:kktc-vectors".encode("utf-8")).hexdigest()

