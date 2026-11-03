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


def build_units(db_path: Path) -> list[dict[str, Any]]:
    """One unit per article (parts joined), preamble, or loose paragraph.

    ``ord`` is the D1 ordinal of the unit's first chunk; the Worker uses
    (doc_id, ord) to show the matching passage.
    """
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    docs = {
        row["id"]: row
        for row in conn.execute(
            f"SELECT id, type, title, source FROM documents WHERE type IN ({','.join('?' * len(LEGISLATION))}) "
            "AND text_status IN ('full', 'partial')",
            LEGISLATION,
        )
    }
    units: list[dict[str, Any]] = []
    current: Optional[dict[str, Any]] = None

    def close() -> None:
        nonlocal current
        if current:
            doc = docs[current["doc_id"]]
            label = f"{doc['title']} — {current['ref']}" if current["ref"] else doc["title"]
            text = f"{label}\n{' '.join(current['parts'])}"[:MAX_UNIT_CHARS].strip()
            units.append(
                {
                    "id": _unit_id(current["doc_id"], current["ord"], text),
                    "doc_id": current["doc_id"],
                    "ord": current["ord"],
                    "ref": current["ref"],
                    "type": doc["type"],
                    "source": doc["source"],
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
    ordered = sorted(units, key=lambda u: (rank.get(u["type"], 9), u["source"] != "gov", u["doc_id"], u["ord"]))
    log.warning("vectors: %d units exceed the %d-vector budget; %d left out", len(units), limit, len(units) - limit)
    return ordered[:limit]


def export_units(db_path: Path, out_path: Path) -> dict[str, Any]:
    units = prioritise(build_units(db_path))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(out_path, "wt", encoding="utf-8") as handle:
        for unit in units:
            handle.write(json.dumps(unit, ensure_ascii=False) + "\n")
    stats = {
        "units": len(units),
        "chars": sum(len(u["text"]) for u in units),
        "est_tokens": sum(estimate_tokens(u["text"]) for u in units),
        "by_type": {t: sum(1 for u in units if u["type"] == t) for t in LEGISLATION},
    }
    log.info("vectors: exported %s", stats)
    return stats


def load_units(path: Path) -> list[dict[str, Any]]:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def load_manifest(path: Path) -> dict[str, Any]:
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("model") == MODEL and data.get("dims") == DIMS:
            return data
        log.warning("vectors: manifest is for %s/%s; starting over", data.get("model"), data.get("dims"))
        return {"model": MODEL, "dims": DIMS, "ids": {}, "stale_model_ids": list(data.get("ids", {}))}
    return {"model": MODEL, "dims": DIMS, "ids": {}}


def save_manifest(path: Path, manifest: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


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
            if response.status_code in (401, 403, 404, 501):
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
) -> dict[str, Any]:
    """Delete vectors that are gone, then embed new units within the budget."""
    wanted = {u["id"]: u for u in units}
    have: dict[str, Any] = manifest.setdefault("ids", {})
    stale = [i for i in have if i not in wanted] + list(manifest.pop("stale_model_ids", []))
    deleted = 0
    for start in range(0, len(stale), 500):
        batch = stale[start : start + 500]
        post("/admin/vectors/delete", {"ids": batch})
        for vector_id in batch:
            have.pop(vector_id, None)
        deleted += len(batch)
        save(manifest)

    todo = [u for u in units if u["id"] not in have]
    spent = 0
    upserted = 0
    stopped: Optional[str] = None
    for start in range(0, len(todo), batch_size):
        batch = todo[start : start + batch_size]
        cost = sum(estimate_tokens(u["text"]) for u in batch)
        if spent + cost > budget_tokens:
            stopped = "budget"
            break
        try:
            post(
                "/admin/vectors/upsert",
                {"units": [{k: u[k] for k in ("id", "text", "doc_id", "ord", "ref", "type")} for u in batch]},
            )
        except BudgetExhausted as exc:
            stopped = f"workers-ai: {exc}"
            break
        spent += cost
        upserted += len(batch)
        for unit in batch:
            have[unit["id"]] = [unit["doc_id"], unit["ord"]]
        if (start // batch_size) % 20 == 0:
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

